import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logging", () => ({ emitTrace: vi.fn(), logArkadeWalletSignTrace: vi.fn() }));

import { buildArkadeOnchainProvider, resolveArkadeEsploraUrl } from "./esploraFailover";
import { FailoverOnchainProvider } from "./failoverOnchainProvider";

const MEMPOOL = "https://mempool.space/api";
const BLOCKSTREAM = "https://blockstream.info/api";

const answers = (hosts: string[]) =>
  vi.fn(async (url: string) => {
    if (hosts.some((host) => String(url).startsWith(host))) return { ok: true } as Response;
    throw new TypeError("Network request timed out");
  });

beforeEach(() => {
  vi.stubGlobal("fetch", answers([MEMPOOL, BLOCKSTREAM]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveArkadeEsploraUrl", () => {
  it("keeps the preferred host when it answers", async () => {
    expect(await resolveArkadeEsploraUrl(MEMPOOL)).toBe(MEMPOOL);
  });

  // The SDK keeps one Esplora for the wallet's life and every send consults it,
  // so an unreachable host does not degrade sending — it stops it.
  it("hands over the fallback when the preferred host does not answer", async () => {
    vi.stubGlobal("fetch", answers([BLOCKSTREAM]));

    expect(await resolveArkadeEsploraUrl(MEMPOOL)).toBe(BLOCKSTREAM);
  });

  // Both down is the network being down. Pinning the wallet to a second
  // unreachable host buys nothing and loses the preferred one.
  it("keeps the preferred host when nothing answers", async () => {
    vi.stubGlobal("fetch", answers([]));

    expect(await resolveArkadeEsploraUrl(MEMPOOL)).toBe(MEMPOOL);
  });

  // The fallback is mainnet's. A signet or regtest wallet must never be handed
  // it, however unreachable its own host is.
  it("never swaps hosts for another network", async () => {
    vi.stubGlobal("fetch", answers([]));

    expect(await resolveArkadeEsploraUrl("https://mutinynet.com/api")).toBe(
      "https://mutinynet.com/api",
    );
  });

  it("passes through a missing host untouched", async () => {
    expect(await resolveArkadeEsploraUrl(null)).toBeNull();
  });
});

describe("buildArkadeOnchainProvider", () => {
  it("returns nothing when there is no host", () => {
    expect(buildArkadeOnchainProvider(null)).toBeUndefined();
    expect(buildArkadeOnchainProvider("")).toBeUndefined();
  });

  // The boot probe cannot see a host that answers and THEN rate-limits, which
  // is mempool's actual failure mode (per-IP 429 bursts). The wallet keeps one
  // provider for its whole life, so the recovery has to live inside it.
  it("wraps mainnet in a failing-over pair", () => {
    const provider = buildArkadeOnchainProvider(MEMPOOL);

    expect(provider).toBeInstanceOf(FailoverOnchainProvider);
    expect((provider as FailoverOnchainProvider).activeLabel).toBe("mempool.space");
  });

  // Already moved to the fallback at boot: mempool is still the other host and
  // is still worth retrying against.
  it("keeps the pair when the resolved host is already the fallback", () => {
    const provider = buildArkadeOnchainProvider(BLOCKSTREAM);

    expect(provider).toBeInstanceOf(FailoverOnchainProvider);
    expect((provider as FailoverOnchainProvider).activeLabel).toBe("blockstream.info");
  });

  it("never pairs a non-mainnet host with the mainnet fallback", () => {
    expect(buildArkadeOnchainProvider("https://mutinynet.com/api")).not.toBeInstanceOf(
      FailoverOnchainProvider,
    );
  });
});
