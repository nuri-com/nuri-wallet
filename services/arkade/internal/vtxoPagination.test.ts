import { describe, expect, it } from "vitest";
import { INDEXER_VTXO_PAGE_CAP, installVtxoPaginationFix } from "./vtxoPagination";

const SCRIPT = `5120${"aa".repeat(32)}`;

type Vtxo = { txid: string; vout: number; value?: number };
type Page = { current: number; next?: number; total: number } | undefined;

function fakeProvider(responses: Array<{ vtxos: Vtxo[]; page?: Page }>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async getVtxos(opts: { scripts: string[]; pageIndex?: number; pageSize?: number }) {
      calls.push({ ...opts });
      return responses[Math.min(opts.pageIndex, responses.length - 1)];
    },
  };
}

const vtxoPage = (n: number, size: number, current: number, total: number) => ({
  vtxos: Array.from({ length: size }, (_, i) => ({ txid: `tx-${n}-${i}`, vout: 0 })),
  page: { current, total },
});

describe("installVtxoPaginationFix", () => {
  it("fetches every indexer page and returns one complete response (151 vtxos over 2 pages)", async () => {
    const provider = fakeProvider([vtxoPage(0, 100, 1, 2), vtxoPage(1, 51, 2, 2)]);
    installVtxoPaginationFix(provider);
    const result = await provider.getVtxos({ scripts: [SCRIPT], pageSize: 500 });
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0].pageSize).toBe(INDEXER_VTXO_PAGE_CAP);
    expect(provider.calls[1].pageIndex).toBe(1);
    expect(result.vtxos.length).toBe(151);
    const unique = new Set(result.vtxos.map((v) => v.txid));
    expect(unique.size).toBe(151);
  });

  it("dedupes the indexer's page-1 re-serve quirk (pageIndex=1 returns page 1 rows)", async () => {
    const provider = fakeProvider([
      vtxoPage(0, 100, 1, 3),
      { vtxos: vtxoPage(0, 100, 1, 3).vtxos.slice(0, 2), page: { current: 2, total: 3 } },
      vtxoPage(1, 51, 3, 3),
    ]);
    installVtxoPaginationFix(provider);
    const result = await provider.getVtxos({ scripts: [SCRIPT], pageSize: 500 });
    // page0(100) + re-serve(2 dupes dropped) + page1(51) = 151 unique
    expect(result.vtxos.length).toBe(151);
    const unique = new Set(result.vtxos.map((v) => v.txid));
    expect(unique.size).toBe(151);
    expect(provider.calls.length).toBe(3);
  });

  it("stops after the first response when the server returns no page metadata", async () => {
    const provider = fakeProvider([
      { vtxos: vtxoPage(0, 100, 0, 0).vtxos, page: undefined },
      { vtxos: vtxoPage(1, 37, 0, 0).vtxos, page: undefined },
    ]);
    installVtxoPaginationFix(provider);
    const result = await provider.getVtxos({ scripts: [SCRIPT], pageSize: 500 });
    expect(provider.calls.length).toBe(1); // unpaged endpoint: never re-fetch
    expect(result.vtxos.length).toBe(100);
    expect(result.page).toBeUndefined(); // metadata stripped so the SDK loop stops
  });

  it("stops on page metadata even when pages are full", async () => {
    const provider = fakeProvider([vtxoPage(0, 100, 1, 1)]);
    installVtxoPaginationFix(provider);
    const result = await provider.getVtxos({ scripts: [SCRIPT], pageSize: 500 });
    expect(provider.calls.length).toBe(1); // current(1) >= total(1) -> done
    expect(result.vtxos.length).toBe(100);
  });

  it("returns every row of an exact-pageSize aggregate and stops the SDK loop via stripped page metadata", async () => {
    // 5 full metadata pages = 500 unique rows = the SDK's closed-over
    // pageSize. The stock SDK evaluates `hasMore = page ? length===size :
    // false`; returning page: undefined stops the loop while all 500 rows
    // survive (no silent drop).
    const provider = fakeProvider([
      vtxoPage(0, 100, 1, 5),
      vtxoPage(1, 100, 2, 5),
      vtxoPage(2, 100, 3, 5),
      vtxoPage(3, 100, 4, 5),
      vtxoPage(4, 100, 5, 5),
    ]);
    installVtxoPaginationFix(provider);
    const result = await provider.getVtxos({ scripts: [SCRIPT], pageSize: 500 });
    expect(provider.calls.length).toBe(5);
    expect(result.vtxos.length).toBe(500);
    expect(result.page).toBeUndefined();
    const unique = new Set(result.vtxos.map((v) => v.txid));
    expect(unique.size).toBe(500);
  });

  it("passes explicit pageIndex > 0 through untouched (caller-driven pagination)", async () => {
    const provider = fakeProvider([vtxoPage(0, 5, 1, 3)]);
    installVtxoPaginationFix(provider);
    await provider.getVtxos({ scripts: [SCRIPT], pageIndex: 2, pageSize: 500 });
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].pageIndex).toBe(2);
    expect(provider.calls[0].pageSize).toBe(500); // not capped
  });

  it("is idempotent", () => {
    const provider = fakeProvider([{ vtxos: [], page: undefined }]);
    installVtxoPaginationFix(provider);
    const wrapped = provider.getVtxos;
    installVtxoPaginationFix(provider);
    expect(provider.getVtxos).toBe(wrapped);
  });
});
