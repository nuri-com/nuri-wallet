// services/bitcoin/BitcoinBootstrapService.ts
//
// Bitcoin leg of the startup/unlock orchestrator (#643). Runs on the
// post-unlock transition (cold launch + every re-unlock) to warm the Bitcoin
// wallet headless — so the Bitcoin screen shows its address + balance without
// the user having to open Receive first. The card leg stays lazy (deferred
// to the full #643 orchestrator).
//
// Post-unlock ONLY: never runs pre-login, and the wallet key is already cached
// from the just-completed biometric unlock, so this adds no Face ID prompt —
// it triggers the same summary load the Receive button already does.

import { clearArkadeBoardingAddressCache } from "../../lib/secureKeyStorage";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { isSameWalletIdentity, type WalletIdentity } from "../../lib/bitcoin/walletIdentity";
import { currentWalletCredId } from "../auth/walletCredential";
import { walletService } from "./WalletService";
import { loadWalletFromPublicKeys } from "../../lib/bitcoin/keys";
import { bip68SequenceFromTimelock } from "../../lib/bitcoin/csv";
import { resolveArkadeMusig2WalletKeys } from "./Musig2WalletKeys";
import { hydrateArkadeLnurlStatus, resetArkadeLnurlCache } from "../arkade/ArkadeLnurlService";
import { bitcoinBalanceStore } from "./BitcoinBalanceStore";

const HYDRATE_SOURCE = "services/bitcoin/BitcoinBootstrapService.ts#hydrateBitcoinOnUnlock";

let inFlight = false;

// Serializes hydrations. `loadWalletFromPublicKeys()` installs the identity's
// descriptors into the WalletService singleton and only THEN derives an address
// from it, so two overlapping runs — the tail of a sign-out and the bootstrap of
// the account replacing it — can interleave and derive one identity's deposit
// address from the other's freshly installed wallet. Checking the generation at
// publish time cannot catch that: by then the address is already the wrong one.
// Each run therefore waits for the previous one to finish and reads its own
// generation afterwards, so no run ever observes a wallet it did not install.
let musig2HydrateChain: Promise<void> = Promise.resolve();

/**
 * Rebuild the current MuSig2+CSV L1 wallet from the v4 signing context and
 * publish its address into WalletService. Migration is intentionally external
 * to app.nuri.com; this bootstrap never derives or scans legacy wallets.
 */
export async function hydrateMusig2Address(): Promise<void> {
  const run = musig2HydrateChain.then(() => runMusig2Hydrate());
  musig2HydrateChain = run.catch(() => {});
  return run;
}

async function runMusig2Hydrate(): Promise<void> {
  const generation = walletService.getAddressGeneration();
  await hydrateArkadeMusig2Address(generation);
}

async function hydrateArkadeMusig2Address(generation: number): Promise<void> {
  try {
    // Captured BEFORE the async key resolution. Resolving talks to the co-signer, and an in-app login
    // can replace the identity in that window; the install is then refused for the identity it started
    // under instead of stamping the previous account's descriptor as the new one's.
    const identity: WalletIdentity = {
      credId: currentWalletCredId(),
      epoch: walletService.getIdentityEpoch(),
    };
    const keys = await resolveArkadeMusig2WalletKeys();
    // Null means the aggregate or the CSV timelock could not be established —
    // publishing a guess would hand the user an address of a different wallet.
    if (!keys) return;
    // The keys carry the credential they were read under: if that is not the identity this run started
    // with, the snapshot is from an account that is gone, and neither the descriptor nor the address
    // may be published for the one that replaced it.
    const loaded: WalletIdentity = {
      credId: currentWalletCredId(),
      epoch: walletService.getIdentityEpoch(),
    };
    if (!isSameWalletIdentity(identity, loaded) || keys.credId !== identity.credId) {
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
        "musig2 hydrate discarded (identity changed)",
        {
          startedCred: identity.credId ? "present" : "none",
          keysCred: keys.credId ? "present" : "none",
        },
        {
          context: "background",
          event: "STATE",
          action: "hydrate",
          source: HYDRATE_SOURCE,
        },
      );
      return;
    }
    // Installs this identity's descriptors into WalletService (send reads them)
    // and derives the address from them in one step.
    const address = await loadWalletFromPublicKeys(
      {
        userExternal: keys.userCompressed,
        userInternal: keys.userCompressed,
        aggregatedExternal: keys.aggregatedXonly32,
        aggregatedInternal: keys.aggregatedXonly32,
      },
      bip68SequenceFromTimelock(keys.csvTimelock),
      identity,
    );
    if (address) walletService.setMusig2Address(address, generation);
  } catch (e: unknown) {
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
      "musig2 address hydrate failed",
      { message: e instanceof Error ? e.message : String(e) },
      {
        context: "background",
        event: "API_ERR",
        action: "hydrate",
        source: HYDRATE_SOURCE,
      },
    );
  }
}

