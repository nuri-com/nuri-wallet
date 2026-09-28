# Incident 2026-09-17: Android web signup dead — WebAuthn ceremony that never settled

## Summary
On `app.nuri.com`, "Create Passkey Wallet" completed the Google passkey sheet,
returned to the page, and then did nothing: no redirect, no error, the button
greyed out permanently. No wallet was created. `createWalletPasskey` discarded
the PRF that `create()` had already returned and fired a second ceremony — a
`get()` naming the just-created credential in `allowCredentials`. On Android
Chrome that call **never settles**, so the promise the UI awaited never
resolved or rejected. Sign-in was unaffected because it passes an empty
`allowCredentials`. iOS and desktop were unaffected entirely.

## Impact
- Complete signup outage for Android web users. No new wallet could be created
  on `app.nuri.com` from any Chromium browser on Android.
- Duration unknown at the low end — the second ceremony predates this session
  and the failure produced no error, no log line and no network request, so
  nothing recorded it. Fixed and live 2026-09-17 09:46 UTC.
- No funds at risk. The failure was before any key reached a server; users who
  hit it simply had no wallet.
- Each failed attempt left an orphan passkey registered for `nuri.com`. The
  test device accumulated nine.

## Timeline (2026-09-17, UTC, measured over CDP on a Galaxy S21, Android 15,
Chrome 153.0.8010.36, against live `app.nuri.com`)
```
07:56  page load; tap Create Passkey Wallet → sheet → PIN → back to page
       nothing logged, button disabled
08:01  instrumented repeat:
       create() called  rp=nuri.com alg=-7 ext=[prf]
08:01  create() RESOLVED in 39310 ms  ext={"prf":{"enabled":true,"results":{"first":…}}}
08:01  get() called  rpId=nuri.com allow=1 ext=[prf]
       → +60 s and beyond: no UI, no resolve, no reject
08:20  any later WebAuthn call → OperationError: A request is already pending.
08:24  PRF from create() proven byte-identical to PRF from get()
08:49  fix served from passkey.nuri.com; signup reaches the username screen
08:53  username claim hangs at the same call site; second fix
08:57  full signup completed to the wallet screen on device
09:46  deployed to app.nuri.com as 92a8f39a
```

