# Unreleased: continue an existing Bitcoin-to-euro swap

DRAFT. Not released, merged, deployed or published through OTA. `0.96.3` is assigned as the unpublished WEB candidate only; see [candidate notes](0.96.3.md). These notes describe the reviewed functional candidate, not a completed customer payout. Backend recovery remains a separate rollout: this web deployment alone does not promise a usable recovery button or a Ludmilla payout.

## What changes

A funded Satora Bitcoin-to-EURC swap can stop after its Bitcoin claim when the old price no longer fits the available quote. This candidate adds an explicit current-rate offer to the existing swap detail sheet. The wallet owner reviews the euro amount and confirms before the same original order resumes. It does not request another deposit or create a replacement SwapKit order.

- Bind the displayed offer and signature to the original order, owner, recipient, claimed token, amount, expiry, fixed EURC minimum and sell ceiling.
- Preserve the exact acceptance signature across lost responses. Reconcile expired unaccepted offers before showing fresh terms; new terms always require explicit confirmation.
- Retain the pending order until the receipt check proves sufficient net Base EURC to the accepted recipient. Accept the real server `id` field only when it matches the original order; conflicting identities are rejected.
- Keep ordinary price protection and signer restrictions. No customer-specific hardcoding, new account, separate recovery website or additional deposit.
- Use static erased TypeScript imports so the repository's dynamic-import guard passes without changing runtime JavaScript.

## Version and publication state

The candidate web bundle-owned label is `0.96.3` in `lib/loadedAppVersion.ts`, with corresponding identity test expectations updated. The Expo marketing configuration remains `0.96.0` in `app.config.ts`; the unchanged npm package version `1.0.0` is not the displayed product release. Native build numbers and fingerprint inputs remain untouched. The assigned WEB candidate is unpublished until parent live verification; it is not an OTA or Store release.

Current live web source: `fed17a9c10e98990aea588f3b0707edf323e4e10`. Current production OTA source on both platforms: `cb6e48df351c67a7fa0e8db2375479a0dd6d09db`, published as `v0.96.0`. Web deployment and OTA publication are independent. A web-only deployment does not update installed iOS/Android apps.

## Exact release scope

Functional candidate: `7686a73c084eb32c900e5c1edb143f05cde50e0a` in nuri-com/nuri-expo PR #1326 (issue #1325). Backend dependency: nuri-com/nuri-mcp-bitcoin-swapkit PR #272, functional head `779e339484df040983c87f436b9fea407a0cbcdd`.

At the recorded functional head, against the recorded live web source, the repair adds 5 commits and changes 17 paths, including tests and documentation. No unrelated feature branch was merged into this repair. The documentation commit `888be37fce2fdadc0f2347cda55e691cc41733b0` and the subsequent web-only `0.96.3` identity preparation sit above that functional candidate; the historical counts do not describe the final release head. The broader dev/mobile gap below is excluded from this web-versus-live delta.

Against the current production OTA, however, the same candidate contains 74 reachable commits (including merge commits) and 110 net changed paths. That is not a recovery-only OTA. Existing dev/web changes include:

- Home/Support presentation and loaded-version identity, plus public payment-link/QR/wallet-handoff changes (#1190, #1186).
- Lightning-to-Tanzanian-phone/TZS transfer code and its quote/confirmation flow (#1282, #1285, #1286).
- Swap route selection, direct-EVM recovery, Satora refund recovery, BTC payout confirmation and Arkade funding-report persistence (#1301, #1303, #1305, #1307, #1308, #1321).
- The Arkade swap SDK change from `0.0.5` to `0.1.0-rc.3`, import-loading fixes and dependency remediation (#1270, #1291, #1292, #1183).
- Wirex stale pending-withdrawal marker handling (#1278).

This is a source-composition inventory, not mobile QA approval for those older changes. A broad OTA needs its own approved scope and device QA. Prefer the bounded server/web recovery rollout first; choose a separately reviewed hotfix/backport or a deliberately broader OTA rather than quietly publishing all of dev.

## OTA compatibility

OTA-eligible at the recorded functional head for installations using these production runtimes:

- Android: `b6a08bc0731747da7250acea198c11198d501acc`.
- iOS: `0630fe26287496aacb7486a2cba6f568ef6db47d`.

Both were regenerated with pinned EAS CLI `18.11.0`, `APP_VARIANT=production` and the production environment from the checkout containing the real installed dependency graph, and match the current production OTA groups. The initial symlinked-node_modules review checkout produced different autolinking fingerprints; those are diagnostic artifacts, not proof that a Store build is required. No source or dependency configuration was changed to obtain the match.

A new Store binary is not required solely by this candidate for compatible runtimes. Fingerprint equality is not device delivery, functional mobile QA, or proof that every older installation is compatible. Recheck final release composition and observe the loaded OTA update ID after publication.

Current production groups: Android `53f35541-491f-4b6c-9a60-695a58f69b15`; iOS `eda564e4-7427-42b4-8837-d4345bb2f2ae`. They do not contain this recovery fix.

## Verification and exclusions

At the functional head: 158 tests across seven app suites, typecheck, full lint, GitHub checks and the actual backend-response/client-receipt integration probe passed. Independent functional and final type-only reviews approved their exact deltas. Provider HTTP responses, signatures using public fixture keys and receipts in these tests are offline fixtures. No live customer transaction or successful Ludmilla payout is claimed.

No release branch/tag/GitHub Release, web deployment, production OTA or Store submission was created by this recovery work. The wider SwapKit funds audit remains paused with its unresolved evidence gaps; this release does not claim that all stuck orders are resolved.

## Product copy drafts

English: “Continue your existing swap. Review the current euro amount and confirm without making another deposit. Available after the recovery update is released.”

Deutsch: „Bestehenden Tausch fortsetzen: aktuellen Eurobetrag prüfen und bestätigen, ohne erneut einzuzahlen. Verfügbar nach Veröffentlichung des Rettungsupdates.“

Neither copy has been posted. Do not announce recovered funds or mobile availability before the corresponding live evidence.
