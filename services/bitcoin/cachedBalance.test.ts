import { describe, expect, it } from "vitest";

import { cachedBitcoinBalance } from "./cachedBalance";

const OWNER = "0xAbCdEf0000000000000000000000000000000001";
const OTHER = "0x9999999999999999999999999999999999999999";

const row = (amount: number, address: string | null = OWNER) => ({ amount, address });

describe("cachedBitcoinBalance", () => {
  it("restores the two rails as they were written", () => {
    // `total` is the ARKADE figure alone (BitcoinBalanceService), and the
    // onchain row stands beside it — never subtracted from it.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(25_000), onchain: row(75_000) }),
    ).toMatchObject({
      total: 25_000,
      byChannel: { onchain: 75_000, arkade: 25_000, lightning: 0 },
    });
  });

  it("shows an onchain-only wallet its balance", () => {
    // Arkade spent to zero: the onchain row is the only thing left that can be
    // shown before the network answers, and it must not become the headline.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(0), onchain: row(75_000) }),
    ).toMatchObject({
      total: 0,
      byChannel: { onchain: 75_000, arkade: 0, lightning: 0 },
    });
    // The same when no arkade row was ever written.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: null, onchain: row(75_000) }),
    ).toMatchObject({
      total: 0,
      byChannel: { onchain: 75_000, arkade: 0 },
    });
  });

  it("shows an arkade-only wallet its balance", () => {
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(21_000), onchain: null }),
    ).toMatchObject({
      total: 21_000,
      byChannel: { onchain: 0, arkade: 21_000 },
    });
  });

  it("states the onchain rail in its detail row too", () => {
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(1_000), onchain: row(40_000) })?.detail
        .onchain,
    ).toMatchObject({ confirmed: 40_000, unconfirmed: 0, txCount: 0 });
  });

  it("ignores rows another wallet wrote", () => {
    // #671's leak in cache form: the previous identity's figure must never be
    // this one's opening balance.
    expect(
      cachedBitcoinBalance({
        owner: OWNER,
        arkade: row(150_000, OTHER),
        onchain: row(50_000, OTHER),
      }),
    ).toBeNull();
    // A row that names no wallet cannot be claimed either.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(150_000, null), onchain: null }),
    ).toBeNull();
    // …and neither can any row when this session has no address yet.
    expect(cachedBitcoinBalance({ owner: null, arkade: row(150_000), onchain: row(1) })).toBeNull();
  });

  it("mixes a matching row with a mismatched one", () => {
    // Only the row this wallet wrote counts; the other is not there.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(150_000), onchain: row(50_000, OTHER) }),
    ).toMatchObject({ total: 150_000, byChannel: { onchain: 0, arkade: 150_000 } });
    // And the other way around: a foreign arkade row leaves the owned onchain
    // rail standing on its own.
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(150_000, OTHER), onchain: row(50_000) }),
    ).toMatchObject({ total: 0, byChannel: { onchain: 50_000, arkade: 0 } });
  });

  it("has nothing to show for an empty or unusable cache", () => {
    expect(cachedBitcoinBalance({ owner: OWNER, arkade: null, onchain: null })).toBeNull();
    expect(cachedBitcoinBalance({ owner: OWNER, arkade: row(0), onchain: row(0) })).toBeNull();
    expect(
      cachedBitcoinBalance({ owner: OWNER, arkade: row(Number.NaN), onchain: null }),
    ).toBeNull();
    expect(cachedBitcoinBalance({ owner: OWNER, arkade: row(-5), onchain: null })).toBeNull();
  });
});