## Root causes
1. **The second ceremony was unnecessary.** `create()` already returns
   `prf.enabled: true` with `results.first`; the code threw it away and asked
   again. The comment justifying that ("PRF results are not reliably returned
   at create() time across platforms") was no longer true for Android.
2. **Android Chrome never settles a `get()` with a non-empty
   `allowCredentials`.** No UI, no resolve, no reject; its own `timeout` is
   ignored; `AbortController.abort()` does not release it; `transports` hints
   only convert the hang into an instant `NotAllowedError`. The hung request
   then fails every later WebAuthn call on the page with
   `OperationError: A request is already pending` until a reload.
3. **Nothing in the app puts a deadline on a WebAuthn call.** `runNativeCreate`
   sets `setBusy(true)` and clears it in the promise's continuation, so a
   promise that never settles disables the button forever with no error path.
4. **The same call shape existed at a second site** — the username claim via
   `getWalletPasskeyPrfAssertion({ credIdB64u })` — and failed the same way
   once the first fix let users reach it.

## Why nothing caught it
- **Sign-in worked**, because "Use existing Passkey" passes an empty
  `allowCredentials`. The obvious smoke test passed.
- **iOS worked**, so the flow looked healthy on the device most testing happens
  on. The bug is Android-only.
- **Unit tests passed and always will.** A mocked `credentials.get()` resolves.
  No test can express "the browser abandons this promise", so no amount of unit
  coverage would have found it.
- **There was nothing to report.** No exception, no console error, no failed
  request — only a button that stopped responding. Users experience that as
  "the app is broken", not as an error worth reporting.

Measured, first call on a fresh page, real user gesture:

| `allowCredentials` | result |
|---|---|
| `[{id}]` | never settles, page bricked |
| `[{id, transports:['internal']}]` | instant `NotAllowedError`, no UI |
| `[]` (discoverable) | resolves, sheet appears |
| `abort()` on the hung call | no effect, stays pending |

## The fix
PR #1373, merged as `92a8f39a`, live on `app.nuri.com`.

1. `createWalletPasskey` uses the PRF from `create()`; the second ceremony is
   gone. Providers that omit PRF at create time keep the assertion fallback.
2. `getAssertion` sends no `allowCredentials` on Android and pins the result by
   comparing `rawId` to the requested credential id, so a different passkey can
   never be accepted silently.
3. Everywhere else the exact credential id is still sent — iOS and desktop
   settle these calls fine and the user sees no chooser.

## The invariant this turned on
Skipping the second ceremony is only safe if the PRF from `create()` equals the
PRF from an assertion. Every Nuri key derives from that value — bitcoin,
ethereum, nostr, arkade client signer — so a mismatch would mean signup and
sign-in derive different wallets for the same passkey. Measured on device:

```
credential q8Ae7wF4-oRpJg0LKNABqg · salt nuri-prf-salt-v1 · rpId nuri.com
create()  → 4yP23r…<redacted>
get() #1  → 4yP23r…<redacted>
get() #2  → 4yP23r…<redacted>
```

A second, independent credential matched the same way
(`WXeVMq…<redacted>` from both paths).

`services/auth/PasskeyPrfDerivation.test.ts` pins the salt and RP ID literals
and the byte pass-through. `docs/passkey-prf.md` documents the device check
that unit tests cannot replace. Neither may be skipped.

## Verification
Full signup driven end to end on the Galaxy S21 against the fix:
```
10:55:54  wallet passkey metadata {"isNew":true,"hasCredId":true,"hasCredPub":true}
10:55:54  Completed PRF bootstrap  bitcoin bc1puf64...982kq3  ethereum 0x12C5bd...F2CA14
10:57:07  claiming username=claudetest1056
10:57:14  claim ok username=claudetest1056
10:57:15  Wallet summary ready — 0 sats, 0 vtxos
```
iOS Safari ran the same flow on a tester's own device. Live bundle on
`app.nuri.com` confirmed as `index-f5eab30abc48b7d47db9fb3e511b449c.js`,
SHA-256 `f4a078c0…ecc8e2b2`, containing the fix.

## Second failure the same day: the deploy went red on a correct deploy
The deploy of `92a8f39a` reported failure:
```
success  Deploy exact commit
failure  Verify production manifest and asset hash   ← homepage asset differs from candidate
skipped  Create release tag pinned to commit
```
Production was correct. The verify step retried the manifest check 12 times
over a minute, but the two checks below it — homepage entry point and served
asset hash — sat **outside** that loop and ran exactly once, 22 seconds after
the deploy. Cloudflare had already flipped `/deployment.json` while `/` at that
PoP still served the previous entry point.

Contributing: the previously live commit `b5185c38` predates PRs #1358 and
#1360, so the `no-store` cache policy for `/`, `/index.html`,
`/deployment.json` and the service worker went live for the first time *with*
this deploy. The edge was holding HTML cached under the old policy; the fix for
that was in the payload being deployed. One-time transition.

Consequence: a real deploy has **no release tag**, because the tag step only
runs after verification. PR #1376 (`ae28674f`) puts all three checks in one
retry loop and names the failing check on every attempt.

## A red workflow run is not a failed deploy
This cost real confusion on the day: the Actions run said failure, the fix was
live the whole time, and there was no way to tell them apart from the run page.
`Deploy exact commit` is the step that changes production. Everything after it
only observes. So check production directly rather than trusting the run's
colour:

```bash
curl -s https://app.nuri.com/deployment.json        # source_sha + asset + deployed_at
curl -s https://app.nuri.com/ | grep -o 'index-[a-f0-9]*\.js'   # what the page loads
curl -s https://app.nuri.com/<asset> | shasum -a 256             # must equal asset_sha256
```

Confirmed for this deploy at 2026-09-17: `source_sha` `92a8f39a` (the fix
merge), homepage loading `index-f5eab30abc48b7d47db9fb3e511b449c.js`, measured
SHA-256 matching `asset_sha256`, and the live bundle containing the string
`assertion_credential_mismatch` and `/Android/.test` — neither of which exists
in the previous live commit `b5185c38`, whose `getAssertion` still read
`allowCredentials: allowList(opts.credIdB64u)`, the exact shape that hangs.

What a red run *does* cost, even when production is fine: the release tag is
skipped, so the deploy is recorded nowhere. That is why `92a8f39a` has no
`pwa-<timestamp>` tag.

## Follow-ups
- **Orphan passkeys.** Failed ceremonies leave registered credentials behind.
  Either they should not be created before the flow can succeed, or the app
  should clean them up.
- **No watchdog on WebAuthn.** Nothing in the app puts a deadline on these
  calls. A promise that never settles still hangs whatever awaits it — this
  class of failure can recur at any other call site.
- **Silent busy state.** `setBusy(true)` with no timeout and no error path is
  why this read as "nothing happens" rather than a failure. A busy state that
  can never end should surface something.
- **No Android in the test loop.** The bug was Android-only and invisible on
  iOS. Signup on a real Android device belongs in the pre-deploy checklist.
- **Two prompts on sign-in.** Restoring a wallet asks twice: once for PRF, once
  for the signed server challenge. `getWalletPasskeyPrfAssertion` already does
  both in one ceremony, but using it on sign-in needs the challenge fetched
  before the ceremony, which needs the credential id up front.
- **`pubKeyCredParams` omits RS256.** Chrome warns about it. Not the cause here,
  but worth a decision.
