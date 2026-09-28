#!/usr/bin/env node
//
// Regression self-check for lib/log. Imports the REAL module (re-implements
// nothing) via the same ".ts" resolve hook as scripts/log-dedup-check.mjs, so
// Node (>= 22.18, which strips TS types) can load the extensionless RN-style
// imports. lib/log only imports pure TS (./redact, ./fileEmoji), so it loads in
// plain node with no React Native.
//
// Run: node scripts/log-check.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const RESOLVE_HOOK = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as presolve } from "node:path";
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\\.[mc]?[jt]s$/.test(specifier)) {
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidate = presolve(base, specifier + ".ts");
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
    const indexCandidate = presolve(base, specifier + "/index.ts");
    if (existsSync(indexCandidate)) return next(pathToFileURL(indexCandidate).href, context);
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`);

const {
  logger,
  setLogLevel,
  getLogBuffer,
  clearLogBuffer,
  formatLine,
  emojiForSource,
  assertUniqueEmojis,
} = await import("../lib/log/index.ts");
const { normalizeCanonicalLine } = await import("../services/logging/DebugLogBuffer.ts");

// Capture console (write() reads the global each call, so override after import).
const printed = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
console.log = (l) => printed.push(["log", l]);
console.warn = (l) => printed.push(["warn", l]);
console.error = (l) => printed.push(["error", l]);
const reset = () => {
  printed.length = 0;
  clearLogBuffer();
};

try {
  // 1. Lines are never truncated — a cut-off txId costs a debugging round-trip.
  const line = formatLine(Date.now(), "🟠", "x".repeat(500));
  assert.ok(line.endsWith("x".repeat(500)), "line must carry the full message");

  const log = logger("services/bitcoin/BitcoinBalanceStore.ts");

  // 2. Secret material is redacted before it reaches console.
  reset();
  log.event('mnemonic="abandon abandon abandon ability able about"');
  assert.ok(!printed.some(([, s]) => /abandon/.test(s)), "mnemonic must be redacted");
  assert.ok(
    printed.some(([, s]) => /REDACTED/.test(s)),
    "redaction marker expected",
  );

  // 3. trace is muted at the default (event) level, but still buffered.
  reset();
  log.trace("internal step alpha");
  assert.equal(printed.length, 0, "trace must be muted at event level");
  assert.equal(getLogBuffer().length, 1, "trace must still be buffered");

  // ...and shown once level is trace.
  reset();
  setLogLevel("trace");
  log.trace("internal step beta");
  assert.equal(printed.length, 1, "trace must show at trace level");
  setLogLevel("event");

  // 4. An error always prints the first time; a retry loop repeating the same
  //    failure collapses instead of burying the timeline. The count is not
  //    lost — it resurfaces on the next window as `(×N seit HH:MM:SS)`.
  reset();
  log.error("boom");
  log.error("boom");
  log.error("boom");
  assert.equal(
    printed.filter(([lvl]) => lvl === "error").length,
    1,
    "first error prints, repeats within the window collapse",
  );
  assert.equal(getLogBuffer().length, 1, "collapsed repeats must not be buffered twice");

  // ...but a different error is never held back by another one's streak.
  reset();
  log.error("a different failure");
  assert.equal(printed.length, 1, "a distinct error must always surface");

  // 4b. log.for(id) tags every line so one grep returns a whole vorgang.
  reset();
  log.for("sk_9db090f4").event("refund attempted");
  assert.ok(
    printed.some(([, s]) => s.includes("id=sk_9db090f4")),
    "for(id) must tag the line with the correlation id",
  );
  assert.ok(
    printed.some(([, s]) => s.includes("refund attempted")),
    "for(id) must keep the message intact",
  );

  // 5. Duplicate events within the window print once.
  reset();
  log.event("same thing happened");
  log.event("same thing happened");
  assert.equal(printed.length, 1, "duplicate event must be suppressed");

  // 6. The line carries the file's emoji (identity).
  reset();
  log.event("hello world");
  assert.ok(/^\d\d:\d\d:\d\d\s+₿\s/.test(printed[0][1]), "line must start with the file emoji ₿");

  // 7. Every registered emoji is unique.
  const collisions = assertUniqueEmojis();
  assert.equal(collisions.length, 0, `emoji collisions: ${collisions.join(" | ")}`);

  // 8. Legacy src/op tags resolve to the file's emoji (whole-app per-file identity).
  assert.equal(
    emojiForSource("services/bitcoin/BitcoinBalanceStore.ts#applyArkadeBalance"),
    "₿",
    "full path → file emoji",
  );
  assert.equal(
    emojiForSource("AuthStateService#loadStoredState"),
    "🔐",
    "basename#fn → file emoji",
  );
  assert.equal(
    emojiForSource("WalletService.getNewAddress#000h"),
    "🪙",
    "op Module.fn → file emoji",
  );
  assert.equal(emojiForSource("index.bundle:103339#anonymous"), null, "minified frame → null");

  // 9. Already-canonical (| lvl=) lines render clean with per-file emoji — the
  // regression that made the whole app look unchanged (they passed through verbose).
  const verbose =
    "🔐 FLOW Auth State service load stored state succeeded. | lvl=INFO evt=FLOW grp=Auth scope=AuthStateService act=loadStoredState t=16:46:55.726 src=AuthStateService#loadStoredState op=AuthStateService.loadStoredState#0001";
  const rendered = normalizeCanonicalLine(verbose);
  assert.ok(!rendered.includes("| lvl="), "canonical line must not stay verbose");
  assert.match(
    rendered,
    /^16:46:55 {2}🔐 {2}Auth State service load stored state succeeded\.$/,
    "canonical → clean line with file emoji",
  );
  // Steady polls are muted at event level.
  const poll =
    "🌐 CALL GET arkade.computer/v1/indexer/vtxos ←200. | lvl=INFO evt=API grp=Network scope=vtxos res=ok ctx=system t=16:46:56.713 src=arkade.computer/v1/indexer/vtxos op=Network.fetch#000s";
  assert.equal(normalizeCanonicalLine(poll), "", "steady poll muted at event level");
} finally {
  Object.assign(console, orig);
}

console.log(
  "✅ lib/log self-check passed (no truncation · redaction · levels · dedup · identity · unique)",
);
