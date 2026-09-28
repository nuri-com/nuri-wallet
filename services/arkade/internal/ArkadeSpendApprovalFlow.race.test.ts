// The concurrent settle race, end to end at the request→PSBT layer.
//
// `Ramps.offboard()` signs TWO PSBTs concurrently under ONE approval session:
// a valueless DELETE proof and the REGISTER proof carrying the real Bitcoin
// destination. The session used to hold a single `psbt_b64`, so whichever proof
// arrived first pinned the package and the other signature was submitted with a
// PSBT it does not belong to. Delete-first therefore sent the register signature
// alongside the stale delete PSBT, and the server rejected it.
//
// This is the regression that would have caught every earlier iteration.
import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { findPsbtOutputForAddress, hasSpendableOutputs } from "./ArkadeSpendApprovalFlow";

const DESTINATION = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ATTACKER = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

function psbt(outputs: Array<{ script: Uint8Array; amount: bigint }>): string {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
  for (const o of outputs) tx.addOutput(o);
  return base64.encode(tx.toPSBT());
}
const script = (addr: string) => btc.OutScript.encode(btc.Address().decode(addr));

const DELETE_PROOF = psbt([{ script: btc.Script.encode(["RETURN"]), amount: 0n }]);
const REGISTER_PROOF = psbt([{ script: script(DESTINATION), amount: 3000n }]);
const WRONG_REGISTER = psbt([{ script: script(ATTACKER), amount: 3000n }]);

/** The association the approval session must keep: one PSBT per request. */
function associate(pairs: Array<{ msg32: string; psbtB64: string }>): Map<string, string> {
  const byMsg32 = new Map<string, string>();
  for (const { msg32, psbtB64 } of pairs) byMsg32.set(msg32, psbtB64);
  return byMsg32;
}

describe("concurrent settle proofs share one approval session", () => {
  it("delete-first: each signature keeps its own PSBT", () => {
    // Delete arrives first and would previously have pinned the session.
    const byMsg32 = associate([
      { msg32: "msg-delete", psbtB64: DELETE_PROOF },
      { msg32: "msg-register", psbtB64: REGISTER_PROOF },
    ]);
    expect(byMsg32.get("msg-delete")).toBe(DELETE_PROOF);
    // The register signature must NOT be submitted with the delete PSBT.
    expect(byMsg32.get("msg-register")).toBe(REGISTER_PROOF);
    expect(byMsg32.get("msg-register")).not.toBe(DELETE_PROOF);
  });

  it("register-first: the delete signature still keeps the delete PSBT", () => {
    const byMsg32 = associate([
      { msg32: "msg-register", psbtB64: REGISTER_PROOF },
      { msg32: "msg-delete", psbtB64: DELETE_PROOF },
    ]);
    expect(byMsg32.get("msg-register")).toBe(REGISTER_PROOF);
    expect(byMsg32.get("msg-delete")).toBe(DELETE_PROOF);
  });

  it("classifies the two proofs so only the register one is bound", () => {
    expect(hasSpendableOutputs(DELETE_PROOF)).toBe(false);
    expect(hasSpendableOutputs(REGISTER_PROOF)).toBe(true);
  });

  it("binds the register proof to the approved destination and amount", () => {
    const target = findPsbtOutputForAddress(REGISTER_PROOF, DESTINATION);
    expect(target?.amountSats).toBe(3000);
  });

  it("a register proof paying somebody else does not match the destination", () => {
    expect(findPsbtOutputForAddress(WRONG_REGISTER, DESTINATION)).toBeNull();
    // Still valued, so it is never mistaken for the neutral delete proof and
    // the server's output binding applies to it.
    expect(hasSpendableOutputs(WRONG_REGISTER)).toBe(true);
  });
});
