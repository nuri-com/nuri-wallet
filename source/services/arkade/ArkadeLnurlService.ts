// Prod-tier LNURL service for Arkade. Exposes the public lnurl status +
// username-claim surface used by the wallet UI. Cross-cutting helpers
// (emitTrace, truncateForLog, getOrCreateArkadeIdentity, getArkadeLnurlAssertion)
// are imported from services/arkade/internal/. The in-memory + persisted
// snapshot cache moved to services/arkade/internal/lnurlStatusCache.ts so
// internal receive-flow modules can read the snapshot without re-introducing
// the prod→internal→prod cycle flagged on PR #546.
// Emits EventBus event "arkade:lnurl:status" (payload ArkadeLnurlStatus) from
// hydrateArkadeLnurlStatus() during Bitcoin startup so the app can show
// the Lightning receive address before Receive is opened. Public receive
// metadata only — no secrets or assertion bytes.

import { getAccountEmail } from "../../lib/accountEmail";
import { getBitcoinAddress, getEthereumAddress } from "../../lib/secureKeyStorage";
import { authStateManager } from "../auth/AuthStateService";
import { EventBus } from "../events/AppEventBusService";
import { arkadeLnurlRegister, arkadeLnurlSetProfile, arkadeLnurlStatus } from "./ArkadeApiService";
import {
  getArkadeWalletSummarySnapshot,
  getLastGoodArkadeWalletSummarySnapshot,
} from "./ArkadeWalletService";
import { getArkadeLnurlAssertion, getOrCreateArkadeIdentity } from "./internal/identity";
import { emitTrace } from "./internal/logging";
import {
  getArkadeLnurlStatusSnapshot,
  readCachedLnurlStatus,
  resetArkadeLnurlCache,
  toLnurlStatus,
  writeCachedLnurlStatus,
} from "./internal/lnurlStatusCache";
import type { ArkadeLnurlStatus } from "./types/lnurl";

export {
  getArkadeLnurlStatusSnapshot,
  readCachedLnurlStatus,
  resetArkadeLnurlCache,
  toLnurlStatus,
};

// Locally known payment-link profile addresses, all read without biometrics:
// EVM + BTC from the public keychain slots, arkade from the in-memory wallet
// summary snapshot (null until the wallet summary has loaded once).
async function getLocalProfileAddresses(): Promise<{
  evmAddress: string | null;
  btcAddress: string | null;
  arkadeAddress: string | null;
  email: string | null;
}> {
  const [evmAddress, btcAddress] = await Promise.all([getEthereumAddress(), getBitcoinAddress()]);
  const summary = getArkadeWalletSummarySnapshot() || getLastGoodArkadeWalletSummarySnapshot();
  // The account email is entered during Wirex onboarding; sync it onto the Nuri
  // profile so it survives a reinstall/second device like the addresses do.
  const email = evmAddress ? await getAccountEmail(evmAddress) : null;
  return {
    evmAddress,
    btcAddress,
    arkadeAddress: summary?.arkAddress ? String(summary.arkAddress).toLowerCase() : null,
    email,
  };
}

type LnurlProfilePatch = {
  evm_address?: string;
  arkade_address?: string;
  btc_address?: string;
  email?: string;
};

// The set-profile patch of locally known addresses the given status is missing
// or has stale. Empty patch = nothing to sync (either the server is current or
// the missing values aren't known locally yet).
async function buildLnurlProfilePatch(status: ArkadeLnurlStatus): Promise<LnurlProfilePatch> {
  const local = await getLocalProfileAddresses();
  const patch: LnurlProfilePatch = {};
  if (local.evmAddress && status.evmAddress?.toLowerCase() !== local.evmAddress.toLowerCase()) {
    patch.evm_address = local.evmAddress;
  }
  if (local.arkadeAddress && status.arkadeAddress?.toLowerCase() !== local.arkadeAddress) {
    patch.arkade_address = local.arkadeAddress;
  }
  if (local.btcAddress && status.btcAddress?.toLowerCase() !== local.btcAddress) {
    patch.btc_address = local.btcAddress;
  }
  if (local.email && status.email?.toLowerCase() !== local.email.toLowerCase()) {
    patch.email = local.email;
  }
  return patch;
}

