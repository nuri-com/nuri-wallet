// The covenant shape a funded lockup carries is not in the refund action's
// parameters. The solver moved lightning-send lockups to a nine-leaf covenant
// with a timelocked `nonInteractiveRefundWithoutReceiver`, and lockups funded
// before that shipped still carry the older shape — so both are built and the
// funded address picks. These are the three outcomes of that pick: the current
// shape, the pre-timelock one, and neither.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, hexToBytes } from "../../lib/bytes";

const SOLVER_PUBKEY = "11".repeat(32);
const SERVER_PUBKEY = "22".repeat(32);
const EMULATOR_PUBKEY = "33".repeat(32);
const SENDER_PUBKEY = "44".repeat(32);
const RECEIVER_PK_SCRIPT = "55".repeat(34);
const REFUND_PK_SCRIPT = "66".repeat(34);
const PAYMENT_HASH = "77".repeat(32);

const LOCKUP_ADDRESS = "ark1lockup";
const REFUND_ADDRESS = "ark1refund";

/** What each covenant shape rebuilds to, so a test can say which one was
 * funded by naming its script rather than by asserting on a call. */
const PK_SCRIPT_BY_SHAPE: Record<string, string> = {
  timelockedRefund: "aa".repeat(34),
  preTimelockedRefund: "bb".repeat(34),
};
const UNRELATED_PK_SCRIPT = "cc".repeat(34);

/** Only what the service reads off a built covenant, plus the shape label the
 * assertions identify it by. */
type FakeContract = { pkScript: Uint8Array; options: Record<string, never>; shape: string };

const mocks = {
  lightningSendVtxoScript: vi.fn(
    (_params: Record<string, unknown>): FakeContract => ({
      pkScript: new Uint8Array(),
      options: {},
      shape: "",
    }),
  ),
  pushRefundWithoutReceiver: vi.fn(async (..._args: unknown[]) => ({
    arkTxid: "ark-tx-1",
    amount: 1000,
  })),
  findLockupVtxos: vi.fn(async (..._args: unknown[]) => [
    { txid: "lockup-tx", vout: 0, value: 1000 },
  ]),
  submitSwapKitWalletAction: vi.fn(async (..._args: unknown[]) => undefined),
  /** The pkScript `ArkAddress.decode` answers for the funded lockup — i.e.
   * which shape the money actually sits in. */
  fundedPkScript: PK_SCRIPT_BY_SHAPE.timelockedRefund,
};

vi.mock("./SwapKitService", () => ({
  isTerminal: () => false,
  trackSwapKitSwap: vi.fn(),
  submitSwapKitWalletAction: (...args: unknown[]) => mocks.submitSwapKitWalletAction(...args),
}));
vi.mock("./SwapKitArkadeIntentsRefundJournal", () => ({
  loadJournal: vi.fn(async () => ({})),
  journalEntry: vi.fn(async () => undefined),
}));
vi.mock("../arkade/internal/browserApproval", () => ({
  // Transparent: the approval is not what these tests are about, and running
  // the inner call is the only way a refused rebuild can be observed as "the
  // push never happened".
  withOutgoingBrowserApproval: (_request: unknown, run: () => unknown) => run(),
}));
vi.mock("../arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: vi.fn(async () => "intent-1"),
}));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  getArkadeLightningSendOwnerKey: vi.fn(async () => "owner-1"),
  listArkadeLightningSends: vi.fn(async () => [
    {
      rfqId: "rfq-1",
      txId: "order-1",
      lockupAddress: LOCKUP_ADDRESS,
      refundAddress: REFUND_ADDRESS,
      senderPublicKey: SENDER_PUBKEY,
      senderDescriptor: "descriptor-1",
    },
  ]),
  deleteArkadeLightningSend: vi.fn(async () => undefined),
}));
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: vi.fn(async () => ({
    indexerProvider: { getVtxos: vi.fn() },
    arkProvider: { getInfo: vi.fn(), submitTx: vi.fn(), finalizeTx: vi.fn() },
  })),
}));
vi.mock("@arkade-os/sdk", () => ({
  ArkAddress: {
    decode: (address: string) => ({
      pkScript: hexToBytes(address === LOCKUP_ADDRESS ? mocks.fundedPkScript : REFUND_PK_SCRIPT),
    }),
  },
  contractSigner: vi.fn(async () => ({ sign: vi.fn() })),
}));
vi.mock("@arkade-os/swap", () => ({
  lightningSendVtxoScript: (params: Record<string, unknown>) =>
    mocks.lightningSendVtxoScript(params),
  findLockupVtxos: (...args: unknown[]) => mocks.findLockupVtxos(...args),
  pushRefundWithoutReceiver: (...args: unknown[]) => mocks.pushRefundWithoutReceiver(...args),
  readLockupFate: vi.fn(async () => ({ fate: "unknown" })),
}));

