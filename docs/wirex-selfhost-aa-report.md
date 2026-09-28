# Wirex AA Selfhost Migration Report

This report documents the work required to remove the managed ZeroDev runtime from the active Wirex debug flow and replace it with our own hosted AA infrastructure. It focuses on what blocked us, what we got wrong, why those mistakes happened, how we fixed them, and what the final architecture looks like.

## Goal

The original goal was simple:

1. Keep the Wirex sandbox server and proxy under our control.
2. Stop depending on managed ZeroDev bundler and paymaster services.
3. Run AA bootstrap through our own hosted infrastructure.
4. Match the old managed UX by sponsoring gas for fresh kernels.

The critical requirement was not just "it can work locally". The real requirement was:

1. The active app path must not silently fall back to ZeroDev.
2. Fresh wallets must not require manual Base Sepolia ETH prefunding.
3. The hosted path must be explicit, inspectable, and reproducible.

## Starting state

Before this migration, the active runtime had a hidden architecture mismatch:

1. The Wirex debug server and proxy were mostly ours.
2. The active AA bootstrap path in the app still used managed ZeroDev defaults.
3. The old selfhost direction existed only as experimental scripts.
4. The app path and the CLI path were not the same system.

In practice that meant:

1. `lib/wirex/aaBootstrap.ts` still contained managed ZeroDev defaults.
2. The active app flow still depended on a ZeroDev project id, API key, bundler RPC, and paymaster RPC.
3. The selfhost scripts under `experimental/wirex/` were useful references, but they were not the real app path.

That was the main architectural problem: we thought we were already close to a fully selfhosted flow, but the working app path still depended on managed ZeroDev infrastructure.

## Final architecture

The active AA debug architecture now looks like this:

1. The app uses `lib/wirex/aaBootstrapSelfhost.ts`.
2. The active debug screens call only the selfhost bootstrap path.
3. The deprecated managed path is isolated and hard-disabled.
4. The bundler is hosted by us and exposed at `https://dev.nuri.com/aa-bundler/`.
5. The public Base Sepolia RPC used by the app is exposed at `https://dev.nuri.com/aa-public-rpc/`.
6. The selfhost paymaster contract is deployed on Base Sepolia at `0x8b256759a6ee450a203004Cd05D3aD51835f50D8`.
7. The app now requires that paymaster address and will not silently drop back to self-funded mode.

The important distinction is:

1. We are now independent from the managed ZeroDev service at runtime.
2. We still use local `@zerodev/*` SDK packages in the codebase.
3. We still use an external Base Sepolia RPC provider behind our hosted public RPC route.

So the correct statement is:

1. Managed ZeroDev runtime dependency is removed from the active app path.
2. Full ecosystem isolation from every third-party library or RPC is not the current state.

## Blockers, mistakes, and fixes

### 1. Hidden managed ZeroDev dependency in the active app path

**Problem**

The active app bootstrap still used managed ZeroDev defaults even though the project goal was full selfhosting.

**Why we got it wrong**

The repo already contained experimental selfhost work, which made it look like the active path had already been migrated. It had not. Convenience defaults in the active bootstrap kept the managed dependency alive.

**What exposed it**

The active bootstrap code still contained:

1. ZeroDev project id defaults.
2. ZeroDev API key defaults.
3. ZeroDev-hosted bundler URL construction.
4. ZeroDev paymaster client creation.

**Fix**

We split the AA runtime into explicit files:

1. `lib/wirex/aaBootstrapSelfhost.ts`
2. `lib/wirex/aaBootstrapZeroDevDeprecated.ts`

Then we:

1. made selfhost the only active path,
2. disabled the deprecated wrapper with a hard failure,
3. removed the old hidden managed fallback from the active screens.

This solved the most dangerous issue: accidental managed runtime reuse.

### 2. The app selfhost path existed, but it was still self-funded

**Problem**

After removing managed ZeroDev runtime, the app still required fresh kernels to hold Base Sepolia ETH.

**Why we got it wrong**

The first goal was simply to remove managed endpoints. That produced a selfhost bundler path, but not a sponsored path. This was only half the old managed experience.

**What exposed it**

The selfhost bootstrap enforced a hard prefund check:

1. it read kernel balance,
2. compared it against a minimum threshold,
3. threw `kernel_insufficient_funds`.

That made the selfhost path technically correct but operationally worse than the managed path.

**Fix**

We treated the self-funded mode as an intermediate proof only. We proved the selfhost bundler first, then replaced the funding model with a paymaster-backed flow.

### 3. We had no proof that a fresh zero-funded kernel could work without managed sponsorship

**Problem**