/**
 * Whether a registered status is missing (or has stale) profile addresses that
 * are known locally, i.e. whether a live status fetch would run a set-profile
 * backfill. Used by the receive flow to decide if opening Receive may prompt
 * for the passkey (one-time backfill) instead of refreshing silently.
 */
export async function needsLnurlProfileSync(status: ArkadeLnurlStatus | null): Promise<boolean> {
  if (!status?.registered) return false;
  return Object.keys(await buildLnurlProfilePatch(status)).length > 0;
}

// exported for debug-tier use during migration
export function normalizeLnurlUsername(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase();
}

function persistVerifiedWalletUsername(status: ArkadeLnurlStatus | null | undefined): void {
  const username = status?.registered ? normalizeLnurlUsername(status.username || "") : "";
  if (!username) return;
  // IDENTITY INVARIANT: a verified wallet username belongs to authenticated
  // account state. The LNURL snapshot is a receive cache and may be cold, reset,
  // delayed or absent; losing that cache must NEVER erase the user's identity or
  // make Home degrade to "Welcome there!" again.
  void authStateManager.setWalletUsername(username).catch(() => {});
}

/**
 * Like getArkadeLnurlStatusSnapshot but also tries the persisted AsyncStorage
 * cache when the in-memory singleton is empty (e.g. after process restart or
 * signOut+relogin). Use this when you want the username/address right after
 * boot without first triggering a live /arkade/lnurl/status fetch.
 */
export async function getArkadeLnurlStatusPersisted(): Promise<ArkadeLnurlStatus | null> {
  const status = getArkadeLnurlStatusSnapshot() || (await readCachedLnurlStatus());
  persistVerifiedWalletUsername(status);
  return status;
}

export async function getArkadeLnurlStatus(
  username?: string,
  options?: {
    allowPrompt?: boolean;
    reason?: string;
  },
): Promise<ArkadeLnurlStatus> {
  const normalized = normalizeLnurlUsername(username || "");
  const allowPrompt = options?.allowPrompt === true;
  const reason = options?.reason || "lnurl_status";
  const assertion = await getArkadeLnurlAssertion(reason, allowPrompt);
  if (!assertion) {
    const cached = await readCachedLnurlStatus();
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_status",
      status: "skipped",
      detail: `username=${normalized || "auto"} reason=${reason} prompt=0 auth=cached_prf_only cached=${cached ? 1 : 0} why=no_cached_prf_auth`,
    });
    return cached || toLnurlStatus({});
  }
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_status",
    status: "attempt",
    detail: `username=${normalized || "auto"} reason=${reason} prompt=${allowPrompt ? 1 : 0} auth=${allowPrompt ? "passkey_prf_assertion" : "cached_prf_assertion"}`,
  });
  const out = await arkadeLnurlStatus(assertion, normalized ? { username: normalized } : {});
  let status = toLnurlStatus(out);
  if (status.registered && status.username) {
    // Backfill any locally known profile address the server doesn't have yet
    // (or has stale). Only fields in the patch are updated server-side.
    const patch = await buildLnurlProfilePatch(status);
    if (Object.keys(patch).length > 0) {
      try {
        const profile = await arkadeLnurlSetProfile(assertion, {
          username: status.username,
          ...patch,
        });
        // Prefer the server's echoed value, then the patch value we just
        // submitted (a server that omits an accepted field must not leave the
        // cache looking unsynced — that would re-prompt and resend the same
        // patch on every Receive open), then the previous status value.
        status = {
          ...status,
          evmAddress: profile.evm_address ?? patch.evm_address ?? status.evmAddress,
          arkadeAddress: profile.arkade_address ?? patch.arkade_address ?? status.arkadeAddress,
          btcAddress: profile.btc_address ?? patch.btc_address ?? status.btcAddress,
          email: profile.email ?? patch.email ?? status.email,
        };
        emitTrace({
          atMs: Date.now(),
          op: "lnurl_profile_sync",
          status: "ok",
          detail: `username=${status.username} fields=${Object.keys(patch).join(",")}`,
        });
      } catch (error: unknown) {
        emitTrace({
          atMs: Date.now(),
          op: "lnurl_profile_sync",
          status: "failed",
          detail: `username=${status.username} fields=${Object.keys(patch).join(",")} error=${error instanceof Error ? error.name : "unknown"}`,
        });
      }
    }
  }
  writeCachedLnurlStatus(status);
  persistVerifiedWalletUsername(status);
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_status",
    status: "ok",
    detail: `username=${status.username || "n/a"} registered=${status.registered ? 1 : 0} published=${status.hasPublishedInvoice ? 1 : 0}`,
  });
  return status;
}

