# Working on Nuri Wallet

- This is a preparation repository for a complete, inspectable wallet client. Do not replace real application flows with a demo or conceal known risks.
- Read README.md, docs/security-and-data.md and docs/source-snapshot.md before changing wallet behavior or publication claims.
- Do not deploy, distribute OTA updates, enable deployment workflows, add production secrets or change repository visibility without separate approval.
- Never log, commit or upload private keys, PRF output, wallet stores, identity documents or support dumps.
- Preserve the current cosigner v4 boundary at arkade.nuri.com. Never reintroduce legacy signing, migration or sweep flows into the current application. Never weaken npm run check:cosigner-boundary.
- Production application imports must remain static. Keep scripts/check-no-dynamic-imports.mjs and its positive controls intact.
- Reuse existing services, utilities and design-system components. Keep changes small and test behavior rather than rewriting security-sensitive code for presentation.
- Validate with VITEST_LIVE=0 npm run check and node --test cloudflare/test/worker.test.mjs. Do not use funded wallets or production recovery scripts for routine tests.
- Clearly distinguish observed source behavior, tested behavior, historical deployment evidence, and unverified claims. A passing hash check is not a security audit.
- Keep licensing, backend omissions and the manual synchronization status visible until they are actually resolved.
