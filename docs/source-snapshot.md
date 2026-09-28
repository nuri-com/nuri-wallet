# Source snapshot and scope

## Origin

This is a fresh Git repository, not a fork or a mirror of private Git history.
Its starting point is the reviewed worktree based on development commit
`f18ccc51df8925223233c88a7851c0c2cf752c77`. That worktree includes the independent
file-integrity CLI, tests, and documentation follow-up. See [SOURCE.json](../SOURCE.json).
A private commit identifier records lineage; it is not publicly retrievable evidence.
The commits in this repository identify the actual source available to reviewers.

The historical production evidence refers to source
`1ef9850af9b05b2e58b8bd7054e3828c3c11a1a5`, release `pwa-20260926-001001`, PWA 0.99.2.
That evidence was taken from deployment records, not a fresh production inspection.
Neither this snapshot nor its Git commit is represented as a verified current deployment.

## What was preserved

Application code, tests, dependency declarations and lockfile, patches, native
modules, assets, platform configuration, Worker code and release recipes were
copied from the review worktree. No wallet derivation, signing or recovery logic
was rewritten for public presentation. Package scripts add offline integrity tests;
this does not change application dependencies.

The worktree had already removed 52 generated iOS verification-export files and
one empty scratch file. Those generated files are not source inputs; the original
private history is not copied into this repository.

## What differs

- `README.md` and `AGENTS.md` are replaced with guidance for this standalone repository.
- New documentation explains security/data boundaries, source scope, release policy
  and remaining licensing work. Existing historical notes remain dated evidence,
  not a current security certification.
- Private coordination logs, agent-specific known hosts, a private release policy,
  private agent instructions, a coordination issue template and its issue-link
  workflow are omitted. The exact path list is in `SOURCE.json`.
- No `.git` history, ignored local files, `.env` files, wallets, installed dependencies
  or untracked support/build folders were copied. Only tracked files and the two
  explicitly selected integrity-tool files were used as import inputs.

The remaining deployment/OTA workflows are included as historical build recipes.
GitHub Actions are disabled in this preparation repository. Publishing source is
not permission to operate Nuri infrastructure or distribute an OTA update.

## Standalone validation

The new repository installed 1,215 packages from the existing lockfile using
`npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund`.
`VITEST_LIVE=0 npm run check` passed: 229 Vitest files / 1,956 tests and eight
file-integrity tests. The five Worker tests also passed. Biome still reports
166 warnings. Install hooks, native patches and a production build were not
exercised by those checks.

A byte comparison confirmed that 1,085 imported files are unchanged from the
review worktree; the replaced files are `README.md`, `AGENTS.md` and the readiness
document. Additional public-facing documents and `SOURCE.json` are new files.
Gitleaks 8.30.1 scanned a tracked-file-only copy of this standalone tree with full
redaction and no finding suppressions. Its 19 findings match the previously
classified locations; this is not a secrets/privacy clearance. New documentation
links were checked locally. Some imported files retain pre-existing whitespace
warnings; they were not silently reformatted as part of the source import.

## Limits

This is a complete client-source preparation snapshot, not a promise of standalone
backend operation or bit-identical production builds. Public client configuration
and recorded test fixtures remain subject to publication review. Do not confuse
fresh history with content sanitization: removing old commits does not make every
value in the current tree safe to publish.
