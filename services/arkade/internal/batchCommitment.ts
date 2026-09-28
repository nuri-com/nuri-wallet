// The commitment transaction of the batch a settle is currently joining.
//
// A collaborative exit settles through a batch, and the cosigner will only sign
// the batch tree after re-deriving every message from that batch and checking it
// pays the destination the intent fixed. So the commitment has to travel from
// the SDK to the tree round — and the only place it surfaces is the settle event
// stream (`TreeSigningStarted.unsignedCommitmentTx`), which the signer session
// itself never sees.
//
// Module-level because the SDK owns everything in between: `settle()` receives
// the event callback, and constructs the signer session internally. One send
// runs at a time (the outgoing-approval lock guarantees it), so a single slot is
// enough — and it is cleared with the send.

let pendingBatchCommitmentTxB64: string | null = null;

export function setPendingBatchCommitmentTx(commitmentTxB64: string): void {
  const value = String(commitmentTxB64 || "").trim();
  pendingBatchCommitmentTxB64 = value || null;
}

export function getPendingBatchCommitmentTx(): string | null {
  return pendingBatchCommitmentTxB64;
}

export function clearPendingBatchCommitmentTx(): void {
  pendingBatchCommitmentTxB64 = null;
}
