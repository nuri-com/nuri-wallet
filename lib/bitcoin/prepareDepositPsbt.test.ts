import * as btc from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToHex, hexToBytes } from "../bytes";
import { prepareDepositPsbt } from "./prepareDepositPsbt";

// The wallet's on-chain (MuSig2) address, and the deposit address a provider asked us to fund.
const OUR_KEY = btc.utils.pubSchnorr(new Uint8Array(32).fill(1));
const OUR = btc.p2tr(OUR_KEY);
const DEPOSIT = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(2)));
const RELAYER = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(3)));

const TAP_INTERNAL_KEY = btc.utils.pubSchnorr(new Uint8Array(32).fill(4));
const TAP_MERKLE_ROOT = new Uint8Array(32).fill(7);

const from = {
  address: OUR.address as string,
  tapInternalKey: TAP_INTERNAL_KEY,
  tapMerkleRoot: TAP_MERKLE_ROOT,
};

// LI.FI's own deposit transaction, as its live quote returns it: deposit output first, then the
// OP_RETURN memo, then the wallet's change, then the relayer's fee.
// '0x75fca05e…|lifi', the payload LI.FI puts in the deposit's OP_RETURN.
const MEMO = hexToBytes(
  bytesToHex(
    new TextEncoder().encode(
      "0x75fca05e6c9ac13a1adfae935d9ec82671cd2a225238bd9ac7f6349617dfc6ef|lifi",
    ),
  ),
);
const memoScript = Uint8Array.from([0x6a, 0x4c, MEMO.length, ...MEMO]);

function depositPsbt(
  options: {
    memoFirst?: boolean;
    foreignInput?: boolean;
    changeSats?: number;
    /** Extra sats to a third party, paid out of the change the wallet would otherwise get back. */
    extraOutputSats?: number;
    sighashType?: number;
  } = {},
) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: new Uint8Array(32).fill(9),
    index: 0,
    witnessUtxo: {
      script: (options.foreignInput ? RELAYER : OUR).script,
      amount: 8_527n,
    },
    ...(options.sighashType === undefined ? {} : { sighashType: options.sighashType }),
  });
  const memo = { script: memoScript, amount: 0n };
  const outputs = options.memoFirst
    ? [memo, { script: DEPOSIT.script, amount: 4_988n }]
    : [
        { script: DEPOSIT.script, amount: 4_988n },
        memo,
        {
          script: OUR.script,
          amount: BigInt(options.changeSats ?? 2_087 - (options.extraOutputSats ?? 0)),
        },
        { script: RELAYER.script, amount: BigInt(294 + (options.extraOutputSats ?? 0)) },
      ];
  for (const output of outputs) tx.addOutput(output);
  return tx;
}

const hex = (tx: btc.Transaction) => bytesToHex(tx.toPSBT());

function outputsOf(psbtB64: string) {
  const tx = btc.Transaction.fromPSBT(base64ToBytes(psbtB64));
  return Array.from({ length: tx.outputsLength }, (_, i) => ({
    script: bytesToHex(tx.getOutput(i).script as Uint8Array),
    amount: tx.getOutput(i).amount ?? 0n,
  }));
}

