# Nuri Web — verify what app.nuri.com serves

This repository contains a **specific web release and the source needed to rebuild it**.
It is not the development repository, a demo, or a copy of the native applications.

**Result for this snapshot:** all **313 release files** matched the live site when
checked on **2026-10-20**. Building the reduced web source reproduced all **311
application files byte for byte**. The remaining two files are deployment metadata and
the WAICT integrity manifest.

**Security model:** persistent browser-readable wallet keys are an intentional part
of this web implementation, not a newly discovered storage malfunction. Bitcoin
cosigned paths and direct EVM signing have different protection boundaries. The
[risk map](#risk-map) documents those boundaries and their assumptions. Separately,
the repository's earlier import still needs publication review; known runtime
trade-offs and private material in Git history are different questions.

## Contents

- [Check the live app](#check-the-live-app)
- [Which hash identifies the release?](#which-hash-identifies-the-release)
- [Rebuild the application](#rebuild-the-application)
- [How verification works](#how-verification-works)
- [Application architecture and data boundaries](#application-architecture-and-data-boundaries)
- [Passkeys, wallet keys and storage](#passkeys-wallet-keys-and-storage)
- [Security and publication](#security-and-publication)
- [Updates and verification limits](#updates-and-verification-limits)

## Check the live app

Use Node.js 22. Obtain this repository from a revision you trust, inspect the small
[checker](verify.mjs), and run it from the repository root:

```sh
git clone https://github.com/nuri-com/nuri-wallet.git
cd nuri-wallet
node verify.mjs
```

The checker uses only Node.js built-ins: no dependency installation, browser wallet,
login, private key or production account is needed. It reads the local release
manifest, checks the local files, then fetches the listed files from
`https://app.nuri.com` and compares their bytes. It does not execute downloaded
JavaScript, connect a wallet, sign transactions or deploy anything.

For this snapshot, success prints:

```text
PASS: 313 live files match release 940c5d26a30a462f7c3017a85afcc80ac1e1489a
WAICT manifest: /waict/ZwVBv3g5tsz_DtqhR7YCR8
Release manifest SHA-256: 1caf7a29a1372e3c2a103a853806dc1d5956d310741d864119f5e506f36bd007
```

A failed request or mismatch produces a nonzero exit status. It is not proof of an
attack: a newer legitimate deployment, network failure or incomplete rollout can
also cause failure. Do not bypass the failure by replacing the reference with files
freshly downloaded from the same server. First identify the intended release.

### What is in this repository?

| Path | Purpose |
| --- | --- |
| [`web/`](web/) | The exact static release: HTML, CSS, JavaScript, fonts, images, service worker and metadata. |
| [`source/`](source/) | The production web graph's source, static web configuration, lockfile, package patches and necessary build/safety checks. |
| [`release.json`](release.json) | Every release path with its byte length and SHA-256, plus the original source identifier. |
| [`verify.mjs`](verify.mjs) | The independent local, live and rebuild checker. |
| [`verify.test.mjs`](verify.test.mjs) | Offline regression checks for mismatches, path validation, redirects, changing deployments and the preserved cosigner boundary. |
| [`waict.mjs`](waict.mjs) | Builds and validates the WAICT integrity manifest; the production deploy uses the same file. |
| [`.github/workflows/attest.yml`](.github/workflows/attest.yml) | The public rebuild-and-sign workflow that runs for every release tag. |

The release contains **217 Expo JavaScript chunks**, 2 other JavaScript files
(nuri-service-worker.js, jsQR.js), HTML, CSS, assets, 3 JSON files and the WAICT integrity manifest.
The full inventory is **313 files / 27,048,329 bytes**. Checking only the main
JavaScript file would leave other executable code and resources unchecked.

The source subset was selected from Metro's emitted module graph, not by guessing
which filenames looked unused. Its **724 emitted project source/asset files** were
preserved byte for byte; necessary build inputs are included as well. Shared code
or a runtime debug helper can remain if it is part of that graph. Operational tools,
plan archives, native projects and deployment workflows are not in the current tree.
Dependency declarations and the lockfile are retained rather than pruned in a way
that could change package resolution and the resulting bytes.

## Which hash identifies the release?

There are three distinct identifiers:

| Identifier | Meaning |
| --- | --- |
| A Git commit | A particular source-tree/history identity. The upstream deployment commit and this repository's commit are not interchangeable. |
| A file's SHA-256 | The exact bytes of one HTML, JavaScript, image or other file. Filename hashes are not a substitute for this check. |
| The SHA-256 of `release.json` | A fingerprint of the entire recorded inventory: paths, sizes, file hashes and source label. It is not the hash of one concatenated application file. |

**Release manifest SHA-256:**

```text
1caf7a29a1372e3c2a103a853806dc1d5956d310741d864119f5e506f36bd007
```

Compute it independently with Node.js:

```sh
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); console.log(crypto.createHash("sha256").update(fs.readFileSync("release.json")).digest("hex"))'
```

The main application bundle is
[`index-4a4c9fd45c847631f49374ab332f9135.js`](web/_expo/static/js/web/index-4a4c9fd45c847631f49374ab332f9135.js).
Its SHA-256 is:

```text
e90a672cb4812d911533e5b80f27b256ab02972a5c414b35b8fcba8532d18e8e
```

To compare it with the live site without cloning anything:

```sh
curl -s https://app.nuri.com/_expo/static/js/web/index-4a4c9fd45c847631f49374ab332f9135.js | shasum -a 256
```

This checks one file. `node verify.mjs` checks all of them.

A hash is not a signature or an endorsement. An attacker who replaces the manifest,
checker and reference hash can make malicious files agree with that replacement.
The trust anchor must be a separately authenticated repository revision or release
reference, not a manifest obtained only from the site under inspection. See
[Authenticate a release](#authenticate-a-release). The manifest's `source_sha` is a label;
actual rebuilding supplies the byte-correspondence evidence. The manifest fingerprint
does not hash `source/`, `verify.mjs` or this README: authenticate their repository
revision separately. Documentation changes do not change the web-release fingerprint.

### Authenticate a release

Every release is published by the production deploy as a new commit and a permanent
`pwa-*` tag. For each tag, this repository's public
[`attest.yml`](.github/workflows/attest.yml) workflow rebuilds `source/`, requires every
application file to match `release.json`, and then signs `release.json` with a GitHub
artifact attestation recorded in the public Sigstore transparency log:

```sh
gh attestation verify release.json --repo nuri-com/nuri-wallet \
  --signer-workflow nuri-com/nuri-wallet/.github/workflows/attest.yml
```

GitHub signs attestations only for public repositories on this plan, so signing starts
with the first release published after the repository becomes public. Tags cannot be
moved or deleted and `main` cannot be force-pushed.

## Rebuild the application

Use a clean checkout and an environment without production credentials, wallet
stores or local `.env` overrides. Review dependencies and install hooks first:
`npm ci` executes the package's `patch-package` postinstall hook and dependency hooks.
Rebuilding is different from the dependency-free checker.

```sh
cd source
npm ci --legacy-peer-deps
npm run build
cd ..
node verify.mjs rebuild
```

The build writes `source/dist/`. It does not change `web/` or publish a release.
The checker compares every rebuilt application file against the checked-in manifest,
rejecting missing, extra or changed files.

```mermaid
flowchart LR
    S["Published web source and build inputs"] --> B["Clean Expo web build"]
    B --> R["311 rebuilt application files"]
    W["Recorded web release"] --> M["release.json: path, size, SHA-256"]
    R --> C["Compare complete file sets and bytes"]
    M --> C
    W --> D["deployment.json: recorded metadata"]
    D --> L["Checked locally and against the live site"]
    C --> P["Pass only when every application file matches"]
```

### Why 311 rebuilt files but 313 release files?

`web/deployment.json` records deployment-time information, including the source SHA,
release ID and timestamp. `web/waict/ZwVBv3g5tsz_DtqhR7YCR8` is the WAICT integrity manifest written
at deploy time. Expo produces neither file. Rebuild mode excludes **only those two
files** from the expected build output; it does not silently ignore arbitrary
differences. The WAICT manifest is then recomputed from the rebuilt files and must match
byte for byte. Local and live verification still check both files' full bytes against
the manifest.

The evaluated web configuration is in [`source/app.json`](source/app.json). Native
platform configuration and native plugins were removed from the source export;
the resulting application bytes were then checked, not assumed to be unchanged.

| Recorded evidence | Value |
| --- | --- |
| Application version | `0.106.0` |
| Deployment ID | `pwa-940c5d26a30a` |
| Original deployment source | `940c5d26a30a462f7c3017a85afcc80ac1e1489a` |
| Deployment timestamp | `2026-10-20T20:13:11Z` |
| Last complete live comparison for this snapshot | `2026-10-20` |
| Rebuild environment | GitHub Actions, Node `22.23.3`, npm `10.9.9`, clean directory |
| Original production CI | nuri-expo Deploy PWA, Node 22 |
| Rebuild result | All 311 application files byte-identical |

This is observed reproduction for these inputs/environments, not a claim that every
future operating system, toolchain or environment override will produce identical
bytes. The source identifier above is not this repository's Git commit.

## How verification works

```mermaid
sequenceDiagram
    participant Reader
    participant Checker as Local verify.mjs
    participant Reference as Trusted local release and web files
    participant Site as app.nuri.com
    Reader->>Checker: node verify.mjs
    Checker->>Reference: Validate manifest and complete local file set
    Checker->>Site: Fetch and check deployment.json
    loop Every listed release file
        Checker->>Site: HTTPS GET without following redirects
        Site-->>Checker: Response body
        Checker->>Checker: Check HTTP status, byte length and SHA-256
    end
    Checker->>Site: Fetch and check deployment.json again
    Checker-->>Reader: PASS and manifest fingerprint, or nonzero exit
```

- **Local:** `node verify.mjs local` checks `web/` without contacting the app. Extra,
  missing or modified files fail. Symlinks and invalid/duplicate manifest paths fail.
- **Live:** `node verify.mjs` first performs the local check, then checks the listed
  HTTPS responses. Each request has a 15-second timeout. Oversized responses,
  unexpected status codes, redirects and wrong hashes fail.
- **Rebuild:** `node verify.mjs rebuild` checks the recorded local release and compares
  `source/dist/` with its application-file subset, treating deployment metadata separately.
- **WAICT:** the checker recomputes the [WAICT](https://waict.dev) integrity manifest
  from the release files and, in live mode, checks that the homepage sends a valid
  `Integrity-Policy-WAICT-v1` header naming it. The site sends `mode=report`: browsers
  that implement the draft (today a Firefox Nightly prototype) report mismatches but
  do not block them.

The HTML entry in the manifest is `index.html`, but the request is made to `/`:
Cloudflare redirects `/index.html` there. The checker hashes the actual homepage,
not a redirect response. HTTP compression is decoded before hashing, so gzip or
Brotli transport encoding does not change the expected application bytes.

Deployment metadata is checked before and after the file pass as well as within
the inventory. A change from the pinned metadata fails verification. This detects
ordinary deployment changes during the check; it cannot force a hostile server to
serve consistent responses to everyone. HTTP also provides no exhaustive listing
of unknown routes, so the live check cannot reject every unlisted resource a server
might additionally expose. The local file-set check can reject extras on disk.

Run the offline tests with:

```sh
node --test verify.test.mjs
```

There are 18 regression tests, including a check that the cosigner guard scans the
nested `source/` directory instead of accidentally checking an empty repository root.
For the build safety checks, after installing dependencies:

```sh
cd source
npm run check
```

## Application architecture and data boundaries

The architecture and security review below was written for release `0.100.0`
(`746be77ad6c0b4599835262a3c36a48779b0e7c2`). Its source links point to that reviewed
snapshot, so line references stay correct as later releases are published.

```mermaid
flowchart TB
    Operator["Deployment operator and hosting"] --> Release["R1: delivered HTML, JS chunks, assets and service worker"]
    Release --> Browser["Application JavaScript at app.nuri.com"]
    Authenticator["Passkey provider or authenticator"] -->|"PRF at bootstrap; assertions for authorization"| Browser
    Browser <--> Storage["R2: derived keys in localStorage and active session memory"]
    Browser -->|"Approval requests and client signing contributions"| Cosigner["R3: arkade.nuri.com v4; remote signature and server policy"]
    Browser -->|"Locally signed EOA transactions"| EVM["R4: EVM RPC and blockchain; no Bitcoin cosigner on this path"]
    Browser -->|"Orders, queries and diagnostics; direct or proxied"| Services["R5: swaps, banking, RPCs, indexers, Nostr and support"]
    Reference["Independently trusted repository revision"] --> Checker["R6: external file verifier"]
    Release -->|"Fresh HTTP responses"| Checker
```

This diagram describes trust boundaries, not an exhaustive packet capture. Some
requests are proxied and others go directly to configured services. The server-side
implementations and their retention policies are outside this source snapshot.

| Flow | Inspectable entrypoints | What the boundary means |
| --- | --- | --- |
| Application startup and UI | [`index.js`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/index.js), [`App.tsx`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/App.tsx), [`screens/`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/screens/) | Platform adapters, state and background work affect the application, not only the visible screen. |
| Web module resolution | [`metro.config.js`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/metro.config.js), [`lib/web/`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/web/) | Browser adapters differ from native implementations. A native-looking API name is not evidence of hardware key protection. |
| Bitcoin/Arkade signing | [`services/arkade/`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/), [`config/endpoints.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/config/endpoints.ts) | The current client uses `arkade.nuri.com` v4. Remote signing policy and service availability require separate evidence. |
| EVM transfers | [`BaseTokenTransferService.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/base/BaseTokenTransferService.ts), [`SwapKitEvmSigner.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/swapkit/SwapKitEvmSigner.ts) | Local Ethereum key material becomes an EVM signer. Bitcoin cosigning does not apply to every asset or execution path. |
| Swaps | [`SwapKitV2CommitFlow.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/swapkit/SwapKitV2CommitFlow.ts), [`SwapKitV2ActionService.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/swapkit/SwapKitV2ActionService.ts) | Quotes, validation, persisted recovery state and wallet executors must be inspected together. File integrity does not guarantee liquidity, fair prices or successful recovery. |
| RPC and provider requests | [`config/network.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/config/network.ts), [`services/wirex/`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/wirex/) | Addresses, amounts, transaction requests and provider account data can be visible to their recipients. |
| Support and diagnostics | [`SupportDumpService.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/support/SupportDumpService.ts), [`DebugLogBuffer.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/logging/DebugLogBuffer.ts) | Reports include diagnostics and wallet-related metadata. Personal-data inclusion is separately gated in the service. Reports are encrypted for support, but support can read them. A full caller/redaction/retention audit is still needed. |

Onchain transactions are public. RPCs, hosting, banking, swap and messaging services
can observe the data their requests carry and associated network metadata. This
repository is not evidence of those operators' logging or deletion practices.
An allowed host in the [Content Security Policy](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/public/index.html) is not
proof that a request occurred or proof of its payload.

## Passkeys, wallet keys and storage

A passkey's credential key and the wallet keys derived by this app are **not the
same thing**. The WebAuthn PRF result is available to application code during
wallet derivation. That does not mean the authenticator's credential private key
is exported; it means the derived wallet material has its own storage boundary.

```mermaid
flowchart TD
    Auth["Passkey PRF ceremony with RP ID and salt"] --> PRF["PRF output in application memory"]
    PRF --> BTCEntropy["HKDF: Bitcoin entropy"]
    PRF --> EVMEntropy["HKDF: Ethereum entropy"]
    BTCEntropy --> BTC["Derived Bitcoin private key"]
    EVMEntropy --> EVM["Derived Ethereum private key"]
    BTC --> Nostr["Derived Nostr private key"]
    PRF --> HTLC["HMAC: provider-separated swap HTLC root"]
    BTC --> LS["Browser localStorage: encoded, not encrypted"]
    EVM --> LS
    Nostr --> LS
    HTLC --> LS
    LS --> JS["Readable by JavaScript executing on the app origin"]
```

Evidence: [web passkey ceremonies](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/auth/PasskeyNativeModuleService.web.ts),
[wallet bootstrap](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/auth/PasskeyPrfWalletBootstrapService.ts),
[derivation functions](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/walletDerivation.ts), and
[web key storage](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/secureKeyStorage.web.ts).

Derivation is domain-separated, but the keys are not independent of their parent
material. Compromise of the PRF root has broader consequences than compromise of
one derived key; the Bitcoin key is also an input to Nostr derivation. Correct RP ID,
credential, salt and derivation context matter for recovery. These public constants
are not passwords and must not be changed merely to make the code look sanitized.
A different hosting origin cannot simply reuse production passkeys.

The storage adapter uses `nuri.sks.` localStorage entries and base64url for private
keys and HTLC roots. Base64url is reversible encoding, **not encryption**. Some web
lock/cache methods are no-ops. The [web keychain adapter](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/web/ReactNativeKeychainWeb.ts)
also uses localStorage; it does not inherit native keychain/biometric guarantees.
The storage adapter also persists authentication-related state through `storeAuthData`
and `storeAuthKey`. Its exposure boundary is therefore not limited to coin keys;
the permissions and lifetime of each credential depend on its protocol and backend.

### Intended lifecycle: derive once, retain keys, authorize signing separately

The [storage implementation's own comments](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/secureKeyStorage.web.ts#L1-L14)
explicitly describe this persistence decision and cite the cosigner as the second
factor. This is not an accidental fallback to plaintext storage. The important
question is which signing paths actually have that second factor.

For the current Bitcoin/Arkade client,
[`SigningKeyVault`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/internal/signingKeyVault.ts#L224-L305)
distinguishes two operations:

1. **Bootstrap/recovery:** a PRF ceremony derives wallet material, which is persisted.
2. **Signing authorization:** a standard WebAuthn assertion is obtained when required,
   and the held Bitcoin key is loaded. The code explicitly does not request the PRF
   again for that assertion. It checks that the held key matches the expected public key.

Temporary signing-key copies are scoped and cleared when that operation ends. This
reduces the lifetime of those copies; it does not erase the persisted localStorage
entry or make JavaScript memory reliably inaccessible to a compromised runtime.

The client also supports scoped approval/session reuse for selected receive,
boarding and recovery operations. For example,
[`requestBoardingSweepApprovalToken`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/ArkadeRemoteIdentity.ts#L1451-L1545)
can request an approval using an existing session token without another assertion.
Consequently, this architecture must not be described as "a fresh biometric prompt
for every signature." Session scope, expiry and server enforcement matter.

### Two different signing boundaries

```mermaid
flowchart LR
    subgraph Bitcoin["Bitcoin cosigned path"]
        BK["Held client Bitcoin key"] --> CP["Client signing contribution"]
        WA["WebAuthn authorization or allowed scoped session"] --> AP["Approval token and approved request scope"]
        AP --> CP
        AP --> Server["v4 cosigner and server-side policy"]
        Server --> SP["Server signing contribution"]
        CP --> Combined["Combined signature"]
        SP --> Combined
    end
    subgraph Ethereum["Direct EVM EOA path"]
        EK["Held Ethereum key"] --> ES["Local EVM signer"]
        ES --> RPC["Signed transaction broadcast to RPC"]
    end
```

This diagram shows the client protocol, not an independent audit of the cosigner.
[`ArkadeRemoteIdentity`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/ArkadeRemoteIdentity.ts#L2050-L2205)
requires an approval token in this signing path and obtains the server's signing
contribution. A copied client key alone is not equivalent to both cosigning keys.
The direct EVM path in
[`BaseTokenTransferService`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/base/BaseTokenTransferService.ts#L69-L77)
constructs an EOA signer from the held Ethereum key and does not use that Bitcoin
cosigner. Smart accounts, HTLCs and other asset paths require their own policy analysis.

## Security and publication

### Known design, residual risk, and publication hygiene

Persistent browser-readable derived keys are **intended behavior in this snapshot**.
The source comments state that choice, and the signing code deliberately reuses
held key material after separate authorization. Documenting that decision is not a finding that storage
has unexpectedly malfunctioned. It also does not establish that every asset is
protected by a cosigner or that browser compromise is harmless.

Browser code and client configuration are already delivered to visitors. Publishing
readable source makes their behavior easier to inspect; it does not newly upload a
user's locally generated wallet keys. Known architectural trade-offs can be documented
honestly in an open-source release. They are separate from inadvertently publishing
private history, personal data or credentials that were never intended to be public.

This is a **scoped architecture and publication review**, not a penetration test, a
complete transaction-policy audit, or confirmation that every dependency is safe.
No funded wallet, real private key or provider credential was used to test an exploit.

### Risk map

The identifiers below correspond to the architecture diagram. The table separates
observed mechanisms from the assumptions needed for those mechanisms to protect users.

| Boundary | Intended protection / observed mechanism | Concrete residual risk and condition |
| --- | --- | --- |
| **R1 — code delivery** | HTTPS and the browser origin load the app. The [CSP](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/public/index.html) restricts script sources; the independent checker compares received static bytes with a trusted release. | A compromised deployer, hosting account, allowed script or exploitable injection can change code executed on the wallet origin. Legitimate-origin malicious code can read its origin's storage. A hash check only detects changed bytes in the responses actually checked. |
| **R2 — local key persistence** | [`secureKeyStorage.web.ts`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/lib/secureKeyStorage.web.ts#L155-L179) intentionally retains derived keys. The browser's same-origin policy separates unrelated websites. | Same-origin script execution or access to relevant browser-profile data can expose persisted key material. Base64url does not encrypt it. Scoped zeroization does not remove the persistent entry. Nostr identity and swap roots have their own consequences if exposed. |
| **R3 — Bitcoin/Arkade cosigning** | Client and server signing contributions, WebAuthn authorization and approval scopes form an additional boundary. See [`SigningKeyVault`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/internal/signingKeyVault.ts) and [`ArkadeRemoteIdentity`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/arkade/ArkadeRemoteIdentity.ts). | Client-key theft is not automatically theft of the server key. Protection still depends on server-side request binding, scope/expiry enforcement and the actual protocol. An active compromised browser may have session material or mislead a user into authorizing an action. This snapshot does not independently prove the server's policy or availability. |
| **R4 — direct EVM EOA signing** | The local Ethereum key creates a signer in [`BaseTokenTransferService`](https://github.com/nuri-com/nuri-wallet/blob/5c1aede68bdaa340516b0e6f6869b40b969137c3/source/services/base/BaseTokenTransferService.ts#L69-L77); UI and client code validate the intended operation. | If that private key is stolen, an attacker can sign for the EOA outside the UI. A Bitcoin cosigner is not required on this path. Exposure of funds or allowances depends on that account's holdings and onchain permissions. This is a potentially high-impact browser-compromise consequence, not proof of an existing remote exploit. |
| **R5 — providers and diagnostics** | HTTPS, protocol-specific validation and recipient encryption protect particular exchanges. Swap actions have client checks; support reports use encryption for support. | Providers still receive their intended addresses, orders, transactions or account data. Support can read reports encrypted to it. Provider outages, erroneous responses, counterparty/contract behavior, logging and privacy retention are not resolved by static-file hashes. |
| **R6 — verification reference** | A separately trusted repository revision supplies the checker, source and manifest; rebuilding checks correspondence to the recorded files. | If the reference or verifier is replaced, internally matching hashes do not prove authenticity. A server can serve different code to another session, and an already-open tab may run older code. No independent backend attestation or universal-delivery proof is claimed. |

An unrelated website cannot normally read another origin's localStorage merely
because this source is public. The relevant conditions are origin/runtime compromise,
relevant device/profile access, or control of the delivered application. No working
XSS exploit or cosigner-policy bypass is demonstrated in this review.

A WebAuthn user-verification ceremony also is not, by itself, a trusted display of
the transaction's destination and amount. Transaction binding and what the user
actually approved must be assessed separately. Existing scoped sessions are part of
that assessment; they must not be described as unrestricted approvals or as a fresh
passkey prompt for each internal signature without inspecting the applicable policy.

**What is and is not changed here:** this repository documents the current model;
it does not silently replace it with another storage or signing architecture. Moving
keys to IndexedDB would not by itself create a new same-origin isolation boundary.
At-rest encryption and stronger signer isolation address different threats and would
require a separately reviewed release with recovery/compatibility checks and new
artifact hashes. Their absence is a design boundary to disclose, not a reason to
pretend the current source differs from the deployed application.

### Publication blocker: the old import remains in Git history

The current tree is minimal. The repository's initial commit is not: it still
contains superseded development documentation, plan archives and fixtures. Removing
files from the default branch does not remove their earlier versions. Making the
repository public exposes reachable history as well as the README people see first.

Publish a reviewed clean history, or complete an authorized history cleanup before
changing visibility. Removing history is not credential revocation and cannot undo
copies already made. No history rewrite or visibility change is performed by the
verification commands.

### Review required: browser API keys and third-party configuration

The source contains a shared Alchemy client key, and the shipped dependencies
contain other client configuration, including provider/analytics keys. Such values
must be assumed observable by anyone receiving the app; hiding the source does not
protect them. They are not automatically equivalent to a server administrator key.

Provider-side origin/API restrictions, quotas and billing controls have **not** been
verified. Assess each key's intended public use and permissions; restrict or replace
inappropriate credentials through the provider and a new app release. Do not remove
values from this snapshot while claiming its bytes still match production.

### Scan evidence and its limits

Gitleaks **8.30.1**, using built-in rules, full output redaction and no finding
suppressions, reported:

| Scope | Raw findings | Interpretation |
| --- | --- | --- |
| Current tracked web snapshot | 19 | Client configuration plus matches in translations, identifiers and minified library code. Not 19 confirmed secret leaks. |
| Reachable repository history at this review | 36 across two commits | Includes the earlier Firebase configuration, fixtures and repeated/moved content. Not 36 distinct credentials. |

No wallet seed or server private key was confirmed in the inspected findings.
This is not proof that none exists anywhere in the repository, history or services.
Pattern scans do not establish provider permissions, anonymize financial records,
or replace manual privacy and dependency review. Raw values and scan reports are
not published in this README.

### Licensing is a separate publication gate

Application source is under [MIT](LICENSE). Dependencies, bundled fonts and other
assets retain their own terms. The owner has confirmed redistribution rights for
Harriet and Sharp Grotesk, but the applicable notices still need to be supplied and
reviewed. Source licensing does not automatically relicense all bundled material.

This preparation repository remains private. GitHub Actions runs only the public
rebuild-and-sign workflow; no production credential is stored here. Keep
production credentials, wallet data, support exports and identity documents out of
public issues and commits. Documenting the intended storage model does not extend
cosigner protection to unrelated signing paths. Publishing source and checking hashes
improve inspectability; they do not change the runtime's trust boundaries.

## Updates and verification limits

Each production deployment publishes its own reviewed-format snapshot here
automatically: a new commit and a permanent `pwa-*` tag with a complete file
inventory. Earlier releases are never replaced under an existing trusted identity.
Publishing or editing this repository does not deploy the application or issue an
OTA update.

A successful check establishes byte correspondence for the responses it obtained.
It does not establish any of the following:

1. An already-open tab or installed PWA is executing those same bytes. Its loaded
   code, cache or service-worker state can differ from a new request.
2. Other users receive the same responses. A server can vary delivery by session,
   region, timing or another request attribute.
3. Backend/edge implementations, API results, response-header settings or account
   policies correspond to published source. Those are separate trust boundaries.
4. Every possible route, external script, embedded provider or data response has
   been enumerated. This inventory covers the recorded static application files.
5. The matching application is secure, bug-free, private or guaranteed to recover
   funds. Reproducibility and code safety are different claims.

Use the checker for its specific evidence: **this reviewed source rebuilds the
recorded application files, and these fetched responses match that recorded release**.
Do not turn that statement into a broader security certification.
