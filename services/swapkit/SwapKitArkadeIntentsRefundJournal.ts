// The refund attempt journal for the `arkade_intents_v1` corridor.
//
// Its own module so it can be tested in isolation.
// Storage import is STATIC like every other app module: the PWA's single bundle can drop the
// target of an async import(), which is the "Requiring unknown module" class that killed Arkade
// claims on web. (Project rule: no dynamic import() of app modules outside tests.)
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";

const RESULT_STORAGE_KEY = "swapkit:arkade-intents-results:v1";

/**
 * One entry per refund attempt.
 *
 * `txid` alone was not enough: it can only be written AFTER the push, and the
 * window between "the sats moved" and "we wrote it down" is exactly where a
 * crash strands a refund — the next run finds no txid, re-pushes, and meets an
 * empty lockup forever. So the attempt is recorded BEFORE the broadcast, with
 * what the txid can be recovered from, and the txid fills in after.
 */
export type RefundJournalEntry = {
  /** Present once the push returned. Its absence means "may have broadcast". */
  txid?: string;
  /** Hex lockup pkScript — what a recovered spend is read off. */
  swapPkScriptHex: string;
  paymentHash: string;
  rfqId: string;
  startedAtMs: number;
};

/**
 * The journal, or a throw.
 *
 * A read that failed is not an empty journal. `journalEntry` replaces the whole
 * record, so treating a failure as "nothing stored" would drop every OTHER
 * attempt marker — including one written before a push that already broadcast,
 * which is the only thing telling a later run to go looking for that refund's
 * txid instead of concluding there is nothing to return.
 */
export async function loadJournalStrict(): Promise<Record<string, RefundJournalEntry>> {
  const parsed = await getCacheValue<unknown>(RESULT_STORAGE_KEY);
  return parsed && typeof parsed === "object"
    ? { ...(parsed as Record<string, RefundJournalEntry>) }
    : {};
}

export async function loadJournal(): Promise<Record<string, RefundJournalEntry>> {
  try {
    return await loadJournalStrict();
  } catch {
    return {};
  }
}

// Serialized like the VHTLC journal, and for the same reason: two interleaved
// load→modify→replace writes drop an entry, and a replay that finds none
// re-broadcasts a refund that already went out.
let journalChain: Promise<void> = Promise.resolve();
export async function journalEntry(
  actionId: string,
  changes: Partial<RefundJournalEntry> & Pick<RefundJournalEntry, "swapPkScriptHex">,
): Promise<void> {
  const write = journalChain.then(async () => {
    // Strict on the way in: a failed read must abort this write rather than
    // replace the journal with this action alone.
    const current = await loadJournalStrict();
    current[actionId] = { ...(current[actionId] ?? {}), ...changes } as RefundJournalEntry;
    await setCacheValue(RESULT_STORAGE_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}
