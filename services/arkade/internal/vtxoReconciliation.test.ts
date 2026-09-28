// The live bug: a wallet holding 3617 sats reported 4172, the difference being
// one cached 555-sat LNURL receive whose lockup was never funded. The SDK
// repository merges on save and never evicts, so the row outlived the invoice.
import { describe, expect, it, vi } from "vitest";

import { dropUnconfirmedVtxos, scriptsOfVtxos, vtxoOutpointKey } from "./vtxoReconciliation";

const SCRIPT = "512089ff53871e843246";

function vtxo(value: number, txid: string, script = SCRIPT) {
  return { txid, vout: 0, value, script, isPreconfirmed: true };
}

/** The four coins the indexer actually confirms for this wallet. */
const REAL = [
  vtxo(501, "c1ca9b2df188"),
  vtxo(499, "46a69ef299d2"),
  vtxo(1225, "e06ffe134857"),
  vtxo(1392, "79448a13d148"),
];

/** Flag-identical to a real coin — only the operator can tell them apart. */
const PHANTOM = vtxo(555, "deadbeefcafe");

function indexerReturning(rows: unknown[]) {
  return { getVtxos: vi.fn().mockResolvedValue({ vtxos: rows }) };
}

describe("vtxoOutpointKey", () => {
  it("keys a vtxo by txid:vout", () => {
    expect(vtxoOutpointKey({ txid: "aa", vout: 2 })).toBe("aa:2");
  });

  it("returns empty for rows that are not outpoint-shaped", () => {
    expect(vtxoOutpointKey({ txid: "", vout: 0 })).toBe("");
    expect(vtxoOutpointKey(null)).toBe("");
  });
});

describe("scriptsOfVtxos", () => {
  it("collects the distinct scripts, including contractScript", () => {
    expect(
      scriptsOfVtxos([
        vtxo(1, "aa"),
        vtxo(2, "bb"),
        { txid: "cc", vout: 0, contractScript: "5120ff" },
      ]),
    ).toEqual([SCRIPT, "5120ff"]);
  });
});

describe("dropUnconfirmedVtxos", () => {
  it("drops the cached row the indexer does not return", async () => {
    const indexer = indexerReturning(REAL);
    const result = await dropUnconfirmedVtxos([...REAL, PHANTOM], indexer);

    expect(result.reconciled).toBe(true);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedSats).toBe(555);
    expect(result.vtxos.reduce<number>((a, v) => a + (v as { value: number }).value, 0)).toBe(3617);
  });

  it("keeps every row when all are confirmed", async () => {
    const result = await dropUnconfirmedVtxos(REAL, indexerReturning(REAL));
    expect(result.droppedCount).toBe(0);
    expect(result.vtxos).toHaveLength(4);
  });

  it("asks only about the scripts it holds rows for", async () => {
    const indexer = indexerReturning(REAL);
    await dropUnconfirmedVtxos([...REAL, PHANTOM], indexer);
    expect(indexer.getVtxos).toHaveBeenCalledWith({ scripts: [SCRIPT] });
  });

  it("accepts a bare array response as well as {vtxos}", async () => {
    const indexer = { getVtxos: vi.fn().mockResolvedValue(REAL) };
    const result = await dropUnconfirmedVtxos([...REAL, PHANTOM], indexer);
    expect(result.droppedCount).toBe(1);
  });

  // Fail-open: a display bug beats a wallet that reads empty on a bad network.
  it("keeps everything when the indexer throws", async () => {
    const indexer = { getVtxos: vi.fn().mockRejectedValue(new Error("offline")) };
    const result = await dropUnconfirmedVtxos([...REAL, PHANTOM], indexer);

    expect(result.reconciled).toBe(false);
    expect(result.vtxos).toHaveLength(5);
    expect(result.droppedCount).toBe(0);
  });

  it("keeps everything when there is no indexer", async () => {
    const result = await dropUnconfirmedVtxos([...REAL, PHANTOM], null);
    expect(result.reconciled).toBe(false);
    expect(result.vtxos).toHaveLength(5);
  });

  it("keeps everything when the indexer answers empty", async () => {
    const result = await dropUnconfirmedVtxos([...REAL, PHANTOM], indexerReturning([]));
    expect(result.reconciled).toBe(false);
    expect(result.vtxos).toHaveLength(5);
  });

  it("keeps rows that carry no script, since they cannot be checked", async () => {
    const scriptless = { txid: "ffff", vout: 0, value: 42 };
    const result = await dropUnconfirmedVtxos([...REAL, scriptless], indexerReturning(REAL));
    expect(result.vtxos).toContain(scriptless);
  });

  it("is a no-op on an empty wallet", async () => {
    const indexer = indexerReturning(REAL);
    const result = await dropUnconfirmedVtxos([], indexer);
    expect(result.vtxos).toEqual([]);
    expect(indexer.getVtxos).not.toHaveBeenCalled();
  });
});