// Guarded fast-paint emit: only broadcast a status that carries receive info, so
// the intermediate persisted snapshot can't flash an empty value before the live
// result. The final live status is emitted unconditionally by the caller.
function emitLnurlStatus(status: ArkadeLnurlStatus | null): void {
  if (!status || !(status.registered || status.lightningAddress)) return;
  try {
    EventBus.emit("arkade:lnurl:status", status);
  } catch {}
}

/** Commit the bootstrap-register response without another passkey assertion. */
export function cacheArkadeLnurlRegistration(response: unknown): ArkadeLnurlStatus {
  const status = toLnurlStatus({
    ...(response && typeof response === "object" ? response : {}),
    registered: true,
  });
  if (!status.username || !status.lightningAddress) {
    throw new Error("bootstrap username registration response invalid");
  }
  writeCachedLnurlStatus(status);
  persistVerifiedWalletUsername(status);
  emitLnurlStatus(status);
  return status;
}

/**
 * No-prompt startup hydration of LNURL receive status (#668). Reads the
 * persisted snapshot for an immediate paint, then attempts a silent live refresh
 * that reuses any primed PRF assertion (allowPrompt:false → never pops a passkey,
 * falls back to the persisted snapshot). Emits "arkade:lnurl:status" for each
 * resolved status. Best-effort: never throws.
 */
export async function hydrateArkadeLnurlStatus(): Promise<void> {
  try {
    const persisted = await getArkadeLnurlStatusPersisted();
    emitLnurlStatus(persisted);
    const live = await getArkadeLnurlStatus(undefined, {
      allowPrompt: false,
      reason: "startup_hydrate",
    });
    // Always broadcast the resolved live status — even an empty one. On an
    // in-process credential switch to an unregistered/cleared account the live
    // status is empty; emitting it (rather than dropping it via the guard) lets
    // a mounted screen clear the previous credential's stale Lightning
    // address instead of holding it until the next Receive refresh.
    try {
      EventBus.emit("arkade:lnurl:status", live);
    } catch {}
  } catch (e: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_status",
      status: "skipped",
      detail: `reason=startup_hydrate why=hydrate_failed err=${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export async function claimArkadeLnurlUsername(username: string): Promise<ArkadeLnurlStatus> {
  const normalized = normalizeLnurlUsername(username);
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(normalized)) {
    throw new Error("username must be 3-32 chars [a-z0-9._-]");
  }
  const identity = await getOrCreateArkadeIdentity();
  const [assertion, pubCtx, local] = await Promise.all([
    identity.getPrfSigningAssertion(false, "lnurl_register"),
    identity.getSigningPublicContext(),
    // Public cached addresses (no biometrics); register the ENS/payment-link
    // profile alongside the username. Nulls are fine — the server treats them
    // as optional and they are backfilled via lnurl/set-profile on the next
    // status fetch once known locally.
    getLocalProfileAddresses(),
  ]);
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_register",
    status: "attempt",
    detail: `username=${normalized} evm=${local.evmAddress ? 1 : 0} ark=${local.arkadeAddress ? 1 : 0} btc=${local.btcAddress ? 1 : 0}`,
  });
  await arkadeLnurlRegister(assertion, {
    username: normalized,
    client_pk33: pubCtx.clientPk33,
    aggregated_pk33: pubCtx.aggregatedPk33,
    ...(local.evmAddress ? { evm_address: local.evmAddress } : {}),
    ...(local.arkadeAddress ? { arkade_address: local.arkadeAddress } : {}),
    ...(local.btcAddress ? { btc_address: local.btcAddress } : {}),
  });
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_register",
    status: "ok",
    detail: `username=${normalized}`,
  });
  return getArkadeLnurlStatus(normalized);
}
