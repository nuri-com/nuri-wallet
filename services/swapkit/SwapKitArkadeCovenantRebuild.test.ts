import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "../../lib/bytes";

// Server #346 made the funding action carry the covenant's public parameters.
// This is the wallet half: prove the address we are about to fund is THIS
// order's covenant, instead of paying whatever address the server names.
//
// Before it, the wallet bounded the AMOUNT by the user's accepted deposit and
// then sent to wherever it was told. The gate reuses the refund path's own
// rebuild — one function, so the two cannot drift. Server #338 drifted by a
// single omitted field and refused every real Arkade payment on 2026-09-24.
const LOCKUP_ADDRESS = "ark1qlockup";
const ATTACKER_ADDRESS = "ark1qattacker";
const LOCKUP_PK_SCRIPT = `5120${"aa".repeat(32)}`;
const ATTACKER_PK_SCRIPT = `5120${"bb".repeat(32)}`;
const REFUND_PK_SCRIPT = `5120${"cc".repeat(32)}`;

const mocks = vi.hoisted(() => ({
  fund: vi.fn(),
  // The covenant builder: returns the lockup's script for the real parameters,
  // and something else for any altered set.
  contractFor: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: vi.fn() }));
vi.mock("../arkade/ArkadeLightningSendService", () => ({ payArkadeLightningInvoice: vi.fn() }));
vi.mock("../arkade/ArkadeSendService", () => ({
  sendArkadeToArk: vi.fn(),
  fundArkadeIntentsOutpoint: (...args: unknown[]) => mocks.fund(...args),
}));
vi.mock("../arkade/ArkadeAddressService", () => ({ getArkadeReceiveAddress: vi.fn() }));
vi.mock("./SwapKitHtlcKeyService", () => ({ deriveSwapKitHtlcMaterial: vi.fn() }));
vi.mock("./SwapKitHtlcSecretService", () => ({ materializeSwapKitHtlcPreimage: vi.fn() }));
vi.mock("./SwapKitArkadeVhtlcService", () => ({ claimSwapKitArkadeVhtlc: vi.fn() }));
vi.mock("./SwapKitEvmSigner", () => ({ signAndBroadcastSwapKitEvmTx: vi.fn() }));
vi.mock("./SwapKitHtlcActionService", () => ({ executeSwapKitHtlcAction: vi.fn() }));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("./SwapKitService", () => ({
  isTerminal: () => false,
  trackSwapKitSwap: vi.fn(),
  submitSwapKitWalletAction: vi.fn(),
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
  createArkadeServerSwapIntent: vi.fn(),
}));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  getArkadeLightningSendOwnerKey: vi.fn(),
  listArkadeLightningSends: vi.fn(),
  deleteArkadeLightningSend: vi.fn(),
}));
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: vi.fn(),
}));
vi.mock("@arkade-os/sdk", () => ({
  ArkAddress: {
    decode: (address: string) => {
      if (address === LOCKUP_ADDRESS) return { pkScript: hexToBytes(LOCKUP_PK_SCRIPT) };
      if (address === ATTACKER_ADDRESS) return { pkScript: hexToBytes(ATTACKER_PK_SCRIPT) };
      throw new Error("not an arkade address");
    },
  },
  contractSigner: vi.fn(),
  provisionRefundKey: vi.fn(),
}));
vi.mock("@arkade-os/swap", () => ({
  lightningSendVtxoScript: (params: Record<string, unknown>) => mocks.contractFor(params),
  findLockupVtxos: vi.fn(),
  pushRefundWithoutReceiver: vi.fn(),
  readLockupFate: vi.fn(),
}));

import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { executeV2ArkadeIntentsFund } from "./SwapKitV2Executors";

const LOCKUP_PARAMS = {
  solverPubkey: "11".repeat(32),
  serverPubkey: "22".repeat(32),
  emulatorPubkey: "33".repeat(32),
  senderPubkey: "44".repeat(32),
  receiverPkScript: `5120${"55".repeat(32)}`,
  refundPkScript: REFUND_PK_SCRIPT,
  paymentHash: "66".repeat(32),
  claimDelay: 605_184,
  refundLocktime: 1_791_552_229,
};