async function runHydrate(): Promise<void> {
  const startedAt = Date.now();
  try {
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
      "hydrate start",
      {},
      {
        context: "background",
        event: "FLOW",
        action: "hydrate",
        source: HYDRATE_SOURCE,
      },
    );
    // Arkade: load the wallet summary + stable boarding address. Idempotent —
    // the boarding address is deterministic, so this never rotates it.
    await walletService.generateNewAddress();
    // On-chain: rebuild the MuSig2+CSV wallet from the cached public keys and
    // publish its receive address. Both rails are live at once, so this runs
    // unconditionally — it is a no-op (returns null) for an identity that has
    // no on-chain wallet, and needs no biometric prompt (public keys only).
    // Must precede the balance refresh, which reads musig2Address to decide
    // whether to query the on-chain rail at all.
    await hydrateMusig2Address();
    // #668: bundle LNURL receive hydration into startup so the Lightning
    // address is ready before the user opens Receive. No-prompt: reuses any
    // primed PRF assertion, else falls back to the persisted status. Balance
    // refresh and LNURL hydration are independent network calls, so run them
    // concurrently to keep startup/unlock latency down.
    await Promise.all([bitcoinBalanceStore.refresh("event"), hydrateArkadeLnurlStatus()]);
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
      "hydrate ok",
      { durMs: Date.now() - startedAt },
      {
        context: "background",
        event: "STATE",
        action: "hydrate",
        source: HYDRATE_SOURCE,
      },
    );
  } catch (e: unknown) {
    // Best-effort warm-up (the screen's own poll still refreshes on mount), but
    // the failure must surface in logs rather than being swallowed silently.
    const msg = e instanceof Error ? e.message : String(e);
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
      "hydrate failed",
      { message: msg, durMs: Date.now() - startedAt },
      {
        context: "background",
        event: "API_ERR",
        action: "hydrate",
        source: HYDRATE_SOURCE,
      },
    );
  }
}

export async function hydrateBitcoinOnUnlock(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await runHydrate();
  } finally {
    inFlight = false;
  }
}

/**
 * Call on in-app passkey login (new session/identity in the same JS process).
 * Sign-out doesn't restart the process, so the balance/address singletons can
 * still hold the previous user's state. Drop the prior session's wallet
 * descriptor + address + balance so nothing stale can be re-derived or shown,
 * then force a hydrate (a prior post-unlock hydrate may still hold the inFlight
 * guard, so we bypass it here to guarantee the new identity warms).
 */
export async function bootstrapBitcoinOnLogin(): Promise<void> {
  logWithId(
    `${LOG_EMOJI.bitcoin} Bitcoin.bootstrap`,
    "login bootstrap",
    {},
    {
      context: "background",
      event: "FLOW",
      action: "hydrate",
      source: "services/bitcoin/BitcoinBootstrapService.ts#bootstrapBitcoinOnLogin",
    },
  );
  walletService.resetAddressState();
  bitcoinBalanceStore.reset();
  // #668: drop the prior identity's LNURL snapshot so a new credential never
  // re-paints a stale Lightning address before its own status hydrates.
  resetArkadeLnurlCache();
  await clearArkadeBoardingAddressCache();
  // The credential-scoped MuSig2 cache slot is deliberately NOT cleared: it is
  // scoped to a credential, so a new identity reads null from it anyway, while a
  // returning one needs it — when the signer is unreachable the address falls
  // back to confirming the CSV policy against this cached address, and an empty
  // slot would take the L1 address and balance away until the signer answers
  // again. `resetAddressState()` unbinds the in-memory MuSig2 descriptor instead,
  // so nothing can derive a send source from the identity being replaced.
  await runHydrate();
}