We needed a proof that our own infrastructure could sponsor a user operation before touching the app path.

**Why we did not skip this**

Changing the app before proving sponsorship in CLI would have produced another half-baked path. We needed the lowest-friction verification loop first.

**Fix**

We built the proof in CLI first:

1. kept the selfhost bundler path,
2. added paymaster support to the selfhost onboarding script,
3. tested a fresh zero-funded kernel end to end,
4. only after that moved the paymaster path into the app.

This was the correct order. It avoided mixing UI problems with AA infrastructure problems.

### 4. No selfhost paymaster existed yet

**Problem**

The repo had a placeholder paymaster script path, but not a real deployed sponsor setup for the app path.

**Why we got it wrong**

The earlier selfhost work had already covered bundling and registration, so the existence of a paymaster-related script suggested more completion than actually existed. The script was not the same thing as a live deployed sponsor system.

**Fix**

We added a minimal real paymaster project under:

1. `experimental/wirex/selfhost/paymaster/foundry.toml`
2. `experimental/wirex/selfhost/paymaster/remappings.txt`
3. `experimental/wirex/selfhost/paymaster/src/OpenPaymaster.sol`
4. `experimental/wirex/selfhost/paymaster/deploy.sh`

The contract is intentionally simple:

1. it accepts user operations,
2. it deposits ETH into EntryPoint,
3. it acts as the sponsor for selfhost AA bootstrap.

### 5. Foundry could not see the ERC-4337 contracts cleanly

**Problem**

The paymaster contract depended on the official ERC-4337 contracts, but Foundry could not resolve them cleanly from the repo layout.

**Why we got it wrong**

The repo is not organized as a dedicated Foundry project at the root. The paymaster project lives inside a nested experimental folder, so the default import resolution was not enough.

**Fix**

We:

1. installed `@account-abstraction/contracts`,
2. added explicit remappings,
3. allowed the nested Foundry project to read the top-level `node_modules`,
4. configured `allow_paths` and `libs` in the local `foundry.toml`.

That made the paymaster build deterministic inside the repo.

### 6. The paymaster needed an onchain deposit, not just deployment

**Problem**

Deploying the paymaster contract was not enough. EntryPoint sponsorship only works if the paymaster is funded.

**Why this matters**

A deployed but unfunded paymaster looks operational from a code perspective but cannot sponsor anything. This is a classic false-positive state in ERC-4337 integrations.

**Fix**

The deploy script now:

1. deploys the paymaster,
2. deposits ETH into EntryPoint,
3. optionally supports staking config,
4. persists the paymaster address in `experimental/wirex/selfhost/.env`.

The live funded paymaster used for the proof is:

1. `0x8b256759a6ee450a203004Cd05D3aD51835f50D8`

### 7. We needed hard proof that sponsorship actually paid gas

**Problem**

A CLI script saying "ok" was not enough. We needed proof that a fresh zero-funded kernel succeeded specifically because of the paymaster.

**Why this matters**

Without proving that the kernel stayed at zero balance and the paymaster deposit decreased, a successful run could still have been explained by hidden prefunding.

**Fix**

We proved all three conditions together:

1. fresh kernel started at `0 wei`,
2. user operation succeeded,
3. paymaster deposit decreased after the run.

The successful proof used:

1. Fresh EOA: `0xB7dE92d7152DaD77CB49d75CFC3E7ec59c114141`
2. Fresh kernel: `0x81d64C03a73339388934be061A7B6F885762aB52`
3. User operation hash: `0xc9f206d6bc0dfa67ccd758697abd83045e4d90828f29db7947c4dc6df885a53c`
4. Wirex user id: `f6a3182f-8dd9-4821-be7e-53ce7ddbe56b`

And the critical verification facts were:

1. Kernel balance stayed `0`.
2. Paymaster deposit dropped from its funded value.
3. Wirex still created the user and returned a real KYC link.

That was the real proof that the sponsorship path worked.

### 8. The app path still was not using the proven sponsor

**Problem**

Even after the CLI proof succeeded, the app still used the old self-funded selfhost runtime path.

**Why we got it wrong**

CLI proof and app runtime had diverged. The CLI script had the new sponsor flow first, but the app bootstrap had not been updated yet.

**Fix**

We wired the exact sponsor model into the app runtime:

1. `lib/wirex/aaBootstrapSelfhost.ts` now requires a paymaster address.
2. It now attaches static paymaster data to both account client variants.
3. It no longer blocks on kernel prefunding when sponsorship is configured.
4. It now emits `sponsorshipMode: "selfhost_paymaster"`.
5. It now reports `paymasterAddressUsed`.

