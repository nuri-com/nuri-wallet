import * as btc from "@scure/btc-signer";
import { base64ToBytes, bytesToBase64, hexToBytes } from "../bytes";

const TAP_MERKLE_ROOT_LEN = 32;

/** Taproot key material of the wallet's on-chain (MuSig2) address. The arkade co-signer re-derives
 * the tweak as taggedHash("TapTweak", tapInternalKey ‖ tapMerkleRoot) from what it reads in the PSBT,
 * so a deposit PSBT built by someone who only knows the address has to be stamped with both before it
 * can be signed. */
export type DepositSigningMaterial = {
  address: string;
  tapInternalKey: Uint8Array | string;
  tapMerkleRoot: Uint8Array | string;
};

export type PreparedDepositPsbt = {
  psbtB64: string;
  /** The funding output the co-signer binds its approval to: what the provider receives. */
  fundingAddress: string;
  fundingAmountSats: number;
  /** What signing this transaction costs the wallet: value in minus value coming back to it. */
  debitSats: number;
  feeSats: number;
};

function inputScript(tx: btc.Transaction, index: number): Uint8Array {
  const input = tx.getInput(index) as { witnessUtxo?: { script?: Uint8Array } };
  const script = input?.witnessUtxo?.script;
  if (!script) throw new Error(`deposit psbt input ${index} has no witnessUtxo script`);
  return script;
}

function outputScript(tx: btc.Transaction, index: number): Uint8Array {
  const script = tx.getOutput(index)?.script;
  if (!script) throw new Error(`deposit psbt output ${index} has no script`);
  return script;
}

/** Byte-wise comparison of two scripts. */
function Bytes(script: Uint8Array): string {
  return Buffer.from(script).toString("hex");
}

function addressOf(script: Uint8Array): string {
  return btc.Address().encode(btc.OutScript.decode(script));
}

/**
 * Take a deposit PSBT a provider built for a bridge deposit and make it signable by this wallet,
 * without touching a single output.
 *
 * A bridge deposit is a transaction, not a payment: LI.FI returns the exact PSBT (deposit output, its
 * OP_RETURN, the wallet's change, the relayer's fee) and its solver matches on that transaction, so
 * reproducing the memo in a self-built payment does not satisfy it and neither does re-sending the
 * quoted amount. The outputs therefore travel byte for byte, and only what the signer needs is added.
 *
 * What is checked, and why each check is here rather than left to the co-signer:
 * - every input spends this wallet's address, so a PSBT from elsewhere can never be signed with these
 *   keys even if its outputs look right;
 * - the FIRST output is the declared funding recipient, because the co-signer walks outputs in order
 *   and stops at the first match: if a data output or a fee payout came first, it would read that
 *   instead (a 0-sat output is not an amount);
 * - there is a positive first output at all, since a deposit PSBT with nothing to bind is not a
 *   deposit;
 * - every input commits to the whole transaction (Taproot SIGHASH_DEFAULT only). A signature made
 *   under NONE, SINGLE or ANYONECANPAY does not commit to the outputs that were just validated, so the
 *   transaction that gets broadcast need not be the one checked here;
 * - the wallet's total debit (inputs minus value returning to this wallet) equals what the accepted
 *   instruction said the deposit costs. The co-signer binds only the funding output, so a PSBT that
 *   crossed the provider and server boundary with an extra output or an inflated fee would otherwise be
 *   signed unnoticed: every non-funding output of a deposit PSBT is trusted only as far as this number
 *   holds, and it is what the approval shows the user.
 */
