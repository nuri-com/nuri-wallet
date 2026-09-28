# Issue #1067: fix(android): Access wallet CTA can deadlock without opening an auth prompt

> Claimed by lennardevertz on 2026-08-13
> Branch: `wf/1067-android-access-wallet-deadlock`

## Summary
Move the lock-screen unlock orchestration out of `BiometricLockModal` into a testable `WalletAccessController` that allows exactly one in-flight ceremony, bounds every attempt with a deadline, abandons a hung keychain read so the next tap starts a fresh ceremony, drops stale completions, and returns a typed outcome the screen renders as localized error copy with an enabled retry. Passkey recovery now runs only from a deliberate user tap, never from the automatic attempt.

## Issue Description
Production Android: on the full-screen **Auf Wallet zugreifen / Access wallet** layer, tapping the CTA opens no Credential Manager / device-auth prompt and shows no feedback, so a signed-in wallet cannot be reached.

Source cause in `dev`:
- `components/BiometricLockModal.tsx:106-116` auto-runs `handleWalletAccess("auto")`, which sets `busy=true` before awaiting `unlockWalletKeys()` with no deadline.
- The CTA is `disabled={busy}` (`:145`), so a native promise that never settles leaves the only manual retry permanently disabled, with no error state.
- `lib/secureKeyStorage.ts:490-502` dedupes concurrent unlocks via `inFlightWalletUnlock`; a hung read is handed to every later caller, so even a re-enabled retry could not start a new ceremony.

Risk class: funds access / authentication / native Android. P0.

#### Acceptance criteria / Definition of done
- [x] An explicit tap starts exactly one protected read or recovery ceremony; overlapping taps cannot overlap ceremonies.
- [x] The auto attempt cannot leave the CTA disabled indefinitely — timeout/no-UI/hang returns an enabled retry with localized guidance.
- [x] Cancellation and lockout stay non-destructive and retryable; nothing is deleted, replaced, or signed out.
- [x] Passkey recovery runs visibly and only after a deliberate foreground tap (user activation), never from the auto attempt.
- [x] Same-wallet address check before writing recovered keys is untouched; wrong wallet writes nothing and shows actionable feedback.
- [x] Successful unlock still seeds the session cache and emits the wallet-unlocked signal exactly once via `unlockWalletKeys`.
- [x] Startup/resume still shows at most one ceremony (#687 not regressed): the auto attempt runs once, and a second ceremony is only possible after a bounded timeout plus a user tap.
- [x] Logs carry sanitized phase (`combined_read`, `passkey_recovery`, `timeout`, `cancel`, `provider_error`) and a bounded error class/code only — no messages, PRF bytes, credential IDs, or addresses.
- [x] Full `npm run check` passes on the candidate head.

## Tasks
1. [x] Add `abandonInFlightWalletUnlock()` to `lib/secureKeyStorage.ts` so a hung read cannot be re-served to later callers.
2. [x] Add `services/auth/WalletAccessController.ts`: single in-flight guard, per-attempt deadline, stale-completion drop, typed outcome, sanitized phase logging, injectable deps.
3. [x] Rewrite `components/BiometricLockModal.tsx` to render `idle | busy | error` from the controller outcome, keeping the CTA enabled whenever no ceremony is in flight.
4. [x] Add localized retry/cancel/passkey/wrong-wallet copy to `lib/i18n/en.ts` and `lib/i18n/de.ts`.
5. [x] Add `services/auth/WalletAccessController.test.ts` covering the eight contract states from the issue.
6. [x] Run `npm run check` and open a PR against `dev`.

## Progress Log
| Date | Agent | Task | Status | Notes |
|------|-------|------|--------|-------|
| 2026-08-13 | lennardevertz | 1-5 | Done | Controller extracted with 30s deadline; hung-read abandon added; modal renders typed outcomes; 8 regression tests added. |
| 2026-08-13 | lennardevertz | 6 | Done | `npm run check` green on candidate head; PR opened against `dev`. |
| 2026-08-13 | lennardevertz | Review | Done | Web shim mirrors `abandonInFlightWalletUnlock` (codex P1). |
| 2026-08-13 | lennardevertz | Review | Done | A successful read also retires the ones still running, so the race is safe in both orderings — a stale success followed by a live failure no longer wipes the session either. Symmetric regression added. |
| 2026-08-13 | lennardevertz | Review | Done | `recovery_required` is remembered, so the deliberate tap goes straight to the passkey instead of repeating a read already known to fail (two prompts from one tap). Cleared once access is restored. |
| 2026-08-13 | lennardevertz | Review | Done | An abandoned read no longer fails on the session's behalf: `abandonInFlightWalletUnlock` retires it by generation, so a late rejection cannot `clearPrivateKeyCache()` over the keys the retry installed. Real-path regression in `lib/secureKeyStorage.unlock.test.ts`. |
| 2026-08-13 | lennardevertz | Review | Done | The bounded-log contract now holds where the provider error is caught, not only above it: `errDescription` in `lib/errorMessage.ts` is the one decision, `secureKeyStorage`'s three keychain failure logs use it, and `lib/secureKeyStorage.logging.test.ts` proves it with the keychain itself throwing. |

## Handoff Notes
- Real Android device proof (cold launch, ≥60s background→resume, cancel→retry, provider-no-UI→timeout→retry, invalid combined entry→passkey recovery, wrong-wallet rejection, rapid taps) is **not** covered by this branch and is still required before release, per the issue's verification section.
- The error copy on the lock screen is a deliberate exception to the usual "no visible error text" rule: the issue's acceptance criteria require localized recoverable feedback plus an enabled retry.
- `WALLET_ACCESS_TIMEOUT_MS` is 30s: long enough that a presented system prompt is normally answered inside the window, short enough to unstick a provider that never shows UI. After a timeout the abandoned read may still land later; `unlockWalletKeys` will then notify and the layer closes as usual.
- OTA/fingerprint impact: JS/TS only, no native or Expo-config change — OTA-deliverable, no new runtime version.
- `deletePrivateKey` still hands the raw error to `errorWithId` (`lib/secureKeyStorage.ts:981`). It is a different ceremony from the protected read this issue covers, and it was left alone — worth its own pass if the bounded-log contract is to hold for the whole module.
