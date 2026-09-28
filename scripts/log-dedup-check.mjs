#!/usr/bin/env node
//
// Regression self-check for the log-dedup logic in
// services/logging/DebugLogBuffer.ts (issue #640 — reduce log noise).
//
// Single source of truth: this script imports the real `buildRepeatKey` and
// `shouldSuppressRepeat` from DebugLogBuffer.ts — it re-implements nothing.
//
// Import mechanism: Node (>= 22.18) strips TypeScript types natively, but the
// app's module graph uses extensionless relative imports (RN/bundler style),
// which Node's resolver does not auto-extend. We register a tiny in-process
// module-resolution hook (via a data: URL, so this stays a single file) that
// appends ".ts" to extensionless relative specifiers. The hook does no logic —
// it only lets node load the real module. DebugLogBuffer.ts's transitive deps
// (config/constants, lib/compactWhitespace, lib/logShared) are pure TS with no
// React Native imports, so the module loads cleanly in plain node.
//
// Run: node scripts/log-dedup-check.mjs

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
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`);

const { buildRepeatKey, shouldSuppressRepeat, isPollClassLine, isCanonicalLine } = await import(
  "../services/logging/DebugLogBuffer.ts"
);

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// Production-shape arkade sign-trace line AS IT REACHES shouldSuppressRepeat —
// i.e. AFTER normalization. The raw line `🔐 [time ARKADE_SIGN_TRACE_V2_...]
// nuri_server_api=v4 step=...` has its `[time MARKER]` bracket stripped by
// stripLegacyPrefix, so the marker is GONE here and the leading word is
// sentence()-capitalized to `Nuri_server_api=`. The matcher must key on the
// surviving `nuri_server_api=` token, NOT the marker. (Deliberately NO marker
// in this string — that is the regression this test guards.)
const SRC = "src=services/arkade/internal/logging.ts#logArkadeWalletSignTrace";
// `durMs` defaults vary cycle-to-cycle in production (Date.now()-startedAt), so
// the fixture must be parameterized — a fixed value hid the bug where
// buildRepeatKey left `durMs=` un-normalized and every cycle keyed differently.
function traceLine(stage, durMs = 46) {
  return `🔐 STEP Nuri_server_api=v4 step=wallet_summary_step stage=${stage} durMs=${durMs}. | lvl=INFO evt=FLOW grp=General scope=Logging t=07:40:02.796 ${SRC}`;
}

const walletReady = traceLine("wallet_ready");
const balanceReady = traceLine("balance_ready");

// 0) The marker-less, normalized arkade line is still classified poll-class.
//    This is the core regression guard: immediate repeats are caught by BOTH
//    windows, so only direct classification proves the 35s window is applied.
check(
  isPollClassLine(walletReady) === true,
  "normalized (marker-less) arkade trace must be classified poll-class via nuri_server_api=",
);
check(
  isPollClassLine(
    `🌐 FLOW Some unrelated network line. | lvl=INFO evt=FLOW t=07:40:02.796 ${SRC}`,
  ) === false,
  "a non-poll line must NOT be classified poll-class",
);

// 1) First occurrence emits (not suppressed).
check(
  shouldSuppressRepeat(walletReady) === false,
  "first occurrence of wallet_ready trace must emit",
);

// 2) Immediate identical repeat is suppressed.
check(shouldSuppressRepeat(walletReady) === true, "immediate identical repeat must be suppressed");

// 2b) Same stage but a DIFFERENT durMs must collapse to the SAME repeat key —
//     otherwise the poll-suppression window never fires on the real trace, whose
//     durMs changes every cycle. (Regression: buildRepeatKey only normalized
//     `dur=…ms`, not `durMs=…`.)
check(
  buildRepeatKey(traceLine("wallet_ready", 46)) === buildRepeatKey(traceLine("wallet_ready", 91)),
  "same stage with different durMs must produce the SAME repeat key",
);

// 3) A changed value (stage=balance_ready) yields a different repeat key, so it
//    must emit even though it arrives immediately after.
check(
  buildRepeatKey(walletReady) !== buildRepeatKey(balanceReady),
  "changed stage must produce a different repeat key",
);
check(
  shouldSuppressRepeat(balanceReady) === false,
  "changed stage value must emit (not suppressed)",
);

// 4) WARN/ERROR are never suppressed — the INFO/DEBUG guard returns early.
const errorLine = `❌ FAIL Nuri_server_api=v4 step=wallet_summary_step stage=wallet_ready validation_error=1. | lvl=ERROR evt=API_ERR grp=General scope=Logging act=log t=07:40:03.001 dt=+0ms ${SRC}`;
check(shouldSuppressRepeat(errorLine) === false, "first ERROR line must emit");
check(shouldSuppressRepeat(errorLine) === false, "repeated ERROR line must never be suppressed");

// 5) Canonical recognition of the slim INFO/FLOW line (C4 suffix trim).
//    The trim drops `grp=`, `evt=FLOW`, and fallback `act=log`, but MUST keep
//    `lvl=` — DebugLogBuffer.isCanonicalLine only recognizes the readable format
//    via `| lvl=(DEBUG|INFO|WARN|ERROR|BUG)`. If `lvl=INFO` were dropped, the
//    line would miss the canonical path and get re-wrapped by the legacy parser
//    (re-adding `lvl=INFO`), defeating the trim. This guards that regression.
const slimInfoLine = `🧩 STEP Some story. | lvl=INFO scope=PriceService t=12:00:00.000 src=services/pricing/PriceService.ts#refresh`;
check(isCanonicalLine(slimInfoLine) === true, "slim INFO line (with lvl=) must be canonical");
check(
  isCanonicalLine(slimInfoLine.replace("lvl=INFO ", "")) === false,
  "the same line WITHOUT lvl= must NOT be canonical (the regression we guard)",
);

console.log(`LOG_DEDUP_CHECK_PASS checks=${checks}`);
