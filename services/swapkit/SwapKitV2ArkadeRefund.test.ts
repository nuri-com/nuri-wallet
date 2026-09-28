// The two v2 Arkade Intents refund executors, wired on top of the EXISTING v1
// refund machinery (no new derivation, no new crypto):
//   - arkade_refund_material: returns the x-only sender pubkey + a wallet-minted
//     opaque walletKeyRef, derived through the v1 key service.
//   - arkade_intents_refund: reuses refundArkadeIntentsLockup — it rebinds to a
//     swap THIS wallet funded and refuses a foreign rfqId / destination /
//     sender key, and a not-yet-mature refundLocktime is surfaced as blocked
//     (fail closed), never a spurious success.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "../../lib/bytes";

// ── Executor-module seams (mirror SwapKitV2Executors.test.ts) ────────
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn().mockResolvedValue("0xAbCd000000000000000000000000000000000001"),
}));
vi.mock("../arkade/ArkadeLightningSendService", () => ({ payArkadeLightningInvoice: vi.fn() }));
vi.mock("../arkade/ArkadeSendService", () => ({ sendArkadeToArk: vi.fn() }));
vi.mock("../arkade/ArkadeAddressService", () => ({ getArkadeReceiveAddress: vi.fn() }));
vi.mock("./SwapKitHtlcKeyService", () => ({ deriveSwapKitHtlcMaterial: vi.fn() }));
vi.mock("./SwapKitHtlcSecretService", () => ({ materializeSwapKitHtlcPreimage: vi.fn() }));
vi.mock("./SwapKitArkadeVhtlcService", () => ({ claimSwapKitArkadeVhtlc: vi.fn() }));
vi.mock("./SwapKitEvmSigner", () => ({ signAndBroadcastSwapKitEvmTx: vi.fn() }));
vi.mock("./SwapKitHtlcActionService", () => ({ executeSwapKitHtlcAction: vi.fn() }));

// ── Refund-core leaf deps (mirror the covenant test) ─────────────────
const SOLVER_PUBKEY = "11".repeat(32);
const SERVER_PUBKEY = "22".repeat(32);
const EMULATOR_PUBKEY = "33".repeat(32);
const SENDER_PUBKEY = "44".repeat(32);
const RECEIVER_PK_SCRIPT = "55".repeat(34);
const REFUND_PK_SCRIPT = "66".repeat(34);
const PAYMENT_HASH = "77".repeat(32);

const LOCKUP_ADDRESS = "ark1lockup";
const REFUND_ADDRESS = "ark1refund";

const FUNDED_PK_SCRIPT = "aa".repeat(34); // timelockedRefund shape
const UNRELATED_PK_SCRIPT = "cc".repeat(34);

const mocks = {
  lightningSendContract: vi.fn(),
  pushRefundWithoutReceiver: vi.fn(async (..._a: unknown[]) => ({
    arkTxid: "ark-tx-1",
    amount: 1000,
  })),
  findLockupVtxos: vi.fn(async (..._a: unknown[]) => [{ txid: "lockup-tx", vout: 0, value: 1000 }]),
  listArkadeLightningSends: vi.fn(),
};

