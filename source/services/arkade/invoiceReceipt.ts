// Receipt state for one displayed Lightning invoice (#2044).
//
// The invoice sheet shows a QR for an invoice the server created. Whether that
// exact invoice got paid comes from the server's receive sync rows
// (`/receive/sync`) only: a row for the same swap, payment hash, invoice and
// amount whose status says funds wait to be claimed means the payer paid and
// the wallet still has to claim; a settled, not claimable row means the sats
// are in the wallet. (The app's own claim engine is retired, so there is no
// separate claim event to follow.)
// Nothing else (a toast, another payment, the payer's side) moves the state.
//
// The phase only moves forward (waiting -> detected -> received), so a late,
// duplicate or out-of-order update, a row that leaves the sync once claimed, or
// a foreground resume cannot erase a receipt or mark the wrong invoice paid.
// One exception: a terminal refund/failure of the swap (`refunded`) ends a
// detected receipt too, since the funds can no longer be claimed. Only
// `received` stays terminal; a plain expiry (`failed`) never undoes a payment.

export type InvoiceReceiptPhase = "waiting" | "detected" | "received" | "failed" | "refunded";

export type InvoiceReceiptTarget = {
  swapId: string;
  paymentHash?: string;
  invoice: string;
  amountSats: number;
};

/** The fields of a server receive row this module reads. */
export type InvoiceReceiptRow = {
  id?: unknown;
  receive_id?: unknown;
  swap_id?: unknown;
  invoice?: unknown;
  payment_hash_hex?: unknown;
  preimage_hash_hex?: unknown;
  amount_msat?: unknown;
  status?: unknown;
  boltz_status?: unknown;
};

const CLAIMABLE_BOLTZ = new Set(["transaction.mempool", "transaction.confirmed"]);
const SETTLED_BOLTZ = "invoice.settled";
// The lockup was refunded or failed: nothing is left to claim.
const REFUNDED_BOLTZ = new Set(["transaction.refunded", "transaction.failed"]);
const EXPIRED_BOLTZ = new Set(["invoice.expired", "swap.expired"]);

const RANK: Record<InvoiceReceiptPhase, number> = {
  waiting: 0,
  failed: 1,
  detected: 2,
  refunded: 3,
  received: 4,
};

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripLightningPrefix(value: unknown): string {
  const raw = norm(value);
  return raw.startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
}

function rowSwapId(row: InvoiceReceiptRow): string {
  return norm(row.swap_id) || stripLightningPrefix(row.receive_id) || stripLightningPrefix(row.id);
}

/**
 * True only when the row is this invoice: same swap id, and wherever the row
 * states a payment hash, an invoice or an amount, the same one. A target
 * without a swap id matches nothing.
 */
export function rowMatchesInvoice(row: InvoiceReceiptRow, target: InvoiceReceiptTarget): boolean {
  const swapId = norm(target.swapId);
  if (!swapId || rowSwapId(row) !== swapId) return false;
  const targetHash = norm(target.paymentHash);
  const rowHash = norm(row.payment_hash_hex) || norm(row.preimage_hash_hex);
  if (targetHash && rowHash && rowHash !== targetHash) return false;
  if (targetHash && !rowHash) return false;
  const rowInvoice = norm(row.invoice);
  if (rowInvoice && rowInvoice !== norm(target.invoice)) return false;
  const msat = Number(row.amount_msat);
  if (Number.isFinite(msat) && msat > 0) {
    if (Math.trunc(msat) !== Math.trunc(target.amountSats) * 1000) return false;
  }
  return true;
}

/** What one matching row says about the invoice, or null when it says nothing. */
export function phaseFromRow(row: InvoiceReceiptRow): InvoiceReceiptPhase | null {
  const boltz = norm(row.boltz_status);
  const status = norm(row.status);
  if (REFUNDED_BOLTZ.has(boltz) || REFUNDED_BOLTZ.has(status)) return "refunded";
  // Settled-but-unclaimed rows come back as claimable with an effective
  // mempool status; either way the wallet still has to claim.
  if (status === "claimable" || CLAIMABLE_BOLTZ.has(boltz) || CLAIMABLE_BOLTZ.has(status)) {
    return "detected";
  }
  // A reverse swap's invoice settles only once the claim revealed the preimage:
  // a settled row that is not claimable means the sats are in the wallet, even
  // whoever claimed it.
  if (boltz === SETTLED_BOLTZ || status === SETTLED_BOLTZ) return "received";
  if (EXPIRED_BOLTZ.has(boltz) || EXPIRED_BOLTZ.has(status)) return "failed";
  return null;
}

/**
 * Forward-only merge: a later phase wins, an earlier one never replaces it.
 * Order: waiting < failed (expiry) < detected < refunded < received.
 */
export function advanceReceiptPhase(
  current: InvoiceReceiptPhase,
  next: InvoiceReceiptPhase | null,
): InvoiceReceiptPhase {
  if (!next) return current;
  return RANK[next] > RANK[current] ? next : current;
}

/** Applies a sync row batch: only rows of this invoice count. */
export function receiptPhaseFromRows(
  current: InvoiceReceiptPhase,
  rows: ReadonlyArray<InvoiceReceiptRow>,
  target: InvoiceReceiptTarget,
): InvoiceReceiptPhase {
  let phase = current;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (!rowMatchesInvoice(row, target)) continue;
    phase = advanceReceiptPhase(phase, phaseFromRow(row));
  }
  return phase;
}

/** Whether the invoice can no longer bring funds in (expired, refunded, failed). */
export function receiptEnded(phase: InvoiceReceiptPhase): boolean {
  return phase === "failed" || phase === "refunded";
}

/** Whether the invoice still waits for a payer (the expiry countdown applies). */
export function receiptAwaitsPayment(phase: InvoiceReceiptPhase): boolean {
  return phase === "waiting";
}
