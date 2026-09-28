# Security status — Nuri wallet

Joint review of `nuri-expo` (app + PWA) and `nuri-server-musig2-v4-arkade` (co-signer).
Two independent passes; every claim below was verified against the code, not taken from
issue text. Mirrored in both repos.

Last updated: 2026-08-01

---

## Verdict

**No finding allows theft of funds on its own — with two exceptions.**

For Bitcoin the 2-of-2 holds: the server key alone signs nothing, the client key never
leaves the device, and nonce handling was verified sound on both sides.

Two exceptions:

- The **web PWA**, where the Ethereum, Nostr and auth-HMAC keys sit in `localStorage` as
  plaintext and have no co-signer. An XSS reads them with **zero user interaction**. See
  item 1.
- The **approved amount is not bound to the PSBT**. A compromised client can have a
  genuine small approval signed while a second output drains the rest — both factors of
  the 2-of-2 are satisfied and the user is still robbed. See item 0.

---

## How to use this document

Every item is numbered and linked. Fill the **Status** column with one of:

| Tag | Meaning |
|-----|---------|
| `by-design` | Deliberate. Not a finding. Do not "fix" it. |
| `wont-fix-for-now` | Understood and accepted; revisit when the trigger in the issue fires. |
| `todo` | To be scheduled. |
| `done` | Verified fixed in code. |

Where a status is already filled in below, it was established during the review.

## Reading the issues: findings vs. proposed fixes

These two are not the same thing and must not be read as if they were.

- **Findings** in the linked issues were verified by reading the code. Line references
  and quoted snippets are real.
- **Proposed fixes** are sketches. Unless an issue says otherwise, the code in it was
  never executed and never tested against real traffic.

This distinction is not pedantry. `server#66` originally carried a fix that read like a
finished solution; checking it afterwards showed it would have rejected legitimate
payments, because Ark transactions legitimately contain OP_RETURN and extension outputs
that the proposed rule did not account for. An unverified proposal that looks verified is
exactly how a security fix turns into an outage.

