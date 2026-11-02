// How a contact's page reads the histories it picks its rows from (#1793),
// with what each read could NOT see, so the page never calls an unread
// history "no payments". The fetchers are injected: this is plain logic,
// tested in contactActivityReads.test.ts; useContactActivity wires the real ones.
import type { WalletTransactionRow } from "../../types/wallet";
import type { AddressTx } from "../../types/bitcoin";

/** One history: the rows read, and whether that is all of it. */
export type SourceRead<T> = { rows: T[]; complete: boolean };

type CashAnswer = { orders?: WalletTransactionRow[] | null; error?: string | null };

/**
 * A Cash history. The strict read says when the scan failed (the lenient one
 * answers a failed scan with cached rows, or none, and no error); on a failure
 * the lenient read still shows the cached rows, marked incomplete.
 */
export async function readCashHistory(
  fetch: (strict: boolean) => Promise<CashAnswer>,
): Promise<SourceRead<WalletTransactionRow>> {
  try {
    const strict = await fetch(true);
    if (!strict.error && Array.isArray(strict.orders)) {
      return { rows: strict.orders, complete: true };
    }
  } catch {}
  try {
    const cached = await fetch(false);
    return { rows: cached.orders ?? [], complete: false };
  } catch {
    return { rows: [], complete: false };
  }
}

/**
 * Every page of a paged history, until a short page. A page that fails, or a
 * history longer than `maxPages`, keeps the pages already read and is
 * incomplete. An item listed on two pages (the list moved while paging) is kept once.
 */
export async function readAllPagesKept<T extends { id?: string | null }>(
  fetchPage: (page: number) => Promise<readonly T[]>,
  pageSize: number,
  maxPages = 50,
): Promise<SourceRead<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page += 1) {
    let items: readonly T[];
    try {
      items = await fetchPage(page);
    } catch {
      return { rows, complete: false };
    }
    for (const item of items) {
      const id = item.id ? String(item.id) : "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(item);
    }
    if (items.length < pageSize) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * Rows of one rail in a list that mixes rails: the key names the rail, so a
 * Euro and a Dollar leg of one transaction (same hash, same kind) both stay,
 * while a row repeated within one rail still collapses into one.
 */
export function withRailKeys<T extends { key: string }>(rows: readonly T[], rail: string): T[] {
  return rows.map((row) => ({ ...row, key: `${rail}:${row.key}` }));
}

/**
 * What a history shows after a read: a complete read is the history; an
 * incomplete one that brought nothing keeps the rows already shown (an empty
 * answer from a failed read is no evidence the payments are gone).
 */
export function keepRows<T>(shown: T[], read: T[], complete: boolean): T[] {
  return complete || read.length > 0 ? read : shown;
}

type Histories<C, B> = {
  evm: string | null;
  euro: C[];
  dollar: C[];
  bitcoin: { arkade: B[]; onchain: unknown[]; boarding: string; musig2: string } | null;
};

/**
 * The device copies shown while the histories are read again. A copy fills
 * only a history that has no rows yet; a history already holding rows (read
 * by an earlier contact while the book is open) is newer and is kept whole.
 */
export function seedFromCache<C, B, R extends Histories<C, B>>(
  shown: R,
  cached: Partial<Histories<C, B>>,
): R {
  const fill = <T>(rows: T[], copy: T[] | undefined) => (rows.length > 0 ? rows : (copy ?? []));
  const btc = shown.bitcoin;
  const copy = cached.bitcoin;
  return {
    ...shown,
    evm: shown.evm ?? cached.evm ?? null,
    euro: fill(shown.euro, cached.euro),
    dollar: fill(shown.dollar, cached.dollar),
    bitcoin: !copy
      ? btc
      : !btc
        ? copy
        : {
            ...btc,
            arkade: fill(btc.arkade, copy.arkade),
            onchain: fill(btc.onchain, copy.onchain),
          },
  };
}

/**
 * The Bitcoin device copies: the Arkade rows (kept under the boarding address)
 * and the onchain rows of the boarding AND the MuSig2 address, each kept under
 * its own address. Every onchain row keeps the address it was read for, which
 * is what classifies it. An unreadable copy is no rows.
 */
export async function cachedBitcoinHistory<A>({
  boarding,
  musig2,
  arkade,
  onchain,
}: {
  boarding: string;
  musig2: string;
  arkade: (address: string) => Promise<A[] | null | undefined>;
  onchain: (address: string) => Promise<AddressTx[] | null | undefined>;
}): Promise<{
  arkade: A[];
  onchain: { tx: AddressTx; address: string }[];
  boarding: string;
  musig2: string;
}> {
  const rowsOf = async (address: string) => {
    if (!address) return [];
    const txs = await onchain(address).catch((): null => null);
    return Array.isArray(txs) ? txs.map((tx) => ({ tx, address })) : [];
  };
  const [ark, own, multisig] = await Promise.all([
    boarding ? arkade(boarding).catch((): null => null) : Promise.resolve(null),
    rowsOf(boarding),
    musig2 && musig2 !== boarding ? rowsOf(musig2) : Promise.resolve([]),
  ]);
  return {
    arkade: Array.isArray(ark) ? ark : [],
    onchain: [...own, ...multisig],
    boarding,
    musig2,
  };
}
