import * as btc from "@scure/btc-signer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex } from "../../lib/bytes";

// The v4 co-signer compares the approval's amount against the intent's funding amount, so the deposit
// send has to arm the approval on the funding output (not on the wallet's total debit) while still
// telling the user what the transaction costs. A boundary check caught exactly that mismatch.

const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  swapIntent: vi.fn(),
  broadcast: vi.fn(),
  approval: vi.fn(),
  sendSource: vi.fn(),
}));

vi.mock("../arkade/internal/browserApproval", () => ({
  withOutgoingBrowserApproval: (spec: unknown, run: () => Promise<string>) => {
    mocks.approval(spec);
    return run();
  },
}));
vi.mock("../arkade/internal/identity", () => ({
  getOrCreateArkadeIdentity: async () => ({
    sign: async (tx: btc.Transaction) => {
      mocks.sign(tx);
      return {
        finalize: () => {},
        extract: () => SIGNED_RAW,
      };
    },
  }),
}));
vi.mock("../arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: mocks.swapIntent,
}));
vi.mock("./BlockchainService", () => ({
  blockchainService: { broadcastTransaction: mocks.broadcast },
}));
vi.mock("./WalletService", () => ({
  walletService: { getMusig2SendSource: mocks.sendSource },
}));

const { sendBitcoinDepositPsbt } = await import("./OnchainSendService");

const OUR = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(1)));
const DEPOSIT = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(2)));
const RELAYER = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(3)));
const MEMO = Uint8Array.from([0x6a, 0x03, 0x61, 0x62, 0x63]);

// A real, fully serialised transaction, so the id the service derives is a real id.
const SIGNED_RAW = (() => {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(5), index: 1 });
  tx.addOutput({ script: new Uint8Array([0x51]), amount: 1_000n });
  // The provider's memo output, which the default parser refuses.
  tx.addOutput({ script: MEMO, amount: 0n });
  return tx.toBytes(true, false);
})();
const SIGNED_TXID = btc.Transaction.fromRaw(SIGNED_RAW, { allowUnknownOutputs: true }).id;

const TAP_INTERNAL_KEY = btc.utils.pubSchnorr(new Uint8Array(32).fill(4));
const TAP_MERKLE_ROOT = new Uint8Array(32).fill(7);

/** LI.FI's deposit transaction: deposit output, memo, our change, the relayer's fee. */
function depositPsbtHex() {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: new Uint8Array(32).fill(9),
    index: 0,
    witnessUtxo: { script: OUR.script, amount: 8_527n },
  });
  tx.addOutput({ script: DEPOSIT.script, amount: 4_988n });
  tx.addOutput({ script: MEMO, amount: 0n });
  tx.addOutput({ script: OUR.script, amount: 2_087n });
  tx.addOutput({ script: RELAYER.script, amount: 294n });
  return bytesToHex(tx.toPSBT());
}

describe("sendBitcoinDepositPsbt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendSource.mockReturnValue({
      address: OUR.address as string,
      tapInternalKey: TAP_INTERNAL_KEY,
      tapMerkleRoot: TAP_MERKLE_ROOT,
    });
    mocks.swapIntent.mockResolvedValue("intent-1");
    mocks.broadcast.mockResolvedValue("deposit-txid");
  });

  it("arms the approval on the funding output, with the debit stated in the note", async () => {
    const result = await sendBitcoinDepositPsbt({
      psbt: depositPsbtHex(),
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
    });

    expect(result).toMatchObject({ txid: "deposit-txid", sats: 4_988 });
    expect(mocks.swapIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        finalRecipient: DEPOSIT.address,
        fundingAmountSats: 4_988,
      }),
    );
    const spec = mocks.approval.mock.calls[0][0] as {
      amountSats: number;
      finalAmountSats: number;
      note: string;
    };
    // The co-signer matches this against the intent's funding_amount_sats.
    expect(spec.amountSats).toBe(4_988);
    expect(spec.finalAmountSats).toBe(4_988);
    expect(spec.note).toContain("6,440");
    expect(spec.note).toContain("4,988");
  });

  it("signs the provider's transaction with the outputs it arrived with", async () => {
    await sendBitcoinDepositPsbt({
      psbt: depositPsbtHex(),
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
    });

    const signed = mocks.sign.mock.calls[0][0] as btc.Transaction;
    const scripts = Array.from({ length: signed.outputsLength }, (_, i) =>
      bytesToHex(signed.getOutput(i).script as Uint8Array),
    );
    expect(scripts).toEqual([
      bytesToHex(DEPOSIT.script),
      bytesToHex(MEMO),
      bytesToHex(OUR.script),
      bytesToHex(RELAYER.script),
    ]);
    expect(mocks.sign.mock.calls[0][0].getInput(0).tapInternalKey).toEqual(TAP_INTERNAL_KEY);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
  });

  // Review 5294728655 #1: the caller records the signed transaction before it can reach the network.
  it("hands the signed transaction to the caller before broadcasting it", async () => {
    const order: string[] = [];
    mocks.broadcast.mockImplementation(async () => {
      order.push("broadcast");
      return "deposit-txid";
    });
    const onSigned = vi.fn(async (signed: { txid: string; rawHex: string }) => {
      order.push(`recorded:${signed.rawHex}`);
    });

    await sendBitcoinDepositPsbt({
      psbt: depositPsbtHex(),
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
      onSigned,
    });

    const raw = bytesToHex(SIGNED_RAW);
    expect(order).toEqual([`recorded:${raw}`, "broadcast"]);
    expect(mocks.broadcast).toHaveBeenCalledWith(raw);
    // The recorded id is the id of the recorded bytes.
    expect(onSigned.mock.calls[0][0].txid).toBe(SIGNED_TXID);
  });

  it("broadcasts nothing when recording the signed transaction fails", async () => {
    await expect(
      sendBitcoinDepositPsbt({
        psbt: depositPsbtHex(),
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
        onSigned: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a debit that does not match the accepted amount", async () => {
    await expect(
      sendBitcoinDepositPsbt({
        psbt: depositPsbtHex(),
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 5_000,
      }),
    ).rejects.toThrow(/spends 6440 sats from this wallet/);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
