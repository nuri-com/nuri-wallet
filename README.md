# Nuri Wallet

The application source behind **app.nuri.com**, with an explanation of how it works,
what it depends on, what data it handles, and what you can independently verify.
This is the real Expo/React Native application, not a demonstration wallet.

**Status: private preparation for public release.** This repository starts with a
fresh history. It does not expose the private development history. Publication
review, reproducible builds and automatic release synchronization are not complete.
The historical release baseline is PWA **0.99.2**, `pwa-20260926-001001`; this is not
a claim that the snapshot matches what the production server serves today.
See [source provenance](SOURCE.json) and [publication readiness](docs/open-source-readiness.md).

## Read this before using the wallet

**The web implementation stores private keys in browser `localStorage` using
base64url encoding, not encryption.** JavaScript executing on the same origin can
read those keys. A compromised application update, XSS or browser can therefore
expose them. The Bitcoin cosigner must not be presented as protection for every
EVM, Nostr or swap key. These are existing implementation properties, not issues
fixed by publishing source. See [keys, data and risks](docs/security-and-data.md).

Do not import a funded wallet just to inspect this application. Its defaults point
to mainnet services. A local checkout is not an offline demo and does not replace
Nuri's backends. Passkeys are bound to their RP ID; an arbitrary self-hosted origin
cannot use production passkeys by changing a URL.

## Start here

| What you want to understand | Read |
| --- | --- |
| Architecture, application flows and implementation entrypoints | [How the app works](docs/transparency.md) |
| Keys, browser storage, service operators, data exposure and recovery limits | [Keys, data and risks](docs/security-and-data.md) |
| Where this source came from and what was excluded | [Snapshot scope](docs/source-snapshot.md) |
| How private development should produce public releases | [Release and update policy](docs/public-releases.md) |
| How to challenge the claims with an independent AI review | [AI review prompt](docs/ai-review-prompt.md) |
| Checks completed and publication blockers | [Publication readiness](docs/open-source-readiness.md) |
| Source and asset licensing | [Licensing](THIRD_PARTY_NOTICES.md) |

## What is included

- Application source for web, iOS and Android: screens, services, design system,
  authentication, wallet derivation, transaction and recovery clients, and tests.
- Lockfile, package patches, native modules and Expo/Metro configuration.
- The Cloudflare Worker used to serve the web export and proxy selected requests.
- A file-integrity checker covering HTML, JavaScript chunks, styles, assets and
  the service worker, when given a complete, independently trusted manifest.
- Historical security notes and postmortems. Their presence is not a claim that
  an old finding was fixed or still applies; check the source and review date.

The full running cosigner, SwapKit, banking and other backend implementations are
**not** included. Their source, operational configuration, logging/retention rules
and production equivalence require separate evidence. This repository does not
claim to make the whole service independently self-hostable.

## Inspect and test

Use Node.js 22 and a disposable environment without credentials or wallet data.
Read `package.json`, `patches/` and dependency install hooks before installation.

```sh
git clone https://github.com/nuri-com/nuri-wallet.git
cd nuri-wallet
npm ci --legacy-peer-deps
VITEST_LIVE=0 npm run check
node --test cloudflare/test/worker.test.mjs
```

To inspect the interface with a separate browser profile and no funded wallet:

```sh
npm run web
```

Native builds require their respective platform toolchains. This snapshot has not
established two-clean-build equality or verified a native binary. The preparation
checks used `--ignore-scripts` during dependency installation; they do not prove
that install hooks, native patches or a production build succeed.

## Verify a release

The checker can compare an independently trusted release manifest with received
files. It verifies `/` as well as `/index.html`, and checks every listed chunk and
asset rather than only the main bundle:

```sh
node scripts/web-integrity.mjs verify-url /path/to/trusted-pwa-integrity.json https://app.nuri.com
```

**A published production manifest is not available yet.** Do not create a manifest
from an untrusted server and call matching it independent verification. The tool
does not prove source-to-build correspondence, backend behavior, or that other
visitors receive the same code. [Verification details](docs/transparency.md#file-integrity-cli).

## Releases and contributions

Private development can continue separately. The target is a reviewed public
source commit for each production release, reproducible build inputs, complete
artifacts and provenance, followed by deployment of those same artifacts.
That synchronization is **not implemented yet**; this initial snapshot is manual.

GitHub Actions are disabled for this preparation repository. Imported workflow
files are references, not permission to deploy or issue native OTA updates.
Do not add production secrets or enable deployment workflows during review.

For a security report, contact **support@nuri.com** with a minimal, redacted
reproduction. Never post seed material, private keys, passkey PRF output, identity
documents or an affected user's support dump in an issue. Do not test against
other people's accounts or production wallets.

Application source is covered by [LICENSE](LICENSE). Dependency and asset rights
are separate; see [third-party notices and remaining licensing work](THIRD_PARTY_NOTICES.md).
