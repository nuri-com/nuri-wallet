# Issue #1061: Production logout and passkey account switching

> Claimed by ubuntu on 2026-08-12
> Branch: `wf/1061-production-logout-and-passkey-account-sw`

## Summary
Puts logout behind the home greeting's existing eight-tap gesture: in a dev build it opens the debug hub as before, in a production build it opens an explicit confirm sheet before any teardown. No new visible chrome. Confirming calls the canonical `performSoftLogoutForRelogin()` **once**, with no `preserveHint`, through a new `services/app/UserLogoutService.ts` boundary that owns the exactly-once guard and surfaces a recoverable failure instead of falsely reporting success. Closes #671's isolation concern for this path by clearing `@auth:previous_addresses` on hint-less (account-switch) logouts while preserving it on hint-preserving same-user relogins.

## Issue Description
#### Goal and why

Add one explicit, safe **Log out / Switch passkey** action to the production app so a signed-in user can return to passkey onboarding and then sign in with either the same passkey or a different one.

This is uncommon for ordinary users but essential for developers and QA validating production behavior. It is also a legitimate account-switch/recovery control: reinstalling the app, chat deep links, or hidden debug/reset tooling must not be the only route.

This is the **single canonical issue** for the production logout/passkey-switch gap. Duplicate issue #1059 is superseded by this issue.

#### Consolidated evidence and prior findings

##### Production/Buzz findings (2026-08-12)

- Production Android `0.93.0` (`versionCode 29633138`, Play Store) has no working logout path. Emin's agent verified this against the installed production APK/Hermes bytecode.
- `nuri://factory-reset?name=Log+out` does **not** perform a reset. `App.tsx` only sets app-lock/biometric-lock state; `lib/internalLinks.ts` drops the query; the route opens the Access wallet path and `?name=Log+out` is ineffective.
- The former protected Delete-wallet flow was removed by commits `29a5902f` and `694c37de` and first disappeared in `v0.90.0`; `components/BiometricLockModal.tsx` documents that removal.
- Even before removal, commit `b2e3d27d` did not make the chat link wipe immediately: it opened a protected flow requiring an explicit **Delete wallet** tap and a cancellable 21-second wait.
- The canonical full wipe still exists in `FactoryResetService`, but its remaining Debug Hub entry is unavailable in production behind `DEBUG_UI_ENABLED`.
- Without an OTA, the observed Android workaround was backup wipe plus uninstall. That is evidence of the missing product flow, not the desired implementation: Android backup can restore local AsyncStorage, while the provider-held passkey remains outside app storage and same-passkey recovery deterministically restores the wallet.
- Emin's agent recommended restoring the protected flow rather than a direct wipe. This canonical issue preserves its safety finding (explicit confirmation; never direct destructive deep-link wipe) but chooses a normal production-visible **soft logout / switch passkey** action instead of restoring destructive Delete wallet as logout.

##### Current implementation boundary

Current `dev` already contains the teardown primitive:

- `services/app/SoftLogoutService.ts` exports `performSoftLogoutForRelogin()`.
- It clears auth state, private keys, third-party sessions, in-memory signing state, account-leaky caches, pending purchases/orders, notification registration/storage, and reloads the app.
- Calling it **without** `preserveHint` returns to a neutral welcome screen and permits selecting another passkey.
- `services/app/FactoryResetService.ts` remains a separate destructive reset boundary and must not be presented as ordinary logout.

##### Related work — not duplicates

- #671: migration metadata omitted from reset/logout wipes. Its isolation concern must be resolved or explicitly incorporated here; do not close it merely because this UI entry is added.
- #866: v1 legacy recovery branch and destructive factory-reset semantics; separate legacy scope.
- #579: removal of automatic logout; separate behavior.
- #386: historical debug-hub access; not a supported production logout flow.
- PR #1032 contains broader web/session work and mentions sign-out, but does not replace this focused native production task.

#### Product decision

Implement a **normal production-visible account/settings action**, not a hidden developer-only control. The action is **Log out / Switch passkey** and uses soft logout. Keep **Factory Reset** separate and explicitly destructive.

Priority recommendation: **P2: medium** — important for repeatable production QA and account isolation, but not currently blocking ordinary wallet use. Escalate if support confirms users are stranded in the wrong account.

#### Required behavior

