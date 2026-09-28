# lib/log — small, reusable, SMS-safe logging

Logs are debug tool #1: reconstruct how the user moved through the app and find
every failure. This module is the whole logger — portable to any app (depends
only on `Date` + `console`). To reuse elsewhere, copy `lib/log/` and edit
`fileEmoji.ts`.

## The line

```
14:24:58  🔓  Claim done — JdNfLUBSaZUD settled in 5.1s
```

`HH:MM:SS  <emoji>  <one sentence>`, **never truncated** — a cut-off txId or
error message costs a debugging round-trip. `redact()` is what keeps key
material out, not a length cap. The emoji is
the source **file** — see it, know who fired it; grep it in code to land there.

## Use it

```ts
import { logger } from "../log"; // adjust the relative path

const log = logger("services/arkade/ArkadeReceiveUnlockService.ts");

log.event(`Receive claim started — swap ${id}, ${sats} sats`);
log.user(`User tapped "Claim" in Bitcoin receive`);
log.trace("vtxos_ready count=2");                 // muted unless level = trace
log.warn("Auto-claim skipped — VHTLC already spent");
log.error("Subscription lost — reconnecting", err); // always prints; err appended + redacted
```

The `file` key is a real source path (survives minification) → no
`index.bundle#anonymous`, no per-call stack walk.

## Levels (`setLogLevel`)

| level  | console shows                                   |
| ------ | ----------------------------------------------- |
| `trace`| everything (deep debug for one flow)            |
| `event`| **default** — user actions, calls, changes, errors |
| `warn` | warnings + errors only (quietest)               |

`event`/`user` = the timeline. `warn`/`error` always print — never gated by
level; repeats collapse (see below). `trace` is muted by default; it's still written to the buffer so a
support dump keeps the detail.

## Rules baked in

- **No truncation** ever; `redact.ts` (lifted verbatim) runs on every message
  and is the only thing that gates content.
- **Content dedup**: the same `emoji + sentence` within 4s prints once (kills a
  line fired from 3 sources within ms).
- **Repeat collapse** on `warn`/`error`: a retry loop firing the same failure
  every tick prints once, then once a minute as `(×24 seit 17:29:07)`. The first
  occurrence is never delayed and a *different* error never waits behind it.
- **Never throws** into the app; a broken buffer listener can't break logging.

## Sentence style (house voice — all files read the same)

- Past tense, subject first: `User tapped …`, `Claim done — …`.
- One clause. Prose by default; drop to compact tokens (`→ 200  645ms`) only
  when a full sentence would exceed ~120 chars.
- Thousands separators for money: `9,975 → 13,023 sats`, `€54,252`.
- Pair prompt→result **only** for security/consent touchpoints (Face ID,
  send-approval, TOS); single line for everything internal.

## Correlation id

One vorgang — a swap, an order, a claim — spans several files and therefore
several emojis. Without a shared id you reconstruct it from timestamps.

```ts
const l = log.for(txId);          // every line gains ` id=<txId>`
l.event("Refund attempted");
l.error("Refund failed", err);
```

Then one grep returns the whole story: `grep 'id=sk_9db09' metro.log`.

## Emoji identity (`fileEmoji.ts`)

One map, `path → emoji`, unique per file, themed by domain. Add a file = add a
new unique emoji. `assertUniqueEmojis()` returns collisions (call once at
startup); `emojiFor` warns once for any unregistered file.

## Buffer API

`getLogBuffer(limit?)`, `clearLogBuffer()`, `subscribeLogBuffer(fn)`,
`setLogBufferCap(n)` — for support dumps and in-app log viewers.

## Check

`node scripts/log-check.mjs` — asserts the 160 cap, redaction, level gating,
dedup, and emoji identity against the real module.