describe("prepareDepositPsbt", () => {
  it("keeps the provider's outputs byte for byte", () => {
    const original = depositPsbt();
    const prepared = prepareDepositPsbt({
      psbt: hex(original),
      from,
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
    });

    expect(outputsOf(prepared.psbtB64)).toEqual(
      outputsOf(Buffer.from(original.toPSBT()).toString("base64")),
    );
    expect(prepared.fundingAmountSats).toBe(4_988);
    expect(prepared.fundingAddress).toBe(DEPOSIT.address);
    // 8,527 in, 4,988 + 0 + 2,087 + 294 out.
    expect(prepared.feeSats).toBe(1_158);
    expect(prepared.debitSats).toBe(6_440);
  });

  it("stamps the taproot material the co-signer needs on every input", () => {
    const prepared = prepareDepositPsbt({
      psbt: hex(depositPsbt()),
      from,
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
    });

    const tx = btc.Transaction.fromPSBT(base64ToBytes(prepared.psbtB64));
    for (let i = 0; i < tx.inputsLength; i++) {
      expect(tx.getInput(i).tapInternalKey).toEqual(TAP_INTERNAL_KEY);
      expect(tx.getInput(i).tapMerkleRoot).toEqual(TAP_MERKLE_ROOT);
    }
  });

  it("accepts a base64 PSBT", () => {
    const prepared = prepareDepositPsbt({
      psbt: Buffer.from(depositPsbt().toPSBT()).toString("base64"),
      from,
      expectedRecipient: DEPOSIT.address as string,
      acceptedDebitSats: 6_440,
    });

    expect(prepared.fundingAmountSats).toBe(4_988);
  });

  // The whole reason this module exists: a deposit from somewhere else must never be signed with our
  // keys, however plausible its outputs look.
  it("refuses a PSBT whose inputs are not this wallet's", () => {
    expect(() =>
      prepareDepositPsbt({
        psbt: hex(depositPsbt({ foreignInput: true })),
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/does not spend this wallet's Bitcoin address/);
  });

  // The co-signer walks outputs in order and stops at the first match, so a PSBT that pays the
  // deposit second (or not at all) is not one this wallet should sign.
  it("refuses a PSBT that does not pay the deposit address first", () => {
    expect(() =>
      prepareDepositPsbt({
        psbt: hex(depositPsbt({ memoFirst: true })),
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/must pay .* first/);
  });

  // The hostile case: the PSBT is shaped like a deposit but pays an extra output (or an inflated fee)
  // that the accepted instruction never mentioned. The co-signer binds only the funding output, so
  // without the debit check this would be approved and signed.
  it("refuses a PSBT that spends more of the wallet than the accepted instruction states", () => {
    // 500 sats that were coming back as change now go to a third party, so the wallet's debit grows by
    // exactly that. The funding output is untouched, which is why the co-signer alone would sign it.
    const hostile = depositPsbt({ extraOutputSats: 500 });

    expect(() =>
      prepareDepositPsbt({
        psbt: hex(hostile),
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/spends 6940 sats from this wallet, the accepted funding instruction states 6440/);
  });

  it("refuses an inflated miner fee, which is the same debit by another route", () => {
    const inflatedFee = depositPsbt({ changeSats: 1_000 });

    expect(() =>
      prepareDepositPsbt({
        psbt: hex(inflatedFee),
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/spends 7527 sats from this wallet/);
  });

  // A signature under NONE, SINGLE or ANYONECANPAY does not commit to the outputs that were just
  // validated, so the transaction that broadcasts need not be the one checked here.
  it.each([1, 2, 3, 0x81, 0x82, 0x83])(
    "refuses an input that carries sighash %i instead of the default",
    (sighashType) => {
      expect(() =>
        prepareDepositPsbt({
          psbt: hex(depositPsbt({ sighashType })),
          from,
          expectedRecipient: DEPOSIT.address as string,
          acceptedDebitSats: 6_440,
        }),
      ).toThrow(new RegExp(`carries sighash ${sighashType}`));
    },
  );

  it("refuses an instruction that states no debit at all", () => {
    expect(() =>
      prepareDepositPsbt({
        psbt: hex(depositPsbt()),
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 0,
      }),
    ).toThrow(/states no wallet debit/);
  });

  it("refuses something that is not a PSBT", () => {
    expect(() =>
      prepareDepositPsbt({
        psbt: "deadbeef",
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/not a PSBT/);
  });

  it("refuses an empty value", () => {
    expect(() =>
      prepareDepositPsbt({
        psbt: "",
        from,
        expectedRecipient: DEPOSIT.address as string,
        acceptedDebitSats: 6_440,
      }),
    ).toThrow(/psbt required/);
  });
});
