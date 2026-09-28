import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes, sha256, utf8ToBytes } from "../../lib/crypto";

const cache = new Map<string, unknown>();
const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getSwapKitHtlcRoot: vi.fn(),
  getPrivateKey: vi.fn(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  submitSwapKitWalletAction: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getSwapKitHtlcRoot: mocks.getSwapKitHtlcRoot,
  getPrivateKey: mocks.getPrivateKey,
  // Keychain-backed HTLC key state, shared with the same in-memory map the
  // legacy cache mock uses so restart tests keep exercising persistence.
  getSwapKitHtlcKeyState: vi.fn(async () => (cache.get("keychain") as string) ?? null),
  storeSwapKitHtlcKeyState: vi.fn(async (json: string) => {
    cache.set("keychain", json);
  }),
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
vi.mock("./SwapKitService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitService")>()),
  submitSwapKitWalletAction: mocks.submitSwapKitWalletAction,
}));

const PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const EOA = privateKeyToAccount(PRIVATE_KEY).address;

// Independent re-implementation of the server's fingerprint (sorted keys,
// bigints as hex quantities) so the port is tested against the spec, not
// against itself.
function serverFingerprint(kind: string, request: unknown): string {
  const canon = (value: unknown): unknown => {
    if (typeof value === "bigint") return `0x${value.toString(16)}`;
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canon({ kind, request })))));
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  vi.resetModules();
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  mocks.getPrivateKey.mockImplementation(async () => hexToBytes(PRIVATE_KEY.slice(2)));
  mocks.getSwapKitHtlcRoot.mockImplementation(async (provider: string) =>
    sha256(utf8ToBytes(`test-root-${provider}`)),
  );
  mocks.getCacheValue.mockImplementation(async (key: string) => cache.get(key) ?? null);
  mocks.setCacheValue.mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  });
  mocks.submitSwapKitWalletAction.mockResolvedValue({ ok: true });
});

async function services() {
  const actionService = await import("./SwapKitHtlcActionService");
  const keyService = await import("./SwapKitHtlcKeyService");
  const secretService = await import("./SwapKitHtlcSecretService");
  return { ...actionService, ...keyService, ...secretService };
}

// Build a v2 action the way the server does (interactive-evm-signer.mjs).
async function signMessageAction(overrides: Record<string, unknown> = {}) {
  const { deriveSwapKitHtlcMaterial } = await services();
  const material = await deriveSwapKitHtlcMaterial("satora", "derive-1");
  const request = { kind: "sign_message", raw: "0xdeadbeef" };
  return {
    action: {
      version: 2,
      actionId: "wa_sign-1",
      type: "htlc_signing_v2",
      capability: "htlc_signing_v2",
      requestEncoding: "eip712-canonical-v1",
      provider: "satora",
      operation: "redeem",
      externalId: "ext-1",
      keyRef: {
        provider: "satora",
        keyIndex: material.keyIndex,
        preimageHash: material.preimageHash,
      },
      request,
      requestFingerprint: serverFingerprint("sign_message", { raw: "0xdeadbeef" }),
      needsPreimage: false,
      ...overrides,
    },
    material,
  };
}