vi.mock("./SwapKitService", () => ({
  isTerminal: () => false,
  trackSwapKitSwap: vi.fn(),
  submitSwapKitWalletAction: vi.fn(async () => undefined),
  parseSwapActionTx: vi.fn(),
}));
vi.mock("./SwapKitArkadeIntentsRefundJournal", () => ({
  loadJournal: vi.fn(async () => ({})),
  journalEntry: vi.fn(async () => undefined),
}));
vi.mock("../arkade/internal/browserApproval", () => ({
  withOutgoingBrowserApproval: (_request: unknown, run: () => unknown) => run(),
}));
vi.mock("../arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: vi.fn(async () => "intent-1"),
}));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  getArkadeLightningSendOwnerKey: vi.fn(async () => "owner-1"),
  listArkadeLightningSends: (owner: string) => mocks.listArkadeLightningSends(owner),
  deleteArkadeLightningSend: vi.fn(async () => undefined),
}));
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: vi.fn(async () => ({
    indexerProvider: { getVtxos: vi.fn() },
    arkProvider: { getInfo: vi.fn(), submitTx: vi.fn(), finalizeTx: vi.fn() },
    // Deterministic wallet-owned material used to reconstruct a wiped record.
    getAddress: vi.fn(async () => REFUND_ADDRESS),
  })),
}));
vi.mock("@arkade-os/sdk", () => ({
  ArkAddress: {
    decode: (address: string) => ({
      pkScript: hexToBytes(address === LOCKUP_ADDRESS ? FUNDED_PK_SCRIPT : REFUND_PK_SCRIPT),
    }),
  },
  contractSigner: vi.fn(async () => ({ sign: vi.fn() })),
  // Re-derived from the passkey-bound identity on a wiped wallet — same values
  // the funding path produced. Returns this wallet's own sender key.
  provisionRefundKey: vi.fn(async () => ({
    descriptor: "descriptor-1",
    pubkey: hexToBytes(SENDER_PUBKEY),
  })),
}));
vi.mock("@arkade-os/swap", () => ({
  lightningSendVtxoScript: (params: Record<string, unknown>) => mocks.lightningSendContract(params),
  findLockupVtxos: (...args: unknown[]) => mocks.findLockupVtxos(...args),
  pushRefundWithoutReceiver: (...args: unknown[]) => mocks.pushRefundWithoutReceiver(...args),
  readLockupFate: vi.fn(async () => ({ fate: "unknown" })),
}));

import { executeV2ArkadeIntentsRefund, executeV2ArkadeRefundMaterial } from "./SwapKitV2Executors";

const CTX = { orderId: "ord_1" as never, actionId: "act_1" };

const FUNDED_RECORD = {
  rfqId: "rfq-1",
  txId: "order-1",
  lockupAddress: LOCKUP_ADDRESS,
  refundAddress: REFUND_ADDRESS,
  senderPublicKey: SENDER_PUBKEY,
  senderDescriptor: "descriptor-1",
};

const lockupParams = (overrides: Record<string, unknown> = {}) => ({
  solverPubkey: SOLVER_PUBKEY,
  serverPubkey: SERVER_PUBKEY,
  emulatorPubkey: EMULATOR_PUBKEY,
  senderPubkey: SENDER_PUBKEY,
  receiverPkScript: RECEIVER_PK_SCRIPT,
  refundPkScript: REFUND_PK_SCRIPT,
  paymentHash: PAYMENT_HASH,
  claimDelay: 605184,
  refundLocktime: 1000, // matured — Date.now()/1000 is far larger
  ...overrides,
});