1. Add a production-visible **Log out / Switch passkey** action in the appropriate account/settings surface, without requiring a debug menu or chat link.
2. Before teardown, show clear confirmation explaining that:
   - local Nuri session/key material will be removed from this device;
   - the passkey is managed by the OS/password manager and is not deleted;
   - funds and remote accounts are not deleted;
   - wallet access requires a usable PRF-capable passkey again.
3. Cancellation leaves the active session untouched.
4. On confirmation, invoke the canonical soft-logout boundary exactly once with **no preserved credential hint**, then reload into neutral passkey onboarding.
5. The user can sign back in with the same passkey or select another passkey.
6. A different passkey must never rehydrate or briefly display the previous wallet's keys, Wirex session/account snapshot, balances, cards/IBAN, Arkade state, pending flows, push registration, Nostr/account identity, or UI stores.
7. A partial teardown or verification failure must fail visibly and must not claim successful logout while critical old identity material remains.
8. Factory Reset remains a separate, explicitly destructive action. Do not restore direct deep-link wipe behavior.

#### Scope

- Production account/settings UI and localized copy.
- Reuse/harden `performSoftLogoutForRelogin()` as necessary for this user-triggered path.
- Resolve or explicitly account for #671's migration-identity isolation concern.
- Focused tests for confirmation, cancellation, exactly-once teardown, teardown failure, clean relaunch, and account isolation.
- Android and iOS production-build verification for same- and different-passkey relogin.
- Documentation for the production action and the soft-logout/factory-reset distinction.

#### Non-goals

- Deleting/revoking a passkey in iCloud Keychain, Google Password Manager, Bitwarden, or another provider.
- Deleting funds, closing Nuri/Wirex accounts, or erasing server-side history.
- Weakening passkey, PRF, WebAuthn, app-lock, or signer validation.
- Replacing the existing factory-reset/recovery flow.
- Merge, release, OTA publication, store submission, or production rollout.

#### Acceptance criteria

- [ ] A signed-in production user can find and trigger **Log out / Switch passkey** without a debug menu or deep link.
- [ ] Confirmation distinguishes local logout from passkey deletion, account closure, and factory reset.
- [ ] Cancel performs no teardown and preserves the active session.
- [ ] Confirm calls the canonical soft-logout service exactly once, without `preserveHint`, and returns to neutral passkey onboarding.
- [ ] Same-passkey relogin restores the same wallet/account successfully.
- [ ] A → logout → B → logout → A works without reinstall/factory reset and never leaks or flashes state from the other account.
- [ ] The OS/password-manager passkeys remain intact after logout.
- [ ] A forced partial-wipe/verification failure shows a recoverable error and does not falsely report logout success.
- [ ] #671's migration metadata boundary is covered by implementation/tests or closed separately with linked proof.
- [ ] Localized copy uses `@ds` components/tokens.
- [ ] Focused tests and full `npm run check` pass on the exact candidate head.
- [ ] Android and iOS production-build QA evidence covers same-passkey and two-account switching.
- [ ] Independent exact-head security review confirms key/session/cache isolation and no authentication-boundary weakening.
- [ ] Documentation explains the production action and why Factory Reset remains separate.

#### Owning repository and base branch

`nuri-com/nuri-expo @ dev`

#### Risk class

Native / identity-bound local state

#### Role

Implementer

#### Authority

May modify only the production account/settings logout UI, localized copy, the existing soft-logout integration/hardening required by this path, focused tests, and related documentation/workflow metadata on an isolated branch from current `dev`. May open a PR targeting `dev`. Must not weaken authentication, delete provider-managed passkeys, close accounts, merge, publish OTA, build/submit a release, deploy, or mutate production.

#### Responsibility

Deliver a minimal production-accessible logout/passkey-switch flow that safely tears down the old local identity and proves isolation for same-passkey and different-passkey relogin.

#### Accountability evidence

Exact base/head SHAs, scoped diff, focused test output, full `npm run check`, Android/iOS production-build screen evidence, sanitized logs showing teardown/relaunch boundaries, A → B → A isolation evidence, CI status, and independent exact-head review.

#### Release and documentation evidence

The implementation PR must classify OTA/native fingerprint impact against its target release. No release or deployment is authorized here. Update account/settings documentation and `docs/codebase.md` if the production surface or logout contract changes.

#### Ready contract