Where a fix depends on data we do not have — real transaction shapes, real send
durations, real cosign counts — **measure first, then enforce.** That applies to item 0
(output classification, now part A of expo#996), item 17 (`direct_session` TTL) and the
cosign cap.

---

## The list

### Open

| # | Item | Link | Status |
|---|------|------|--------|
| 0 | **Approved amount is not bound to the PSBT.** `hasFundingOutput` requires only that *one* output matches the intent (`outputs.some(...)`); all other outputs are unconstrained, and the computed `total_out_sats` / `fee_sats` are logged but never checked. Signing is `SigHash.DEFAULT`, so the signature covers outputs nobody validated. A compromised client gets a truthful 50k approval signed alongside an output taking everything else. Found in the approval-path audit that both earlier passes had listed as out of scope. | [expo#996](https://github.com/nuri-com/nuri-expo/issues/996) (server#66 wurde dort eingegliedert) | `todo` |
| 1 | PWA stores ETH, Nostr and auth-HMAC private keys as plaintext in `localStorage`; those three have no co-signer, so an XSS drains them without any user interaction. Solution worked out in the issue: encrypt at rest with a PRF-derived key, no passwords. | [expo#746](https://github.com/nuri-com/nuri-expo/issues/746) | `todo` |
| 2 | Web origin `app.nuri.com` has no verified CSP, HSTS or SRI, and the set of third-party scripts on the wallet origin is unknown. This is the delivery path for item 1. | [expo#976](https://github.com/nuri-com/nuri-expo/issues/976) | `todo` |
| 3 | OTA bundles are not signature-verified on the device. The publish path is well guarded; `updates.codeSigningCertificate` is absent from the app config, so shipped binaries cannot verify a manifest regardless of what is signed server-side. | [expo#977](https://github.com/nuri-com/nuri-expo/issues/977), [expo#968](https://github.com/nuri-com/nuri-expo/issues/968) | `wont-fix-for-now` — accepted 2026-08-01, leave as is. Reduce the issue to its documentation task: comment the trust boundary in `app.config.ts` and the workflow header so the gap is known, not discovered. |
| 4 | Domain protection for `nuri.com` is unverified: registrar lock, CAA, DNSSEC, certificate-transparency monitoring. The domain carries the rpId of every passkey. Note this is about domain *takeover*; domain *loss* is covered by the offline recovery path in item 27. | [server#62](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/62), [server#57](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/57) | `todo` — state unknown, must be checked out of band |
| 5 | No startup RNG self-test in the app. Hedging covers a *degraded* RNG; a total failure reduces the client nonce to `f(sk, aggXonly, msg)` and lets a compromised co-signer recover the client key from three signatures. ~20 lines. | [expo#971](https://github.com/nuri-com/nuri-expo/issues/971) | `todo` — approved 2026-08-01, build it |
| 6 | Auth tokens are replayable for the full 5-minute TTL — no single-use consumption. Signing routes are no longer affected; `handleRecoveryBackupUpload`, `handleRecoveryBackupRead` and `handleReceiveClaimApprove` still are. The consumption layer itself is ~20 lines (a TTL map of spent `chal` values; `pruneMap` already exists in the file). **The real work is retries:** consuming a token makes these endpoints non-idempotent, so a network retry on a backup upload would fail. Either replay the cached response for an identical request (the pattern already used for tree signing) or have the client fetch a fresh token per attempt. | [server#7](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/7) | `todo` — approved 2026-08-01 |
| 7 | Supply chain: 44 of 60 direct dependencies use caret ranges, with no release cooldown and no provenance check at bump time. `npm ci` protects the build, not the decision to upgrade. | [expo#978](https://github.com/nuri-com/nuri-expo/issues/978), [expo#718](https://github.com/nuri-com/nuri-expo/issues/718) | `todo` — approved 2026-08-01, **with a documented update procedure**: the cooldown must not turn into "nobody dares upgrade". Define who bumps, how often, and how a security patch younger than the cooldown gets waved through. |
| 8 | The recovery backup is PRF-encrypted and dies with the passkey; there is no independent recovery factor. | [expo#970](https://github.com/nuri-com/nuri-expo/issues/970) | `by-design` — accepted 2026-08-01, consistent with item 24 |
| 9 | Receive and swap-intent routes check only that the owner is registered (`getRegisteredReceiveOwner`), not that the caller is that owner. No funds move on these routes; the reachable abuse is generating invoices or triggering syncs for a known credential. Requiring a WebAuthn assertion here would mean a biometric prompt per receive sync. | [server#8](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/8) | `by-design` — accepted 2026-08-01; document the owner-identifier-vs-authentication distinction at the handlers so it is not later mistaken for an auth bug |
| 10 | The Hetzner rescue / password-reset poweroff incident. Concerns the machine that holds `COSIGNER_SEED_V4` in its environment. | [server#16](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/16) | `wont-fix-for-now` — the host is well managed today; accepted 2026-08-01. Direction, already built and available rather than hypothetical: move the seed into an HSM — either the passkey-PRF smartcard signer (`nuri-passkey-prf-smartcard`, `nuri-prf-hsm`, `nuri-smartcard-musig2`) or AWS KMS (`nuri-prf-kms-server`). Comment this at the seed-loading site so the option is visible from the code. Same direction as item 16. |
| 11 | Eight sites in the server code carry deliberate decisions with no comment, so a later reviewer can "fix" and break them — notably the follow-up cosign binding and the published account xpub. Also carries the comments agreed for items 9, 10 and 27. | [server#63](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/63) | `todo` — approved 2026-08-01 |
| 12 | Six equivalent sites in the app, above all "never make client nonces deterministic" and the load-bearing polyfill import order in `index.js`. | [expo#991](https://github.com/nuri-com/nuri-expo/issues/991) | `todo` — approved 2026-08-01 |
| 13 | The passkey provider holding all wallet entropy is a deliberate decision and should be recorded as one, in code and in an ADR. | [expo#975](https://github.com/nuri-com/nuri-expo/issues/975) | `todo` — approved 2026-08-01 |
| 14 | Hygiene: tree secnonces are wiped only on the success path (verified: not a reuse risk). Belongs in a `finally`. | [expo#969](https://github.com/nuri-com/nuri-expo/issues/969) | `todo` — approved 2026-08-01 |
| 15 | **Checked 2026-08-01 on request — the versions have drifted.** `@scure/btc-signer` is **2.0.1** on the server and **2.2.0** in the app; `@noble/hashes` is 2.0.1 vs 2.0.0. Confirmed in `package.json` *and* `package-lock.json`, so this is what ships. `@noble/secp256k1` (`^3.0.0`, server) and `@scure/bip32` (`^2.0.0`, app) are on carets. Not an active bug: the private `Session` fields the app reaches into (`Q`, `gAcc`, `b`, `R`, `e`) still exist in 2.2.0. But the app depends on library **internals** that carry no compatibility promise, and the only thing that made that defensible was the identical pin. The next bump can break signing silently. | [server#56](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/56), [expo#978](https://github.com/nuri-com/nuri-expo/issues/978) | `todo` — add the CI drift guard, and comment at `ArkadeRemoteSignerSession.ts` why the versions must match |
| 16 | `COSIGNER_SEED_V4` lives in the process environment. On its own this breaks only the server's half of the 2-of-2. Target state is the HSM path described in item 10 — smartcard PRF signer or AWS KMS, both already built. | [server#60](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/60) | |
| 17 | `direct_session` scope usage should be audited. Five call sites, all deliberate — see item 26. Audit and document only; do not change the TTL before measuring. | [server#59](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/59) | `todo` — approved 2026-08-01 |
| 18 | Web PWA hardening findings from an earlier audit (#748). Overlaps items 1 and 2 but is **not** a duplicate — it carries two things neither covers: **no app lock on web** (`showBiometricLock()` is a no-op in the browser, so there is no idle or re-lock gate) and the **same-origin API proxy** (`lib/web/apiProxy.ts` + nginx), which needs checking for open-proxy / SSRF abuse and for per-request auth being enforced at the backend rather than by network position. | [expo#754](https://github.com/nuri-com/nuri-expo/issues/754) | `todo` — keep open, cross-link with 1 and 2 rather than merging; the app-lock and proxy items would be lost in a merge |

### Verified fixed in code — candidates to close

| # | Item | Link | Status |
|---|------|------|--------|
| 19 | Production did not fail closed on the passkey pubkey policy. Fixed at `src/ArkadeConfig.js:71-77` — `parsePasskeyPubkeyPolicy` accepts only `hard`, throws by name on `soft`, throws on anything else, defaults to `hard`. Config parses at boot, so a misconfigured deployment refuses to start. | [server#5](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/5) | `done` — **closed 2026-08-01** |
| 20 | `originMatches()` accepted wildcards, subdomains and substring matches. Fixed in `src/ArkadeWebauthn.js` — all four loose branches are gone; every origin must be an exact member of `ORIGIN_V4`, and `android:` origins must be listed too. | [server#6](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/6) | `done` — **closed 2026-08-01** |
| 21 | Signing routes accepted the legacy request-auth mode. Fixed in `src/ArkadeServer.js` — `handleArkadeSign` (~3538) returns 403 `request_auth_sign_disabled` without an `approval_token`, and the tree routes do the same (~3719, ~3869, ~4028). `/arkade/auth` remains available for identity and bootstrap, as the issue required. `verifyRequestAuth` now only reaches the two recovery-backup handlers and receive-claim-approve — see item 6. | [server#12](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/12) | `done` — **closed 2026-08-01** |
| 22 | "Confirm payload not consumed on approve" — moot: all `/arkade/confirm/*` routes return `sealedWipRoute` (404) at `src/ArkadeServer.js` ~5713-5746, so `handleArkadeConfirmApprove` and its siblings (~3148-3505) are unreachable dead code. Both review passes analysed them as live and both produced a finding; neither read the router table. **Issue stays open** for its three remaining follow-ups: rate limiting on sign/tree endpoints, documenting which `server_pub_nonce66` the client must use, and alerting on `nonce_already_used_for_txid` / `tree_nonce_context_mismatch`. | [server#58](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/58) | scope narrowed 2026-08-01 — stays open |
| 23 | Cosigner account sharding. Rejected 2026-08-01: the server key alone cannot sign for anyone, sharding cannot help existing wallets, and two permanent derivation schemes cost more than a future-only benefit. | [server#61](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/61) | closed |

### Deliberate design — confirm, do not "fix"

| # | Decision | Reference | Status |
|---|----------|-----------|--------|
| 24 | Passkey lost = wallet lost. The price of deterministic recovery without a seed phrase. | [expo#970](https://github.com/nuri-com/nuri-expo/issues/970) | `by-design` **for now** — confirmed 2026-08-01; revisit if item 8 lands an independent recovery factor |
| 25 | Non-hardened co-signer derivation with a publicly served account xpub — enables serverless recovery after CSV expiry without tree metadata. | [ADR 0001](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/adr/0001-non-hardened-cosigner-derivation.md) | `by-design` — confirmed 2026-08-01 |
| 26 | `direct_send_session` deliberately does not re-bind `msg32` to the approved set. On a send the user approves a PSBT and the server recomputes the sighashes from it, so it only signs what was shown. Ark and Lightning produce **further** sighashes mid-flight that did not exist at approval time — hence this scope, under which follow-up requests are no longer checked against the approval. Price: anyone holding a valid token within the 5-minute TTL gets arbitrary sighashes signed; the brake is that they also need the client key. Binding strictly would break every send. Recommendation: keep the scope. Do **not** shorten the TTL or cap the cosign count blind — a real Boltz/Lightning swap may legitimately need the full 5 minutes and many cosigns, so guessing a limit risks breaking sends. Measure the real maximum duration and cosign count in production first, then decide. | [server#59](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/59) | `by-design` — scope confirmed 2026-08-01. TTL/cap: **measure before changing anything** |
| 27 | rpId is `nuri.com` and cannot be changed — WebAuthn binds credentials to it. **Losing the domain does not lock users out:** WebAuthn binds to the rpId *string*, not to DNS ownership, so `nuri-prf-recovery-tool/one-click-recovery.sh` reproduces the origin locally (`127.0.0.1 nuri.com` in `/etc/hosts` + a locally trusted certificate) and the authenticator performs PRF evaluation against the real credential, fully offline. Two limits: this covers domain *loss*, not domain *takeover* (item 4), and it is the browser path — native apps rely on associated domains fetched from the real host. | [server#57](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/issues/57) | `by-design` — confirmed 2026-08-01 |
| 28 | Client nonces are hedged random, the server's are deterministic. Every signature needs a one-time number; reusing one across two different contexts leaks the private key. The server derives its nonce deterministically from the client nonce, its key and the message — safe because it signs **last** and already knows the client nonce, and it survives restarts and snapshots. The client signs **first**, so it cannot factor in the server nonce and must use real randomness. BIP-327 rule, not preference — which is why item 5 matters. | [ADR 0003](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/adr/0003-nonce-strategy.md) | `by-design` |
| 29 | The passkey provider holds the entropy behind every wallet. "Provider" means wherever the passkey lives and syncs — iCloud Keychain, Google Password Manager, 1Password, or a hardware key; not the website. It holds the `hmac-secret` from which PRF is computed, so it could derive every wallet key. Not auditable, not rotatable — hence trust anchor. | [expo#975](https://github.com/nuri-com/nuri-expo/issues/975) | `by-design` |
| 30 | OTA publishing is guarded by pipeline controls rather than device-side signature verification. Confirmed as intended; the residual gap is item 3. | [expo#977](https://github.com/nuri-com/nuri-expo/issues/977) | `by-design` — confirmed 2026-08-01 |
| 31 | MuSig2 for the Nostr key — **assessment corrected 2026-08-01: it is feasible.** See "Nostr and MuSig2" below. | [expo#746](https://github.com/nuri-com/nuri-expo/issues/746) | feasible, deferred — not the lever |

---

## Direction for item 1

Prior art, `arkade-os/wallet`: the mnemonic is stored encrypted in `localStorage` with
`PBKDF2(password, 100k, SHA-256) -> AES-GCM-256`. They need a password because a BIP-39
mnemonic is their root and no better secret exists.

**We will not introduce passwords.** WebAuthn PRF is higher entropy, biometrically
gated, origin-bound and needs no stretching:

```
wrapKey = HKDF(prf_keystore, salt, "nuri/web/keystore/v1", 32)
localStorage["nuri.sks.<id>"] = iv ‖ AES-GCM(wrapKey, privateKey)
```

One passkey prompt per session; an XSS reading `localStorage` then gets ciphertext.
Use a PRF salt distinct from the wallet-seed salt — WebAuthn PRF can evaluate two salts
in a single assertion, so this still costs one prompt.

Note this is security-*equivalent* to not persisting at all, because the keys are
themselves PRF-derived: either way the attacker's requirement is "obtain a PRF
assertion". The gain is UX — one prompt per session instead of one per operation.

Longer term, Ethereum moves to a Kernel smart account with a Nuri co-signer (see the
`nuri-aa` repo), after which no raw EVM key exists in the browser at all.

### Nostr and MuSig2 — corrected assessment (item 31)

An earlier revision called this rejected on two grounds. **One of them was wrong.**

- **ECDH is not a blocker.** ECDH against a MuSig2 key is *linear*:
  `agg_priv · P = a₁x₁·P + a₂x₂·P`. Each side does one scalar multiplication and the
  points are added. That is textbook, not exotic threshold ECDH. Verified where ECDH is
  used at all: only the support chat (`SupportDumpService` →
  `createNip04DirectMessage`, `createNip17GiftWrap`). Backups use `signEvent` plus
  symmetric encryption. And the support-chat counterparty is Nuri itself, so the
  "the server learns who you talk to" objection does not apply here.
- **No timelocks in Nostr, so no decay** — this one stands, but weighs less than stated
  once roles are separated:

| Role | Where it lives | If the co-signer is lost |
|------|----------------|--------------------------|
| Event signing | MuSig2 2-of-2 | can no longer publish |
| Backup content key | local, PRF-derived | **old backups stay readable** |
| ECDH for support DMs | local | keeps working |

So co-signer loss means: derive a fresh Nostr key from PRF and republish. Old data stays
accessible. A mild, recoverable failure, not a permanently dead identity.

**What it would buy, and what it would not.** MuSig2 prevents *impersonation*. It does
not stop a stolen local key from decrypting backups, because the content key has to stay
local or the server would be needed to read anything. Impersonating a backup-addressing
key with no followers is a small loss; backup confidentiality is the valuable part, and
only item 1 protects that.

**Conclusion:** feasible, worth revisiting later, but not the lever. Item 1 is the lever.

**Residual risk:** while a session is unlocked, plaintext keys live in JS memory. This
does not remove an attacker inside a live session, which is why item 1 stays coupled to
item 2, and why session timeout with re-lock is part of the work.

---

## Not reviewed

1. **The approval UI.** The server binds approvals to the PSBT correctly, but nobody
   checked whether the amount and recipient shown on screen derive from that same PSBT
   or from a second field carried alongside. If those two sources can diverge, the
   second factor is theatre. Roughly 30 minutes of reading; the most valuable open item.
2. Deployment pipeline, TLS / reverse-proxy configuration, and how `COSIGNER_SEED_V4`
   is handled in deploy tooling.
3. `nuri-expo` has 449 open issues; only those matching security keywords were read.

---

## Related documents

- [Security review 2026-07-31](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/security-review-2026-07-31.md) — full findings, urgency assessment, scope limits
- [ADR 0001](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/adr/0001-non-hardened-cosigner-derivation.md) — non-hardened derivation
- [ADR 0002](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/adr/0002-cosigner-account-sharding.md) — sharding, rejected
- [ADR 0003](https://github.com/nuri-com/nuri-server-musig2-v4-arkade/blob/chore/deploy-14-ens-dual-parent/docs/adr/0003-nonce-strategy.md) — nonce strategy
