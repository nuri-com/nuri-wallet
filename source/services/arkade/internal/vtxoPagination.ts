// SDK pagination workaround for @arkade-os/sdk@0.4.62, implemented in our app
// code so the OTA fingerprint stays at the shipped-store value.
//
// Bug: `getAllNormalizedVtxos` decides `hasMore` with
// `vtxos.length === pageSize` where pageSize is the SDK-closed-over request
// size (default 500). The production indexer caps each page at 100 rows, so
// `100 === 500` is false and page 2 is never fetched. For accounts with >100
// vtxos the older (spent) rows never reach the local repository and the
// wallet summary over-reports the balance (real incident 2026-08-29:
// 31,597 sats shown vs 1,006 real).
//
// Fix: `installVtxoPaginationFix(indexerProvider)` wraps `provider.getVtxos`
// and makes it fetch EVERY indexer page for one SDK call, concatenating and
// deduping the rows before returning them as a single response. Page
// traversal follows the indexer-reported page metadata
// (`page.current < page.total`); a response without metadata is terminal
// (unpaged endpoint) and never re-fetched. Dedupe by `txid:vout` covers the
// server quirk of re-serving page-1 rows for `pageIndex=1`. Pages are paced
// with the SDK's original 500ms gap to stay under indexer rate limits.
//
// Returning one complete multi-page response stops the SDK loop on its
// first iteration: the aggregate carries `page: undefined`, so the stock
// `hasMore = page ? vtxos.length === pageSize : false` evaluates false on
// every aggregate — no follow-up request, no dropped rows.
// Every SDK-internal `getAllNormalizedVtxos` call goes through
// `provider.getVtxos`, so this one wrapper fixes sync, snapshot, history and
// summary paths at once.
//
// Remove this once the app depends on an SDK version whose
// `getAllNormalizedVtxos` paginates on page metadata natively.

type VtxoLike = {
  txid?: string;
  vout?: number;
  outpoint?: { txid?: string; vout?: number };
};

type IndexerPage = { current?: number; next?: number; total?: number };

type GetVtxosOpts = {
  scripts?: string[];
  pageIndex?: number;
  pageSize?: number;
  [key: string]: unknown;
};

type GetVtxosResult<V extends VtxoLike = VtxoLike> = {
  vtxos: V[];
  page?: IndexerPage;
};

export interface VtxoPaginationProvider {
  getVtxos(opts: GetVtxosOpts): Promise<GetVtxosResult>;
}

const INSTALL_FLAG = "__nuriVtxoPaginationFixInstalled";

// The production indexer caps each page at 100 rows regardless of the
// requested size. Discovered live against arkade.computer (2026-08-29).
export const INDEXER_VTXO_PAGE_CAP = 100;

// Hard ceiling on pages fetched per logical call. At 100 rows/page this
// covers 10,000 vtxos — far beyond any real wallet — and prevents an
// infinite loop if the server keeps reporting full pages with metadata that
// never advances.
const MAX_PAGES_PER_CALL = 100;

function outpointKey(vtxo: VtxoLike): string {
  return `${vtxo.txid ?? vtxo.outpoint?.txid}:${vtxo.vout ?? vtxo.outpoint?.vout}`;
}

/**
 * Wrap the indexer provider so stock-SDK `getAllNormalizedVtxos` receives
 * every indexer page in one response. Idempotent per provider instance.
 */
export function installVtxoPaginationFix<P extends VtxoPaginationProvider>(provider: P): P {
  const patchable = provider as P & { [INSTALL_FLAG]?: boolean };
  if (patchable[INSTALL_FLAG]) return provider;

  const originalGetVtxos = provider.getVtxos.bind(provider);
  patchable.getVtxos = async (opts: GetVtxosOpts): Promise<GetVtxosResult> => {
    // An explicit pageIndex > 0 means the caller drives pagination itself.
    // The SDK only reaches that branch after a first-page response it judged
    // incomplete — and this wrapper's aggregate always carries
    // page: undefined, which the stock SDK maps to hasMore=false, so the SDK
    // never emits pageIndex>0 on this path. The only real pageIndex>0
    // callers are surgical ones (e.g. refreshOutpoints by outpoints), which
    // must pass through untouched.
    if (typeof opts.pageIndex === "number" && opts.pageIndex > 0) {
      return originalGetVtxos(opts);
    }

    const requestedPageSize =
      typeof opts.pageSize === "number" && opts.pageSize > 0
        ? opts.pageSize
        : INDEXER_VTXO_PAGE_CAP;
    const fetchSize = Math.min(requestedPageSize, INDEXER_VTXO_PAGE_CAP);

    const seen = new Set<string>();
    const all: VtxoLike[] = [];
    const appendDeduped = (rows: VtxoLike[]) => {
      for (const vtxo of rows) {
        const key = outpointKey(vtxo);
        if (!seen.has(key)) {
          seen.add(key);
          all.push(vtxo);
        }
      }
    };
    let lastPage: IndexerPage | undefined;
    for (let page = 0; page < MAX_PAGES_PER_CALL; page += 1) {
      const result = await originalGetVtxos({
        ...opts,
        pageIndex: page,
        pageSize: fetchSize,
      });
      const rows = Array.isArray(result?.vtxos) ? result.vtxos : [];
      // Treat explicit null the same as absent metadata (unpaged endpoint).
      lastPage = result?.page ?? undefined;
      appendDeduped(rows);
      // No page metadata: the endpoint does not paginate for this query
      // shape (or ignores pageIndex). Terminate after this one response —
      // continuing would re-fetch the same first page up to the ceiling.
      if (lastPage === undefined) break;
      const metadataSaysMore =
        typeof lastPage.current === "number" &&
        typeof lastPage.total === "number" &&
        lastPage.current < lastPage.total;
      if (!metadataSaysMore) break;
      // Match the SDK's original pacing between pages (500ms) so large
      // wallets don't hammer the indexer with back-to-back requests.
      await new Promise((r) => setTimeout(r, 500));
    }

    // Force the outer SDK loop to stop after this aggregate response: the
    // stock check is `hasMore = page ? vtxos.length === pageSize : false`,
    // so returning page: undefined forces hasMore=false on every aggregate,
    // including an exact-boundary aggregate whose length equals the SDK's
    // closed-over pageSize. No row is ever dropped.
    return { vtxos: all, page: undefined };
  };
  patchable[INSTALL_FLAG] = true;
  return provider;
}