- [x] Scope, authority, acceptance, verification, and evidence requirements are bounded and executable.
- [x] Duplicate issue and conversation findings are consolidated here.
- [x] Related but distinct issues are identified rather than incorrectly closed.
- [x] No unresolved product or security decision is hidden in the task.


## Tasks

1. **`services/app/UserLogoutService.ts` (new)** — user-triggered logout boundary. Module-level in-flight guard so a double tap cannot start two teardowns; calls `performSoftLogoutForRelogin()` with **no** `preserveHint`; returns `"started" | "in-flight" | "failed"` and never swallows the keychain-residual abort into a success.
2. **`services/auth/AuthStateService.ts`** — add `clearPreviousAddresses()` so the `@auth:previous_addresses` key stays owned by its module.
3. **`services/app/SoftLogoutService.ts`** — on a wipe with no `preserveHint` (account switch / neutral welcome), also clear `@auth:previous_addresses`. Hint-preserving wipes (same-user relogin, migration) keep it — that is exactly the #671 trade-off.
4. **`components/LogoutConfirmSheet.tsx` (new)** — DS-only confirm sheet: what is removed locally, that the passkey lives in the OS/password manager and is not deleted, that funds/accounts are untouched, and that a PRF-capable passkey is needed to get back in. Cancel closes with no teardown; a failed teardown shows a recoverable line and leaves the session up.
5. **`screens/home/UnifiedHomeScreen.tsx`** — `settings` IconButton in `TopbarTrailing` → inline account `ChoiceSheet` (same pattern as the scan choice sheet) → confirm sheet.
6. **`lib/i18n/en.ts` + `de.ts`** — `screen.HomeScreen.accountA11yLabel`, `screen.AccountSheet.*`, `screen.LogoutConfirm.*`.
7. **`services/app/UserLogoutService.test.ts` (new)** — vitest: confirm calls teardown exactly once, concurrent calls do not double-fire, a throwing teardown reports `failed`, and a failure does not latch the guard shut.
8. **Docs** — `docs/codebase.md` + `docs/screens.md`: the production action and why Factory Reset stays separate and destructive.

## Progress Log
| Date | Agent | Task | Status | Notes |
|------|-------|------|--------|-------|
| 2026-08-12 | ubuntu | 1–8 | Done | Plan written before implementation; Ready confirmed in Nuri Delivery #4 at 16:06 UTC. |
| 2026-08-12 | ubuntu | Review round 1 | Done | taner-caliskan + codex, both High/P1 on the failure path: a residual-key abort was modelled as "session left intact" though auth state is already cleared. Failure is now a latched, non-dismissible recovery state (`blocked`), retry-only. Second High: `clearPreviousAddresses()` was best-effort over a swallowing delete — now reads back and throws, and its failure joins the pre-relaunch gate. New `services/app/SoftLogoutService.test.ts` injects both failures and proves no reload. |
| 2026-08-12 | ubuntu | UI placement | Done | The topbar `settings` icon + Account sheet were removed: entry point is the greeting's existing eight-tap gesture, debug hub in dev builds, logout confirm in production. `npm run check` green — biome clean on changed files, `tsc --noEmit` clean, vitest 84 files / 728 tests. |

## Handoff Notes

**Not committed.** Working tree carries the change on `wf/1061-…`; no commit, push or PR was made.

**Verified in code, not on a device:**
- Hint-less relaunch really does land neutral: `App.tsx` bumps `welcomeAutoOpenRestoreSignal`, and `PasskeyLoginScreenNative` opens the "Continue with @name" modal *only* when a `walletPasskeyCredIdB64u` hint survives — with no `preserveHint` there is none, so the welcome screen offers any passkey.
- Exactly-once and honest-failure are covered by `services/app/UserLogoutService.test.ts`.

**Behaviour change beyond the new UI, called out deliberately:** the `@auth:previous_addresses` clear fires on *every* hint-less `performSoftLogoutForRelogin()`, which today also includes `App.tsx`'s one-time Wirex-cutover forced logout. That path deliberately creates a fresh account on a neutral welcome screen, so dropping the previous-address list is the same isolation rule — but it does mean those users lose the pre-migration address union that the list provided.

**Still open (issue acceptance criteria this branch cannot satisfy):** Android + iOS production-build QA for same-passkey relogin and A → logout → B → logout → A isolation, and the independent exact-head security review. #671 stays open — this resolves its concern for the hint-less logout path only; the factory-reset path and any remaining migration-identity keys are untouched.