const covenantRequest = (overrides: Record<string, unknown> = {}) => ({
  to: LOCKUP_ADDRESS,
  amountSats: 10_000,
  asset: "BTC_ARKADE",
  rfqId: "rfq_1",
  destinationAddress: "ark1qrefund",
  refundLocktime: LOCKUP_PARAMS.refundLocktime,
  lockupParams: LOCKUP_PARAMS,
  ...overrides,
});

const ctx = { orderId: "ord_1", actionId: "act_1", markStarted: vi.fn() } as never;

beforeEach(async () => {
  mocks.fund.mockReset();
  mocks.fund.mockResolvedValue({
    arkTxid: "ab".repeat(32),
    outpoint: { txid: "ab".repeat(32), vout: 0 },
  });
  mocks.contractFor.mockReset();
  // The genuine parameters build the lockup; anything altered builds elsewhere.
  mocks.contractFor.mockImplementation((params: Record<string, unknown>) => {
    const genuine =
      params.claimDelay === LOCKUP_PARAMS.claimDelay &&
      params.refundLocktime === LOCKUP_PARAMS.refundLocktime &&
      params.paymentHash === LOCKUP_PARAMS.paymentHash;
    return { pkScript: hexToBytes(genuine ? LOCKUP_PK_SCRIPT : ATTACKER_PK_SCRIPT) };
  });
  SwapKitV2OrderStore._resetForTests();
  await SwapKitV2OrderStore.upsert({
    orderId: "ord_1",
    owner: "0xowner",
    from: "BTC_ARKADE",
    to: "EURC_BASE",
    amount: "0.0001",
    side: "deposit",
    settleTarget: "0xowner",
    idempotencyKey: "idem",
    status: "PROCESSING",
    flow: "arkade_lightning",
    acceptedDeposit: "20000",
    acceptedDepositAmount: "0.0002",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});

describe("the funding destination must be this order's own covenant", () => {
  it("funds when the covenant rebuilds to the named address", async () => {
    await executeV2ArkadeIntentsFund(covenantRequest(), ctx);
    expect(mocks.fund).toHaveBeenCalledWith(
      expect.objectContaining({ lockupAddress: LOCKUP_ADDRESS, amountSats: 10_000 }),
    );
  });

  it("REFUSES an address the covenant does not build", async () => {
    // The whole point: a syntactically valid ark1 address this covenant did not
    // produce must not be funded, however well-formed the request looks.
    await expect(
      executeV2ArkadeIntentsFund(covenantRequest({ to: ATTACKER_ADDRESS }), ctx),
    ).rejects.toThrow(/does not rebuild/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("REFUSES when a single covenant field is altered", async () => {
    // One wrong field is exactly how server #338 broke funding, in the other
    // direction. The gate must notice.
    await expect(
      executeV2ArkadeIntentsFund(
        covenantRequest({ lockupParams: { ...LOCKUP_PARAMS, claimDelay: 605_183 } }),
        ctx,
      ),
    ).rejects.toThrow(/does not rebuild/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("REFUSES a partial covenant rather than treating it as absent", async () => {
    // The server emits all four or none, so a subset is a contract violation.
    // Reading it as "no covenant, carry on" is exactly the hole this closes.
    const partial = covenantRequest();
    (partial as Record<string, unknown>).lockupParams = undefined;
    await expect(executeV2ArkadeIntentsFund(partial, ctx)).rejects.toThrow(/partial covenant/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("still funds a pre-covenant order, which carries none of it", async () => {
    // An order created before server #346. Its stored action must stay
    // fundable; the server refuses to emit a covenant-less action for a live
    // order, so absence here means age, not a missing proof.
    await executeV2ArkadeIntentsFund(
      { to: LOCKUP_ADDRESS, amountSats: 10_000, asset: "BTC_ARKADE" },
      ctx,
    );
    expect(mocks.fund).toHaveBeenCalled();
  });

  it("does not re-verify a reconciling call, which pays nothing", async () => {
    // Reporting an existing spend is not a second irreversible act.
    await executeV2ArkadeIntentsFund(covenantRequest({ to: ATTACKER_ADDRESS }), {
      ...(ctx as unknown as Record<string, unknown>),
      previouslyStarted: true,
    } as never);
    expect(mocks.fund).toHaveBeenCalled();
  });

  it("still enforces the accepted deposit ceiling", async () => {
    await expect(
      executeV2ArkadeIntentsFund(covenantRequest({ amountSats: 999_999 }), ctx),
    ).rejects.toThrow(/exceeds the accepted deposit/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });
});