export function prepareDepositPsbt(params: {
  psbt: string;
  from: DepositSigningMaterial;
  expectedRecipient: string;
  /** What the accepted funding instruction said this deposit costs the wallet, in sats. */
  acceptedDebitSats: number;
}): PreparedDepositPsbt {
  const raw = String(params.psbt || "")
    .trim()
    .replace(/^0x/, "");
  if (!raw) throw new Error("deposit psbt required");
  const bytes =
    /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? hexToBytes(raw) : base64ToBytes(raw);

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(bytes);
  } catch {
    throw new Error("deposit psbt is not a PSBT");
  }
  if (tx.inputsLength === 0) throw new Error("deposit psbt has no inputs");
  if (tx.outputsLength === 0) throw new Error("deposit psbt has no outputs");

  const fromScript = btc.OutScript.encode(btc.Address().decode(params.from.address));
  const recipientScript = btc.OutScript.encode(btc.Address().decode(params.expectedRecipient));

  let totalIn = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    // SIGHASH_DEFAULT (absent or 0) is the only sig hash this wallet signs here: every other flag
    // lets a signature commit to less than the transaction that was validated and approved.
    const sighash = (tx.getInput(i) as { sighashType?: number | null }).sighashType;
    if (sighash !== undefined && sighash !== null && sighash !== 0) {
      throw new Error(
        `deposit psbt input ${i} carries sighash ${sighash}; only the default is signed`,
      );
    }
    const script = inputScript(tx, i);
    if (Buffer.from(script).toString("hex") !== Buffer.from(fromScript).toString("hex")) {
      throw new Error(`deposit psbt input ${i} does not spend this wallet's Bitcoin address`);
    }
    totalIn += tx.getInput(i).witnessUtxo?.amount ?? 0n;
  }

  const firstScript = outputScript(tx, 0);
  if (Buffer.from(firstScript).toString("hex") !== Buffer.from(recipientScript).toString("hex")) {
    // The first output is often not an address at all (a data output), which is exactly why it must
    // not be first, so naming it has to survive a script that cannot be encoded as one.
    let actual: string;
    try {
      actual = addressOf(firstScript);
    } catch {
      actual = `a non-address output (${Buffer.from(firstScript).toString("hex").slice(0, 20)}…)`;
    }
    throw new Error(`deposit psbt must pay ${params.expectedRecipient} first (it pays ${actual})`);
  }
  const fundingAmountSats = Number(tx.getOutput(0).amount ?? 0n);
  if (!Number.isFinite(fundingAmountSats) || fundingAmountSats <= 0) {
    throw new Error("deposit psbt has no positive funding output");
  }

  let totalOut = 0n;
  let returning = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const amount = tx.getOutput(i).amount ?? 0n;
    totalOut += amount;
    if (Bytes(outputScript(tx, i)) === Bytes(fromScript)) returning += amount;
  }
  const debitSats = Number(totalIn - returning);
  const accepted = Math.trunc(Number(params.acceptedDebitSats));
  if (!Number.isFinite(accepted) || accepted <= 0) {
    throw new Error("deposit psbt: the accepted funding instruction states no wallet debit");
  }
  if (debitSats !== accepted) {
    throw new Error(
      `deposit psbt spends ${debitSats} sats from this wallet, the accepted funding instruction states ${accepted}`,
    );
  }

  // Only the signer's inputs are touched: outputs, their order and their values are the provider's.
  const tapInternalKey =
    typeof params.from.tapInternalKey === "string"
      ? hexToBytes(params.from.tapInternalKey)
      : params.from.tapInternalKey;
  const tapMerkleRoot =
    typeof params.from.tapMerkleRoot === "string"
      ? hexToBytes(params.from.tapMerkleRoot)
      : params.from.tapMerkleRoot;
  if (tapMerkleRoot.length !== TAP_MERKLE_ROOT_LEN) {
    throw new Error("deposit psbt: from.tapMerkleRoot must be 32 bytes");
  }
  for (let i = 0; i < tx.inputsLength; i++) {
    tx.updateInput(i, { tapInternalKey, tapMerkleRoot });
  }

  return {
    psbtB64: bytesToBase64(tx.toPSBT()),
    fundingAddress: params.expectedRecipient,
    fundingAmountSats,
    debitSats,
    feeSats: Number(totalIn - totalOut),
  };
}
