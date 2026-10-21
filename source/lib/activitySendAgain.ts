// Send again to a Nuri user (#1770): their username is looked up when the
// button is pressed, so the send goes to the address it has now, never one
// saved from the old payment.
//
// The lookup takes a moment. Its answer counts only while the same row's
// details are still the ones open: closing them, or opening another row,
// invalidates it (the caller calls `gate.invalidate()`), and a late answer
// then does nothing at all.
import type { RecipientLookupGate } from "./pay/recipientLookupGate";

export type SendAgainLookup =
  | { kind: "go"; address: string }
  | { kind: "notFound" }
  | { kind: "failed" }
  /** The details changed while the lookup ran: do nothing. */
  | { kind: "stale" };

export async function lookUpSendAgain(opts: {
  username: string;
  /** The row the lookup is for. */
  rowKey: string;
  /** The row whose details are open now ("" for none). */
  openRowKey: () => string;
  gate: RecipientLookupGate;
  resolve: (username: string) => Promise<{ evmAddress: string | null } | null>;
  isValidAddress: (address: string) => boolean;
}): Promise<SendAgainLookup> {
  const ticket = opts.gate.begin(opts.rowKey);
  const current = () => opts.gate.isCurrent(ticket, opts.openRowKey());
  try {
    const address = (await opts.resolve(opts.username))?.evmAddress ?? null;
    if (!current()) return { kind: "stale" };
    return address && opts.isValidAddress(address) ? { kind: "go", address } : { kind: "notFound" };
  } catch {
    return current() ? { kind: "failed" } : { kind: "stale" };
  }
}
