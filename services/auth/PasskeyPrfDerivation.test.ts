/**
 * MISSION CRITICAL — DO NOT SKIP, DO NOT DELETE, DO NOT LOOSEN.
 *
 * Every Nuri key is derived from one WebAuthn PRF value: bitcoin key, ethereum
 * key, nostr identity, arkade client signer. The PRF is a pure function of
 * (credential, rpId, salt). Change any of those three and every existing user
 * derives a DIFFERENT wallet on their next sign-in — their funds are still on
 * chain but the app can no longer reach them, and there is no recovery path
 * because the old PRF is not reproducible once the inputs moved.
 *
 * So this file pins the inputs and the pass-through. A failure here is never
 * "update the expected value" — it means the change under review would strand
 * existing wallets and must not ship.
 *
 * Measured invariant this protects (Android 15 / Chrome 153, passkey.nuri.com,
 * credential q8Ae7wF4-oRpJg0LKNABqg, salt nuri-prf-salt-v1, rpId nuri.com):
 *
 *   create()  → 4yP23r…<redacted>
 *   get() #1  → 4yP23r…<redacted>
 *   get() #2  → 4yP23r…<redacted>
 *
 * The create-time value and the assertion value are byte-identical, which is
 * what lets createWalletPasskey skip the second ceremony. Re-run that check on
 * a real device whenever this area is touched — see docs/passkey-prf.md.
 */
import { describe, expect, it, vi } from "vitest";
import { PRF_SALT } from "../../config/constants";
import { WALLET_RP_ID } from "../../config/passkey";
import {
  createWalletPasskey,
  getWalletPasskeyPrfAssertion,
} from "./PasskeyNativeModuleService.web";

const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));

function credentialWithPrf(prf: number[]): PublicKeyCredential {
  return {
    authenticatorAttachment: null,
    id: "AQID",
    rawId: Uint8Array.from([1, 2, 3]).buffer,
    response: {
      clientDataJSON: Uint8Array.from([4]).buffer,
      authenticatorData: Uint8Array.from([5]).buffer,
      signature: Uint8Array.from([6]).buffer,
      getPublicKey: () => Uint8Array.from([7, 8]).buffer,
    },
    type: "public-key",
    getClientExtensionResults: () => ({
      prf: { results: { first: Uint8Array.from(prf).buffer } },
    }),
    toJSON: () => {
      throw new Error("not used");
    },
  } as unknown as PublicKeyCredential;
}

describe("PRF derivation inputs — MISSION CRITICAL", () => {
  it("pins the salt and RP ID that every wallet is derived from", () => {
    // Changing either literal re-derives every existing user's wallet.
    expect(PRF_SALT).toBe("nuri-prf-salt-v1");
    expect(WALLET_RP_ID).toBe("nuri.com");
  });

  it("evaluates the same salt on create() and on get()", async () => {
    const create = vi.fn().mockResolvedValue(credentialWithPrf([1]));
    const get = vi.fn().mockResolvedValue(credentialWithPrf([1]));
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { userAgent: "node", credentials: { create, get } });

    await createWalletPasskey(WALLET_RP_ID, PRF_SALT, "@someone");
    await getWalletPasskeyPrfAssertion({
      rpId: WALLET_RP_ID,
      challengeB64u: "AQID",
      credIdB64u: "AQID",
      prfSalt: PRF_SALT,
    });

    const createdSalt = create.mock.calls[0][0].publicKey.extensions.prf.eval.first;
    const assertedSalt = get.mock.calls[0][0].publicKey.extensions.prf.eval.first;
    expect(Array.from(createdSalt)).toEqual(utf8(PRF_SALT));
    expect(Array.from(assertedSalt)).toEqual(utf8(PRF_SALT));
    expect(create.mock.calls[0][0].publicKey.rp.id).toBe(WALLET_RP_ID);
    expect(get.mock.calls[0][0].publicKey.rpId).toBe(WALLET_RP_ID);
  });

  it("hands the authenticator's PRF bytes through untouched on both paths", async () => {
    // 32 bytes spanning the full range — catches truncation, sign errors and
    // any base64/base64url mix-up on the way to key derivation.
    const bytes = Array.from({ length: 32 }, (_, i) => (i * 8 + 3) % 256);
    const expected = btoa(String.fromCharCode(...bytes));

    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", {
      userAgent: "node",
      credentials: {
        create: vi.fn().mockResolvedValue(credentialWithPrf(bytes)),
        get: vi.fn().mockResolvedValue(credentialWithPrf(bytes)),
      },
    });

    const created = await createWalletPasskey(WALLET_RP_ID, PRF_SALT, "@someone");
    const asserted = await getWalletPasskeyPrfAssertion({
      rpId: WALLET_RP_ID,
      challengeB64u: "AQID",
      credIdB64u: "AQID",
      prfSalt: PRF_SALT,
    });

    expect(created.prfB64).toBe(expected);
    // The device proof above says these two are the same value. If the code
    // ever encoded them differently, signup and sign-in would derive different
    // wallets for the same passkey.
    expect(asserted.prfB64).toBe(created.prfB64);
  });
});