describe("validateSwapKitHtlcAction", () => {
  it("accepts a well-formed action and rejects each broken binding", async () => {
    const { validateSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    await expect(validateSwapKitHtlcAction(action, { eoa: EOA })).resolves.toMatchObject({
      actionId: "wa_sign-1",
      kind: "sign_message",
    });

    // Phase B: a keyRef.preimageHash the wallet cannot reproduce is the
    // server-owned preimage mode and passes for plain signing actions.
    await expect(
      validateSwapKitHtlcAction(
        { ...action, keyRef: { ...action.keyRef, preimageHash: `0x${"ab".repeat(32)}` } },
        { eoa: EOA },
      ),
    ).resolves.toMatchObject({ actionId: "wa_sign-1" });

    for (const broken of [
      { ...action, version: 1 },
      { ...action, capability: "htlc_signing" },
      { ...action, requestEncoding: "something-else" },
      // The retired provider namespace is refused.
      { ...action, keyRef: { ...action.keyRef, provider: "boltz" } },
      // A preimageHash the wallet cannot reproduce is the Phase B server-owned
      // mode and is ACCEPTED for plain signing — but never for an action that
      // would reveal the (then wrong) local preimage.
      {
        ...action,
        keyRef: { ...action.keyRef, preimageHash: `0x${"ab".repeat(32)}` },
        needsPreimage: true,
      },
      { ...action, request: { ...action.request, extra: 1 } },
      // account is allowed but must be OUR EOA
      {
        ...action,
        request: { ...action.request, account: "0x3333333333333333333333333333333333333333" },
        requestFingerprint: serverFingerprint("sign_message", {
          raw: "0xdeadbeef",
          account: "0x3333333333333333333333333333333333333333",
        }),
      },
      { ...action, requestFingerprint: `${"0".repeat(64)}` },
      {
        ...action,
        request: { kind: "steal_funds" },
        requestFingerprint: undefined as string | undefined,
      },
    ]) {
      await expect(validateSwapKitHtlcAction(broken, { eoa: EOA })).rejects.toThrow(/rejected/);
    }
  });

  it("accepts a request that names our EOA as account", async () => {
    const { validateSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    const request = { kind: "sign_message", raw: "0xdeadbeef", account: EOA, chain: null as null };
    await expect(
      validateSwapKitHtlcAction(
        {
          ...action,
          request,
          requestFingerprint: serverFingerprint("sign_message", {
            raw: "0xdeadbeef",
            account: EOA,
            chain: null,
          }),
        },
        { eoa: EOA },
      ),
    ).resolves.toMatchObject({ kind: "sign_message" });

    // a non-null chain must be a supported one
    await expect(
      validateSwapKitHtlcAction(
        {
          ...action,
          request: { kind: "sign_message", raw: "0xdeadbeef", chain: { id: 1 } },
          requestFingerprint: serverFingerprint("sign_message", {
            raw: "0xdeadbeef",
            chain: { id: 1 },
          }),
        },
        { eoa: EOA },
      ),
    ).rejects.toThrow(/chain is not supported/);
  });

  it("rejects unsupported chains and foreign signers", async () => {
    const { validateSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    const txRequest = {
      kind: "send_transaction",
      chainId: 1, // mainnet is NOT allowed
      to: "0x2222222222222222222222222222222222222222",
      data: "0x00",
    };
    const tx = {
      ...action,
      request: txRequest,
      requestFingerprint: serverFingerprint("send_transaction", {
        chainId: 1,
        to: txRequest.to,
        data: "0x00",
      }),
    };
    await expect(validateSwapKitHtlcAction(tx, { eoa: EOA })).rejects.toThrow(/chain/);

    const foreign = {
      kind: "send_transaction",
      chainId: 8453,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x00",
      from: "0x3333333333333333333333333333333333333333",
    };
    const tx2 = {
      ...action,
      request: foreign,
      requestFingerprint: serverFingerprint("send_transaction", {
        chainId: 8453,
        to: foreign.to,
        data: "0x00",
        from: foreign.from,
      }),
    };
    await expect(validateSwapKitHtlcAction(tx2, { eoa: EOA })).rejects.toThrow(/foreign signer/);
  });

  it("binds derive_material to the active EOA", async () => {
    const { validateSwapKitHtlcAction } = await services();
    const derive = {
      version: 2,
      actionId: "wa_derive-1",
      type: "htlc_signing_v2",
      capability: "htlc_signing_v2",
      provider: "satora",
      operation: "derive_material",
      request: { fromAddress: "0x3333333333333333333333333333333333333333" },
    };
    await expect(validateSwapKitHtlcAction(derive, { eoa: EOA })).rejects.toThrow(/EOA/);
  });
});

describe("executeSwapKitHtlcAction", () => {
  it("signs a message with the EOA and journals the result idempotently", async () => {
    const { validateSwapKitHtlcAction, executeSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    const validated = await validateSwapKitHtlcAction(action, { eoa: EOA });

    const first = (await executeSwapKitHtlcAction(validated)) as { signature: `0x${string}` };
    const recovered = await recoverMessageAddress({
      message: { raw: "0xdeadbeef" },
      signature: first.signature,
    });
    expect(recovered).toBe(EOA);

    const keyLoads = mocks.getPrivateKey.mock.calls.length;
    const replay = await executeSwapKitHtlcAction(validated);
    expect(replay).toEqual(first);
    // Replay came from the journal — the key was never loaded again.
    expect(mocks.getPrivateKey.mock.calls.length).toBe(keyLoads);
  });

  it("signs exact typed data verifiable against the EOA", async () => {
    const { validateSwapKitHtlcAction, executeSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    const typedData = {
      domain: { name: "Test", version: "1", chainId: 42161 },
      types: { Claim: [{ name: "amount", type: "uint256" }] },
      primaryType: "Claim",
      message: { amount: "0xff" },
    };
    const request = { kind: "sign_typed_data", ...typedData };
    const validated = await validateSwapKitHtlcAction(
      {
        ...action,
        request,
        requestFingerprint: serverFingerprint("sign_typed_data", typedData),
      },
      { eoa: EOA },
    );
    const { signature } = (await executeSwapKitHtlcAction(validated)) as {
      signature: `0x${string}`;
    };
    const recovered = await recoverTypedDataAddress({
      ...(typedData as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
      signature,
    });
    expect(recovered).toBe(EOA);
  });

  it("materializes $htlcPreimage markers only in RAM and signs the real bytes", async () => {
    const { validateSwapKitHtlcAction, executeSwapKitHtlcAction, materializeSwapKitHtlcPreimage } =
      await services();
    const { action, material } = await signMessageAction();
    const preimage = await materializeSwapKitHtlcPreimage("satora", material.keyIndex);
    const preimageHex = bytesToHex(preimage);
    const redactedRaw = "0x1111$htlcPreimageHex2222";
    const request = { kind: "sign_message", raw: redactedRaw };
    const validated = await validateSwapKitHtlcAction(
      {
        ...action,
        request,
        requestFingerprint: serverFingerprint("sign_message", { raw: redactedRaw }),
        needsPreimage: true,
      },
      { eoa: EOA },
    );
    const { signature } = (await executeSwapKitHtlcAction(validated)) as {
      signature: `0x${string}`;
    };
    const recovered = await recoverMessageAddress({
      message: { raw: `0x1111${preimageHex}2222` as `0x${string}` },
      signature,
    });
    expect(recovered).toBe(EOA);
  });

  it("produces a recoverable EIP-7702 authorization tuple", async () => {
    const { validateSwapKitHtlcAction, executeSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    const authRequest = {
      kind: "sign_authorization",
      address: "0x2222222222222222222222222222222222222222",
      chainId: 8453,
      nonce: 7,
    };
    const validated = await validateSwapKitHtlcAction(
      {
        ...action,
        request: authRequest,
        requestFingerprint: serverFingerprint("sign_authorization", {
          address: authRequest.address,
          chainId: 8453,
          nonce: 7,
        }),
      },
      { eoa: EOA },
    );
    const { authorization } = (await executeSwapKitHtlcAction(validated)) as {
      authorization: Record<string, unknown>;
    };
    const { recoverAuthorizationAddress } = await import("viem/utils");
    const recovered = await recoverAuthorizationAddress({
      authorization: {
        address: authorization.address as `0x${string}`,
        chainId: authorization.chainId as number,
        nonce: authorization.nonce as number,
        r: authorization.r as `0x${string}`,
        s: authorization.s as `0x${string}`,
        yParity: authorization.yParity as number,
      },
    });
    expect(recovered).toBe(EOA);
  });
});

describe("handleSwapKitHtlcAction", () => {
  it("derive_material submits only the public material", async () => {
    const { handleSwapKitHtlcAction } = await services();
    await handleSwapKitHtlcAction(
      {
        version: 2,
        actionId: "wa_derive-9",
        type: "htlc_signing_v2",
        capability: "htlc_signing_v2",
        provider: "satora",
        operation: "derive_material",
        externalId: "ext-9",
        request: { fromAddress: EOA },
      },
      { txId: "sk_test" },
    );
    expect(mocks.submitSwapKitWalletAction).toHaveBeenCalledTimes(1);
    const submitted = mocks.submitSwapKitWalletAction.mock.calls[0][0];
    expect(submitted.txId).toBe("sk_test");
    expect(submitted.provider).toBe("satora");
    expect(Object.keys(submitted.material).sort()).toEqual([
      "evmAddress",
      "keyIndex",
      "preimageHash",
      "publicKey",
      "userId",
    ]);
    expect(JSON.stringify(submitted)).not.toMatch(/preimage"|mnemonic|privateKey/);
  });

  it("submits the public signature for a signing action", async () => {
    const { handleSwapKitHtlcAction } = await services();
    const { action } = await signMessageAction();
    await handleSwapKitHtlcAction(action, { txId: "sk_test" });
    const submitted = mocks.submitSwapKitWalletAction.mock.calls.at(-1)?.[0];
    expect(Object.keys(submitted.result)).toEqual(["signature"]);
    expect(submitted.actionId).toBe("wa_sign-1");
  });
});