This removed the last active self-funded assumption from the app bootstrap.

### 9. The app still needed a single source of truth for selfhost endpoints

**Problem**

The bundler, public RPC, and paymaster address all needed to be explicit and shared across screens.

**Why we got it wrong**

Endpoint configuration was partially present already, but the paymaster address was not part of that shared config yet.

**Fix**

We added the hosted paymaster address to:

1. `lib/wirex/debugConfig.ts`
2. `.env`

The app now has an explicit selfhost config set:

1. `EXPO_PUBLIC_WIREX_SELFHOST_BUNDLER_RPC_URL`
2. `EXPO_PUBLIC_BASE_SEPOLIA_PUBLIC_RPC_URL`
3. `EXPO_PUBLIC_WIREX_SELFHOST_PAYMASTER_ADDRESS`

### 10. The debug screens could still have behaved like optional selfhost experiments

**Problem**

Even with the runtime fixed, the screens still needed to enforce the sponsor configuration and show it clearly.

**Why this matters**

If the UI silently tolerated a missing paymaster address, we would have recreated the same "hidden fallback" problem in a different place.

**Fix**

We updated:

1. `screens/DebugWirexSignUpModal.tsx`
2. `screens/DebugWirexUXModal.tsx`

Both screens now:

1. require the hosted paymaster address,
2. pass it into the selfhost bootstrap,
3. log and surface the paymaster address used,
4. fail explicitly if the paymaster config is missing.

This made the runtime contract visible and testable from the UI.

### 11. We needed to distinguish service independence from library reuse

**Problem**

The phrase "no ZeroDev anymore" can mean two different things:

1. no managed ZeroDev service,
2. no ZeroDev-related code or packages at all.

Those are not the same milestone.

**Fix**

We defined the result precisely:

1. Managed ZeroDev runtime service dependency is removed from the active app path.
2. The deprecated managed wrapper is disabled.
3. The app no longer depends on ZeroDev-hosted bundler or paymaster endpoints.
4. The codebase still uses local `@zerodev/*` SDK packages.

That honesty matters, because otherwise we would repeat the same architectural ambiguity that caused the original problem.

## Files that mattered most

The migration depended mainly on these files:

1. `lib/wirex/aaBootstrapSelfhost.ts`
2. `lib/wirex/aaBootstrapZeroDevDeprecated.ts`
3. `lib/wirex/debugConfig.ts`
4. `screens/DebugWirexSignUpModal.tsx`
5. `screens/DebugWirexUXModal.tsx`
6. `experimental/wirex/onboard-selfhost.mjs`
7. `experimental/wirex/selfhost/paymaster/src/OpenPaymaster.sol`
8. `experimental/wirex/selfhost/paymaster/deploy.sh`
9. `experimental/wirex/selfhost/.env`

## Hosted values used by the current selfhost path

These are the public endpoints and onchain addresses that define the current runtime:

1. Bundler URL: `https://dev.nuri.com/aa-bundler/`
2. Public RPC URL: `https://dev.nuri.com/aa-public-rpc/`
3. Paymaster address: `0x8b256759a6ee450a203004Cd05D3aD51835f50D8`

## What is now independent

The active app runtime is now independent from:

1. managed ZeroDev bundler hosting,
2. managed ZeroDev paymaster hosting,
3. hidden ZeroDev project id fallback,
4. hidden ZeroDev API key fallback,
5. accidental downgrade to self-funded behavior in the active app bootstrap.

## What is still not fully "ours"

To keep the report honest, these pieces are still external:

1. Base Sepolia RPC behind our public RPC route.
2. The bundler implementation software itself.
3. The local `@zerodev/*` SDK packages in the client and CLI.
4. Wirex KYC approval for fresh sandbox users, which is still a manual product gate.

That means:

1. runtime service control is ours,
2. full ecosystem isolation is not the current claim.

## Practical lessons

1. Hidden fallback defaults are architectural bugs.
2. Selfhost bundler without selfhost sponsorship is only half a migration.
3. CLI proof must come before UI wiring.
4. A successful sponsored AA proof needs three facts at once:
   1. zero-funded kernel,
   2. successful user operation,
   3. decreased paymaster deposit.
5. "No ZeroDev" must always be stated precisely as service removal, library removal, or both.

## Current state

The active Wirex debug flow now has:

1. selfhost bundler routing,
2. selfhost paymaster sponsorship,
3. no managed ZeroDev runtime fallback,
4. explicit selfhost config in the app,
5. a proven CLI sponsorship path,
6. matching app bootstrap wiring.

The next real validation step is app-side testing of a fresh zero-funded wallet against the hosted selfhost endpoints.
