import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ESPLORA_FALLBACK_API_BASE_URL, MEMPOOL_API_BASE_URL } from "../config/endpoints";

// The web build's CSP is an allow-list, and a host missing from it fails ONLY on
// the web and ONLY when that code path runs. The Esplora fallback is the worst
// case of that: it is dead code until the primary breaks, so a missing entry is
// invisible in every test and every native build, and then turns the failover
// into a second failure at exactly the moment it was supposed to help.
//
// This asserts the endpoints the app actually reaches are declared. It is a
// cheap guard against re-introducing a host the page can never talk to.
const csp = (() => {
  const html = readFileSync(path.join(__dirname, "index.html"), "utf8");
  const match = html.match(/Content-Security-Policy"\s*\n?\s*content="([\s\S]*?)"/);
  if (!match) throw new Error("no Content-Security-Policy meta tag in public/index.html");
  return match[1];
})();

const connectSrc = (() => {
  const match = csp.match(/connect-src([\s\S]*?);/);
  if (!match) throw new Error("no connect-src directive in the page CSP");
  return match[1];
})();

const originOf = (apiBaseUrl: string) => new URL(apiBaseUrl).origin;

describe("public/index.html connect-src", () => {
  it("allows the primary Esplora", () => {
    expect(connectSrc).toContain(originOf(MEMPOOL_API_BASE_URL));
  });

  // The regression: blockstream.info was the configured fallback for both the
  // Arkade SDK's provider and BlockchainService, and was absent here, so every
  // failover attempt died as "Refused to connect" and the boarding read that
  // the Arkade claim depends on had no way to recover from a mempool 429.
  it("allows the FALLBACK Esplora, which only a failure path ever reaches", () => {
    expect(connectSrc).toContain(originOf(ESPLORA_FALLBACK_API_BASE_URL));
  });

  it("keeps the wallet's own backends allowed", () => {
    for (const origin of [
      "https://arkade.nuri.com",
      "https://arkade.computer",
      "https://swapkit.nuri.com",
    ]) {
      expect(connectSrc).toContain(origin);
    }
  });

  it("does not open connect-src to every https host", () => {
    // The directive is the reason a stolen key cannot be POSTed anywhere; a
    // bare `https:` would defeat it entirely.
    // A bare `https:` scheme source (not `https://host`) would allow every
    // host; assert none of the sources is scheme-only.
    const sources = connectSrc.split(/\s+/).filter(Boolean);
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
    expect(sources.filter((source) => source.includes("*"))).toEqual([
      // The only wildcard: Alchemy's per-key RPC subdomains.
      "https://*.g.alchemy.com",
    ]);
  });
});