import { handleSwapKitArkadeIntentsAction } from "./SwapKitArkadeIntentsActionService";

const refundAction = () => ({
  actionId: "act-1",
  type: "arkade_intents_v1",
  provider: "arkade-intents",
  externalId: "rfq-1",
  request: {
    kind: "refund",
    rfqId: "rfq-1",
    lockupAddress: LOCKUP_ADDRESS,
    destinationAddress: REFUND_ADDRESS,
    lockup: {
      solverPubkey: SOLVER_PUBKEY,
      serverPubkey: SERVER_PUBKEY,
      emulatorPubkey: EMULATOR_PUBKEY,
      senderPubkey: SENDER_PUBKEY,
      receiverPkScript: RECEIVER_PK_SCRIPT,
      refundPkScript: REFUND_PK_SCRIPT,
      paymentHash: PAYMENT_HASH,
      claimDelay: 605184,
      refundLocktime: 1893456000,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fundedPkScript = PK_SCRIPT_BY_SHAPE.timelockedRefund;
  mocks.pushRefundWithoutReceiver.mockResolvedValue({ arkTxid: "ark-tx-1", amount: 1000 });
  mocks.findLockupVtxos.mockResolvedValue([{ txid: "lockup-tx", vout: 0, value: 1000 }]);
  // The builder stands in for the SDK's covenant derivation: each shape gets
  // its own script, which is the only property these tests need it to have.
  mocks.lightningSendVtxoScript.mockImplementation((params: Record<string, unknown>) => {
    const shape = params.legacy === undefined ? "timelockedRefund" : String(params.legacy);
    return {
      pkScript: hexToBytes(PK_SCRIPT_BY_SHAPE[shape] ?? UNRELATED_PK_SCRIPT),
      options: {},
      shape,
    };
  });
});

describe("rebuilding the lockup covenant before a refund is signed", () => {
  it.each([["timelockedRefund"], ["preTimelockedRefund"]])(
    "signs the %s shape when that is the one that was funded",
    async (shape) => {
      mocks.fundedPkScript = PK_SCRIPT_BY_SHAPE[shape];

      await handleSwapKitArkadeIntentsAction(refundAction(), { txId: "order-1" });

      // A lockup funded before the timelocked refund leaf shipped is still the
      // user's money; the upgrade must not strand it.
      const input = mocks.pushRefundWithoutReceiver.mock.calls[0][1] as {
        script: FakeContract;
      };
      expect(input.script.shape).toBe(shape);
      expect(mocks.submitSwapKitWalletAction).toHaveBeenCalledWith(
        expect.objectContaining({ txHash: "ark-tx-1" }),
      );
    },
  );

  // The guard the whole issue turns on: a covenant that does not rebuild to the
  // funded lockup is refused, and refused BEFORE anything is signed or pushed.
  it("refuses when neither shape rebuilds to the funded lockup", async () => {
    mocks.fundedPkScript = UNRELATED_PK_SCRIPT;

    await expect(
      handleSwapKitArkadeIntentsAction(refundAction(), { txId: "order-1" }),
    ).rejects.toThrow("does not rebuild to the funded lockup");

    expect(mocks.pushRefundWithoutReceiver).not.toHaveBeenCalled();
    expect(mocks.submitSwapKitWalletAction).not.toHaveBeenCalled();
  });

  // The builder names the Ark server key `serverPubkey` on the stable line (the
  // 0.1.0-rc line called it `operatorPubkey`). Passing the wrong spelling fails
  // as "Invalid public key length (server)" at signing time, far from here, so
  // it is pinned at the call.
  it("passes the Ark server key as serverPubkey", async () => {
    await handleSwapKitArkadeIntentsAction(refundAction(), { txId: "order-1" });

    const [params] = mocks.lightningSendVtxoScript.mock.calls[0];
    expect(bytesToHex((params as { serverPubkey: Uint8Array }).serverPubkey)).toBe(SERVER_PUBKEY);
    expect(params).not.toHaveProperty("operatorPubkey");
  });
});
