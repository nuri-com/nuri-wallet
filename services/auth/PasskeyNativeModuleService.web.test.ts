import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWalletPasskey,
  createWalletPasskeyCredential,
  getWalletPasskeyPrfAssertion,
} from "./PasskeyNativeModuleService.web";

afterEach(() => vi.unstubAllGlobals());

function credential(prf?: Uint8Array): PublicKeyCredential {
  const response = {
    clientDataJSON: Uint8Array.from([4]).buffer,
    authenticatorData: Uint8Array.from([5]).buffer,
    signature: Uint8Array.from([6]).buffer,
    getPublicKey: () => Uint8Array.from([7, 8]).buffer,
  };
  return {
    authenticatorAttachment: null,
    id: "AQID",
    rawId: Uint8Array.from([1, 2, 3]).buffer,
    response,
    type: "public-key",
    getClientExtensionResults: () =>
      prf ? { prf: { results: { first: Uint8Array.from(prf).buffer } } } : { prf: {} },
    toJSON: () => {
      throw new Error("not used");
    },
  };
}

describe("browser passkey bootstrap", () => {
  it("creates the credential with the username label before any assertion", async () => {
    const create = vi.fn().mockResolvedValue(credential());
    const get = vi.fn();
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { credentials: { create, get } });

    const result = await createWalletPasskeyCredential("nuri.com", "salt", "@emino");

    expect(result.credIdB64u).toBe("AQID");
    expect(create.mock.calls[0][0].publicKey.user).toMatchObject({
      name: "@emino",
      displayName: "@emino",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("uses the create-time PRF instead of a second ceremony", async () => {
    const create = vi.fn().mockResolvedValue(credential(Uint8Array.from([9, 9, 9])));
    const get = vi.fn();
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { credentials: { create, get } });

    const result = await createWalletPasskey("nuri.com", "salt", "@emino");

    // Android Chrome never settles a get() with a non-empty allowCredentials,
    // so the create path must not fire one when create() already gave us PRF.
    expect(get).not.toHaveBeenCalled();
    expect(result.prfB64).toBe(btoa("\u0009\u0009\u0009"));
    expect(result.isNew).toBe(true);
  });

  it("falls back to an assertion when create() omits PRF", async () => {
    const create = vi.fn().mockResolvedValue(credential());
    const get = vi.fn().mockResolvedValue(credential(Uint8Array.from([7, 7])));
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { credentials: { create, get } });

    const result = await createWalletPasskey("nuri.com", "salt", "@emino");

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.prfB64).toBe(btoa("\u0007\u0007"));
  });

  it("names the credential so no chooser appears", async () => {
    const get = vi.fn().mockResolvedValue(credential(Uint8Array.from([5])));
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone)", credentials: { get } });

    await getWalletPasskeyPrfAssertion({
      rpId: "nuri.com",
      challengeB64u: "AQID",
      credIdB64u: "AQID",
      prfSalt: "salt",
    });

    expect(get.mock.calls[0][0].publicKey.allowCredentials).toHaveLength(1);
  });

  it("asks for a discoverable credential on Android, where naming one hangs", async () => {
    const get = vi.fn().mockResolvedValue(credential(Uint8Array.from([5])));
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; SM-G991B) Chrome/153",
      credentials: { get },
    });

    await getWalletPasskeyPrfAssertion({
      rpId: "nuri.com",
      challengeB64u: "AQID",
      credIdB64u: "AQID",
      prfSalt: "salt",
    });

    expect(get.mock.calls[0][0].publicKey.allowCredentials).toEqual([]);
  });

  it("rejects an assertion from a different credential than the one asked for", async () => {
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      credentials: { get: vi.fn().mockResolvedValue(credential(Uint8Array.from([5]))) },
    });

    await expect(
      getWalletPasskeyPrfAssertion({
        rpId: "nuri.com",
        challengeB64u: "AQID",
        credIdB64u: "ZZZZ",
        prfSalt: "salt",
      }),
    ).rejects.toThrow("assertion_credential_mismatch");
  });

  it("rejects the combined server assertion when the provider omits PRF", async () => {
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", {
      credentials: { get: vi.fn().mockResolvedValue(credential()) },
    });

    await expect(
      getWalletPasskeyPrfAssertion({
        rpId: "nuri.com",
        challengeB64u: "AQID",
        credIdB64u: "AQID",
        prfSalt: "salt",
      }),
    ).rejects.toThrow("missing_assertion_prf");
  });
});
