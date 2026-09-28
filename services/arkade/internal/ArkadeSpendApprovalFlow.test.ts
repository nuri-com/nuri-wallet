// Guards the register-vs-delete intent proof discrimination.
//
// `settle()` signs two proofs concurrently (SDK 0.4.38): a register intent whose
// outputs carry the destination, and a delete intent created with no outputs at
// all. Either can reach the approval hook first. Attaching the swap intent to
// the delete proof is what made every collaborative exit fail — it looked like
// the destination could not be bound at all.
import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { hasSpendableOutputs, findPsbtOutputForAddress } from "./ArkadeSpendApprovalFlow";

const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function psbtWith(outputs: Array<{ script: Uint8Array; amount: bigint }>): string {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
  for (const output of outputs) tx.addOutput(output);
  return base64.encode(tx.toPSBT());
}

const opReturn = btc.Script.encode(["RETURN"]);
const recipientScript = btc.OutScript.encode(btc.Address().decode(BTC_ADDRESS));

describe("register vs delete intent proofs", () => {
  it("treats a delete proof (no outputs) as non-register", () => {
    expect(hasSpendableOutputs(psbtWith([]))).toBe(false);
  });

  it("treats the 0-sat OP_RETURN delete proof as non-register", () => {
    // This is the shape that was captured live as `outputs=0:?=0`.
    expect(hasSpendableOutputs(psbtWith([{ script: opReturn, amount: 0n }]))).toBe(false);
  });

  it("treats a register proof carrying the destination as register", () => {
    expect(hasSpendableOutputs(psbtWith([{ script: recipientScript, amount: 3000n }]))).toBe(true);
  });

  it("binds the destination output of a register proof, not the requested amount", () => {
    // 3000, not the 3200 the user asked for: the offboard fee comes out of the
    // amount, so only the PSBT knows what actually lands on chain.
    const psbt = psbtWith([{ script: recipientScript, amount: 3000n }]);
    const target = findPsbtOutputForAddress(psbt, BTC_ADDRESS);
    expect(target?.amountSats).toBe(3000);
    expect(target?.scriptHex).toBe(Buffer.from(recipientScript).toString("hex"));
  });

  it("does not match a register proof paying somebody else", () => {
    const other = btc.OutScript.encode(
      btc.Address().decode("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"),
    );
    const psbt = psbtWith([{ script: other, amount: 3000n }]);
    expect(findPsbtOutputForAddress(psbt, BTC_ADDRESS)).toBeNull();
    // Spendable, so the caller throws rather than silently skipping — an
    // unexpected recipient must never be mistaken for the delete proof.
    expect(hasSpendableOutputs(psbt)).toBe(true);
  });
});
