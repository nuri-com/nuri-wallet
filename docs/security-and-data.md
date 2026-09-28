# Keys, data and risks

This document describes inspectable client behavior in this snapshot. It is not
an independent security audit, a privacy policy, or proof of backend behavior.
Linked source is the evidence; where server-side evidence is missing, it remains
missing rather than being inferred from the client.

## 1. How keys are created

The login flow uses WebAuthn/passkeys. Key-derivation ceremonies request the PRF
extension. The resulting bytes are available to application code during derivation;
a passkey does not imply that every derived wallet key remains inside an authenticator.
See [the web passkey implementation](../services/auth/PasskeyNativeModuleService.web.ts)
and [the native bridge](../services/auth/PasskeyNativeModuleService.ts).

[Wallet derivation](../lib/walletDerivation.ts) separates Bitcoin and Ethereum
entropy using HKDF-SHA256 and different context strings. It derives a Nostr key
from the Bitcoin private key, and derives provider-specific SwapKit HTLC roots
from the PRF using HMAC-SHA256. These are related key families, not independently
generated identities. Compromise of a root can have consequences beyond one asset.

Recovery depends on the correct credential, RP ID, salt and derivation inputs.
[WalletKeyRecoveryService](../services/auth/WalletKeyRecoveryService.ts) rebuilds
keys from the passkey. Do not change those inputs as a cleanup. Availability of a
passkey on another device depends on the passkey provider, device and backup setup;
source publication does not guarantee account or funds recovery.

## 2. Where keys are stored

### Browser/PWA

[`secureKeyStorage.web.ts`](../lib/secureKeyStorage.web.ts) stores Bitcoin and
Ethereum private keys, Nostr key material and SwapKit HTLC state under the
`nuri.sks.` localStorage prefix. Private-key values are base64url-encoded, **not
encrypted**. Encoding is reversible and is not a confidentiality boundary.
The implementation falls back to an in-memory map when browser storage is unavailable.

The web keychain adapter, [`ReactNativeKeychainWeb.ts`](../lib/web/ReactNativeKeychainWeb.ts),
also uses localStorage (`nuri.kc.`). Native-looking keychain API names do not provide
native keychain protection in the browser. Several web biometric/app-lock methods
are no-ops; a UI lock must not be interpreted as cryptographic key isolation.

JavaScript running on the app's origin can read this storage. This includes a
malicious replacement app, injected script or compromised dependency delivered
with the app. An operator controlling delivered JavaScript can change what the
browser does. Open source and a file checker make inspection possible; they do not
remove that operator capability or protect a session already running different code.

### Native applications

[`secureKeyStorage.ts`](../lib/secureKeyStorage.ts) uses the native keychain API and
has different unlock/access-control behavior. Review its options and device behavior
separately. Do not transfer a native security claim to the web implementation, or
claim universal hardware protection without checking platform and device settings.

## 3. Who participates in transactions

- **Bitcoin/Arkade:** the current client uses the Nuri v4 cosigner at
  `arkade.nuri.com`. Local client signing, remote signing policy and recovery paths
  must be reviewed together. This repository alone cannot prove the cosigner's
  deployed policy or availability. Keep `npm run check:cosigner-boundary` intact.
- **EVM assets:** review their transaction and smart-account paths separately.
  A Bitcoin second-signature requirement is not a blanket guarantee for an
  Ethereum private key, a token approval or another chain's execution flow.
- **Swaps:** the v2 client accepts backend actions, validates them, persists order
  and recovery state, signs/broadcasts through executors and resumes pending work.
  Review [the commit flow](../services/swapkit/SwapKitV2CommitFlow.ts),
  [action service](../services/swapkit/SwapKitV2ActionService.ts), and their callers.
  Fees, allowances, deadlines, destination validation, liquidity, counterparties
  and chain finality remain material risks.
- **Banking/cards:** provider accounts and compliance systems are separate from
  onchain key custody. A wallet's signing model does not establish the custody or
  privacy properties of a bank/card provider.

## 4. What data can leave the device

| Boundary | What to inspect | Exposure and limitation |
| --- | --- | --- |
| Hosting/Cloudflare | [Worker](../cloudflare/src/worker.js), [CSP](../public/index.html) | Delivery and proxy operators handle network requests and associated metadata. Client source does not establish their log retention. |
| Cosigner/authentication | [Authentication services](../services/auth/), [endpoints](../config/endpoints.ts) | Credential identifiers, public keys, assertions and signing requests can identify a wallet/session. A WebAuthn assertion is not the same as PRF root output. Trace each payload. |
| RPCs/indexers | [Network configuration](../config/network.ts), [RPC code](../lib/rpc/) | Queried addresses, transactions and timing can reveal financial activity. Network operators may correlate requests with connection metadata. |
| Swap/banking providers | [SwapKit services](../services/swapkit/), [Wirex services](../services/wirex/) | Orders, addresses, amounts and provider account/compliance data have different recipients. Client code alone does not establish provider-side processing. |
| Nostr/support | [Nostr services](../services/nostr/), [SupportDumpService](../services/support/SupportDumpService.ts) | Support bundles contain diagnostic context, logs and address-related information. Review collection, redaction, encryption, recipients and send triggers. Encryption for a recipient does not prevent that recipient from reading it. |
| Public chains | Transaction-building and broadcast callers | Published transactions and address histories remain publicly observable. Pseudonymous addresses can become identifying when linked to accounts or support records. |

This table is a navigation guide, not an exhaustive network-capture report. No
claim is made that all traffic has been observed, that all logs are redacted, or
that the client never transmits sensitive material. Those claims require a
payload-level audit and controlled runtime observations.

## 5. What verification does and does not establish

Matching received files to an independently trusted manifest demonstrates byte
correspondence for those requests. A manifest's source SHA is only a producer's
label until source/build provenance and reproducibility are independently checked.
The verifier cannot enumerate unknown server routes, inspect private backends,
prove every user gets the same response, or establish that the code is safe.

Known publication work remains: provider-key restrictions, recorded fixture
privacy, asset notices, complete release artifacts, build reproducibility and
release/deployment synchronization. See [the readiness checklist](open-source-readiness.md)
and use [the critical AI review prompt](ai-review-prompt.md), not marketing claims,
as the starting point for an independent review.
