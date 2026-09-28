# Incident 2026-09-13: funded Satora swap stuck with no owner-visible path (Ludmilla)

## Summary
A funded BTC_ARKADE to EURC_BASE swap completed its Satora claim into tBTC but
never submitted its CoW final leg. The order sat in AWAITING_SIGNATURE with no
recovery prompt: the owner list hid it past KV page one, and the wallet showed
no way forward. No funds were lost; they were stuck awaiting owner consent to
fresh terms.

## Impact
- One proven customer order affected: `sk_c0580dab-d08a-47e6-8b89-1846c8c00eb8`
  (500,000 sats in, 1,846,993 sats change untouched, ~0.004975 tBTC claimed on
  Arbitrum). No second deposit was ever required.
- Same failure shape could hide any funded order beyond KV page one. No evidence
  of wider customer impact; the all-orders audit (#70) stays open.

## Timeline (2026-09-13, UTC)
- Backend 0.6.128 restored complete owner discovery (KV cursor + bulk reads).
- A parallel engine-side deploy (0.6.125 line) removed that fix; live discovery
  broke again the same day.
- Web 0.96.4 deployed to app.nuri.com: wallet-open detection surfaces the
  eligible original order automatically after unlock.
- Backend 0.6.129 merged both lines (recovery/KV + four engine fixes) and was
  deployed; owner discovery verified live again.
- Order state at handoff: AWAITING_SIGNATURE, no recovery acceptance, no payout.
  Customer signature and final receipt remain open.

## Root causes
1. KV owner discovery read only the first storage page; correctly indexed orders
   on later pages never reached the owner filter.
2. Two live source lines diverged (recovery vs engine); deploying either alone
   dropped the other's fixes.
3. The client had no wallet-open recovery prompt, so a resumable order looked
   dead to its owner.

## Fix (all live, PRs open/draft, not merged)
- Web 0.96.4, source `951ee69cdfb0c9135a7c531a9145f79ea96664df`, bundle
  `_expo/static/js/web/index-ebc58100f30c4ca275aa1f64317c6c7b.js`
  (SHA-256 `6df85b1511cfd69ffceabee7430bbf5a39e237bd9e3993574f93006ea3aa255f`,
  9,515,355 bytes). See `docs/releases/0.96.4.md`.
- Server 0.6.129, source `19bf809d265d556ee9272fe8316130616aeb4a4c`,
  Cloudflare `6cac2193-df13-492e-b630-62d25cd7a93e`, remote JS byte-equal
  (SHA-256 `dedd05ac05213acd5b33bf00200bfb98833529e0deb030305b3fa2de8f734c2a`).
- Same order, same recipient, no replacement order, no automatic price consent.
  Gas checks/sponsoring run through the existing tracker flow.

## Verification
- 21 backend suites green in guarded scratch envs; independent integration review
  no blockers.
- 12 real-React host/controller checks; committed predicate accepts the fresh
  live capture and rejects wrong-owner/already-accepted controls.
- Live: mobile entry renders Sign Passkey, desktop gate absent under phone
  emulation; real CORS owner discovery finds the original order.
- NOT proven: customer login, signature, final EURC/BTC receipt. Chat approval
  is not a wallet signature.

## Rollback
- Web backup: `/var/www/app.nuri.com.bak-20260913-194229`.
- Server predecessor `e3e616b0-d1d8-462e-9100-57a3474bbad1` is a technical
  rollback only; it lacks the restored recovery and is not equivalent.

## Follow-ups
- Customer taps Continue in her own wallet; then prove the final receipt.
- Keep #70 open until end receipts exist; never redeploy either old parent line
  alone (both PR bodies carry this warning).
- Code WHY comments for the wallet-open gates ship with the next web deploy;
  they are in-repo now, not in the live bundle yet.