const refundRequest = (overrides: Record<string, unknown> = {}) => ({
  rfqId: "rfq-1",
  lockupAddress: LOCKUP_ADDRESS,
  destinationAddress: REFUND_ADDRESS,
  walletKeyRef: "nuri-htlc-v1:satora:5",
  fundingOutpoint: { txid: "ab".repeat(32), vout: 0 },
  amountSats: 1000,
  refundLocktime: 1000,
  lockupParams: lockupParams(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listArkadeLightningSends.mockResolvedValue([{ ...FUNDED_RECORD }]);
  mocks.pushRefundWithoutReceiver.mockResolvedValue({ arkTxid: "ark-tx-1", amount: 1000 });
  mocks.findLockupVtxos.mockResolvedValue([{ txid: "lockup-tx", vout: 0, value: 1000 }]);
  // The builder stands in for the SDK covenant derivation: the current shape
  // (legacy undefined) rebuilds to the FUNDED script, the legacy shape to an
  // unrelated one.
  mocks.lightningSendContract.mockImplementation((params: Record<string, unknown>) => ({
    pkScript: hexToBytes(params.legacy === undefined ? FUNDED_PK_SCRIPT : UNRELATED_PK_SCRIPT),
    options: {},
  }));
});

describe("executeV2ArkadeRefundMaterial", () => {
  it("returns the Arkade refund key's x-only pubkey + a wallet-minted Arkade keyRef", async () => {
    const result = await executeV2ArkadeRefundMaterial({ scope: "rfq-1" }, CTX);
    // The sender key is the SAME Arkade key the refund signs with
    // (provisionRefundKey), NOT the EVM satora HTLC scalar — otherwise a
    // v2-funded covenant would be unrefundable (Taner/Codex P1).
    expect(result.senderPublicKey).toBe(SENDER_PUBKEY);
    expect(result.senderPublicKey).toMatch(/^[0-9a-fA-F]{64}$/);
    // Opaque, Arkade-scoped wallet-owned ref (provenance only; the refund
    // resolves the signer from the wallet, never from the ref).
    expect(result.walletKeyRef).toBe("nuri-arkade-intents-v1:rfq-1");
  });
});

describe("executeV2ArkadeIntentsRefund", () => {
  it("rebinds to a funded record and signs the refund, returning the ark txid", async () => {
    const result = await executeV2ArkadeIntentsRefund(refundRequest(), CTX);
    expect(result.arkTxid).toBe("ark-tx-1");
    expect(mocks.pushRefundWithoutReceiver).toHaveBeenCalledTimes(1);
  });

  it("recovers after a full wipe: reconstructs the funded record from wallet material and signs", async () => {
    // No local record at all — the app-data wipe cleared the send store.
    mocks.listArkadeLightningSends.mockResolvedValue([]);
    const result = await executeV2ArkadeIntentsRefund(refundRequest(), CTX);
    // Reconstructed sender/descriptor/address from wallet-owned material let the
    // covenant rebuild to the funded lockup, so the refund still signs.
    expect(result.arkTxid).toBe("ark-tx-1");
    expect(mocks.pushRefundWithoutReceiver).toHaveBeenCalledTimes(1);
  });

  it("refuses when the reconstructed covenant does not rebuild to the funded lockup", async () => {
    // Wiped wallet, and NEITHER covenant shape rebuilds to the funded pkScript:
    // the wallet cannot prove it controls this lockup, so it must not sign.
    mocks.listArkadeLightningSends.mockResolvedValue([]);
    mocks.lightningSendContract.mockImplementation(() => ({
      pkScript: hexToBytes(UNRELATED_PK_SCRIPT),
      options: {},
    }));
    await expect(executeV2ArkadeIntentsRefund(refundRequest(), CTX)).rejects.toThrow(
      /covenant does not rebuild/,
    );
    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
  });

  it("refuses a substituted destination address", async () => {
    await expect(
      executeV2ArkadeIntentsRefund(refundRequest({ destinationAddress: "ark1somebodyelse" }), CTX),
    ).rejects.toThrow(/destination does not match/);
    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
  });

  it("refuses a lockupParams sender key that is not this wallet's", async () => {
    await expect(
      executeV2ArkadeIntentsRefund(
        refundRequest({ lockupParams: lockupParams({ senderPubkey: "99".repeat(32) }) }),
        CTX,
      ),
    ).rejects.toThrow(/another wallet's sender key/);
    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
  });

  it("refuses a foreign walletKeyRef this wallet never minted", async () => {
    await expect(
      executeV2ArkadeIntentsRefund(refundRequest({ walletKeyRef: "someone-elses-ref:1" }), CTX),
    ).rejects.toThrow(/was not minted by this wallet/);
    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
  });

  it("blocks (fail closed) a refund whose locktime has not yet matured", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    await expect(
      executeV2ArkadeIntentsRefund(
        refundRequest({
          refundLocktime: future,
          lockupParams: lockupParams({ refundLocktime: future }),
        }),
        CTX,
      ),
    ).rejects.toThrow(/blocked until locktime/);
    // Never signs or pushes a spend the covenant leaf cannot yet confirm.
    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
  });
});
