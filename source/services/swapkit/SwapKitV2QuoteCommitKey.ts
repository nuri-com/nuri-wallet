// Quote → commit storage wake-up (swapkit #411).
//
// Every commit reaches a handful of server storage objects that are brand new
// for the payment; creating them costs the server about 1.5 s. A quote that
// names the commit to come (its idempotency key plus the wallet's recovery
// key) lets the server create them while the providers quote, so the commit
// after it finds them ready. The key only names objects: the commit still
// persists its own intent first, and a commit without a remembered key simply
// uses a new one, as before.

const TTL_MS = 10 * 60_000;
const MAX_KEYS = 50;
const keysByQuoteId = new Map<string, { key: string; at: number }>();
let recoveryKeySource: (() => Promise<string>) | null = null;

/** A fresh commit idempotency key for `owner`. */
export function newV2CommitIdempotencyKey(owner: string): string {
  return `expo:${owner.toLowerCase()}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

/** Registered by the commit flow, which owns the wallet's recovery key, so the
 * quote layer does not pull the wallet and auth modules into every importer. */
export function setV2QuoteRecoveryKeySource(source: () => Promise<string>): void {
  recoveryKeySource = source;
}

/** The fields a committable quote adds to name its commit (the caller's own
 * values win), or null when no recovery key is available: the quote then goes
 * out as before. */
export async function v2QuoteCommitHint(
  owner: string,
  known: { idempotencyKey?: string; recoveryKey?: string } = {},
): Promise<{ idempotencyKey: string; recoveryKey: string } | null> {
  const recoveryKey =
    known.recoveryKey ?? (await recoveryKeySource?.().catch((): null => null)) ?? null;
  if (!recoveryKey) return null;
  return { idempotencyKey: known.idempotencyKey ?? newV2CommitIdempotencyKey(owner), recoveryKey };
}

/** Remember the key a quote named, for each quoteId the quote returned. */
export function rememberV2QuoteCommitKey(quoteIds: Iterable<string>, key: string): void {
  const at = Date.now();
  for (const quoteId of quoteIds) {
    if (!quoteId) continue;
    keysByQuoteId.delete(quoteId);
    keysByQuoteId.set(quoteId, { key, at });
  }
  while (keysByQuoteId.size > MAX_KEYS) {
    const oldest = keysByQuoteId.keys().next().value;
    if (oldest === undefined) break;
    keysByQuoteId.delete(oldest);
  }
}

/** The key the quote named, once: a second commit of the same quote gets a
 * new key (and so its own order), never the first one's. */
export function takeV2QuoteCommitKey(quoteId: string | undefined): string | null {
  if (!quoteId) return null;
  const entry = keysByQuoteId.get(quoteId);
  if (!entry) return null;
  // One quote response shares one key across its options: whichever option is
  // committed, the others must not hand the same key out again.
  for (const [id, other] of keysByQuoteId) if (other.key === entry.key) keysByQuoteId.delete(id);
  return Date.now() - entry.at <= TTL_MS ? entry.key : null;
}
