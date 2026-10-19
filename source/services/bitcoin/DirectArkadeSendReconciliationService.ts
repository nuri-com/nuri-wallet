import { sendBitcoin, type BitcoinSendResult, type BitcoinSendTarget } from "./BitcoinSendService";
import { PendingBitcoinSendsStore } from "./PendingBitcoinSendsStore";

const RECONCILIATION_REQUIRED_CODE = "direct_arkade_send_reconciliation_required";

export class DirectArkadeSendReconciliationRequiredError extends Error {
  readonly code = RECONCILIATION_REQUIRED_CODE;
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super("A previous direct Arkade send must be reconciled before another send.");
    this.name = "DirectArkadeSendReconciliationRequiredError";
    this.cause = cause;
  }
}

export function isDirectArkadeSendReconciliationRequiredError(
  error: unknown,
): error is DirectArkadeSendReconciliationRequiredError {
  return (
    error instanceof DirectArkadeSendReconciliationRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === RECONCILIATION_REQUIRED_CODE)
  );
}

export async function assertDirectArkadeSendCanStart(): Promise<void> {
  const rows = await PendingBitcoinSendsStore.list();
  if (rows.some((row) => row.reconciliationRequired === true)) {
    throw new DirectArkadeSendReconciliationRequiredError();
  }
}

/**
 * A direct Arkade send records its uncertainty once its transaction is signed
 * (after the passkey) and before the SDK submits it: the marker carries the
 * real txid. Anything that fails earlier (a
 * cancelled passkey, insufficient funds, a failed wallet read) never reaches
 * that point and leaves nothing behind. A throw after it stays blocked until
 * the reconciler proves the outcome (PendingSendsReconciler).
 */
export async function sendDirectArkadeWithReconciliation(params: {
  address: string;
  amountSats: number;
}): Promise<BitcoinSendResult> {
  const address = String(params.address || "").trim();
  const amountSats = Math.trunc(Number(params.amountSats));
  if (!address) throw new Error("recipient address required");
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be positive");
  }

  let signedTxid: string | null = null;
  try {
    // Fast guard before opening another approval; the signed hook repeats it.
    await assertDirectArkadeSendCanStart();
    const target: BitcoinSendTarget = {
      kind: "ark_send",
      address,
      amountSats,
      onSigned: async (txid) => {
        await assertDirectArkadeSendCanStart();
        await PendingBitcoinSendsStore.add({
          txid,
          amountSats,
          toAddress: address,
          reconciliationRequired: true,
          source: "arkade",
        });
        signedTxid = txid;
      },
    };
    const result = await sendBitcoin(target);
    const txid = String(result.txid || "").trim();
    if (!txid) throw new Error("direct Arkade send returned no txid");
    if (signedTxid && signedTxid.toLowerCase() !== txid.toLowerCase()) {
      throw new Error("direct Arkade send returned a txid other than the one it signed");
    }
    // Submitted and accepted: an ordinary pending row from here. If that write
    // fails the marker stays and the reconciler resolves it from history.
    if (signedTxid) await PendingBitcoinSendsStore.markKnown(signedTxid).catch(() => {});
    return result;
  } catch (error: unknown) {
    if (signedTxid && !isDirectArkadeSendReconciliationRequiredError(error)) {
      throw new DirectArkadeSendReconciliationRequiredError(error);
    }
    throw error;
  }
}
