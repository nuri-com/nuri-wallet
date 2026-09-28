# App release identity and communication

Every user-visible change gets a changelog entry in the same PR. Every release gets a versioned note in `docs/releases/` and a GitHub release or explicit draft, plus a short product-announcement draft. Social posting is a separate approved action.

## Loaded identity

Show the loaded JavaScript release in the Support header immediately left of Logout. Reuse the release identifier; never label an old open tab with a freshly fetched server version. Preserve native binary version and Expo OTA update ID/channel separately. Keep the visible label compact, provide the complete identity accessibly, and test the controls at 320px.

Do not change native/fingerprint inputs solely to label a web release. Increment the bundle-owned release identifier for each subsequent published bundle; different releases must not silently reuse one number. The deployment manifest's source SHA and bundle hash are the authoritative web artifact evidence.

## Release packet

1. Give the release a clear benefit-led title and one short before/after paragraph. List only changes actually present in the reviewed diff.
2. Link the tracking issue, PR and exact source. Record user QA, automated checks, known exclusions and compatibility limits. Do not inflate source tests into device proof.
3. Prepare detailed GitHub notes, a concise English/German announcement draft and separate OTA/store copy. Concrete benefits and linked evidence are the model, following the useful structure of Hermes announcements rather than copying claims or padding a small release.
4. Record Web, OTA and Store independently. Web needs live source/asset/hash plus rollback. OTA needs source, update ID/channel, runtime and device proof. Store needs marketing version, native build and actual submission/publication state.
5. Publish only verified target notes. Mark all other target copy DRAFT. Do not claim speed, security, fund recovery or universal platform availability without corresponding evidence.

Reference for the editorial structure: [Hermes v2026.8.31](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31). The reference is stylistic, not evidence about Nuri.

## Approval and release boundary

Human QA approval applies to the tested candidate. Narrow additions need their own relevant checks; changes to money or authentication flows need renewed approval and exact-head review. GitHub merge, public web deployment, OTA publication and native store release are separate events. Never bypass branch protection or label a prepared workflow as active.

For a web-first release, use the current canonical PWA procedure. Keep unrelated unfinished features out. After publication, attach an evidence record with the full source SHA, public manifest, asset SHA-256, PR, release notes and rollback handle. Deployment metadata can live in the GitHub release body/attached evidence rather than modifying the code after its final build.
