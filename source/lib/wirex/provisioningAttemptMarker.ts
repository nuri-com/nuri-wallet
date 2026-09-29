// lib/wirex/provisioningAttemptMarker.ts
// Durable record of the last time this device asked Wirex to PROVISION an
// account (#1090).
//
// Wirex provisions asynchronously: the request returns while the card is not yet
// in the account's card list. A second provisioning request inside that window
// mints a SECOND card, and the window outlives the process — the app can be
// killed right after the request and relaunched before the card appears, at
// which point the account looks exactly as unprovisioned as it did before.
// In-memory guards are gone by then, so the attempt has to be written down.
//
// Every email-bearing call is such an attempt — onboarding's /onboard/start and
// the repair's /status?email alike — so the marker is written by WirexService at
// those two chokepoints rather than by their callers, and there is one record
// whichever path made the attempt.
//
// Wallet-keyed: one account's attempt says nothing about another's. Stamped, so
// an attempt that provisioned nothing is retried on a later launch instead of
// wedging the account forever.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_PREFIX = "@nuri:wirexProvisioningAttempt:v1:";

// Long enough to cover Wirex's async issuance many times over, short enough that
// an attempt which provisioned nothing is retried the same day.
export const PROVISIONING_ATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;

const keyFor = (wallet: string): string => `${KEY_PREFIX}${wallet.trim().toLowerCase()}`;

/**
 * Record a provisioning attempt for this wallet. Called BEFORE the request, not
 * after: an attempt whose response is lost (timeout, app killed) may still have
 * provisioned, so the relaunch that follows has to see it.
 *
 * Returns false when nothing durable was written — no wallet to key it by, or
 * storage refused. Callers must treat that as "do not provision": an unguarded
 * request is the duplicate-card condition this marker exists to prevent, and a
 * request not made is recoverable on the next attempt.
 */
export async function markProvisioningAttempt(wallet: string | null | undefined): Promise<boolean> {
  if (!wallet) return false;
  try {
    await AsyncStorage.setItem(keyFor(wallet), JSON.stringify({ at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** ms since this wallet's last recorded attempt, or null when there is none. */
export async function readProvisioningAttemptAge(
  wallet: string | null | undefined,
): Promise<number | null> {
  if (!wallet) return null;
  try {
    const raw = await AsyncStorage.getItem(keyFor(wallet));
    if (!raw) return null;
    const at = Number(JSON.parse(raw)?.at);
    if (!Number.isFinite(at)) return null;
    // A clock that moved backwards (timezone/NTP) must not read as "fresh
    // forever": treat a stamp in the future as no record at all.
    const age = Date.now() - at;
    return age < 0 ? null : age;
  } catch {
    return null;
  }
}

/** True while an attempt is recent enough that its products may still be landing. */
export async function isProvisioningAttemptSettling(
  wallet: string | null | undefined,
): Promise<boolean> {
  const age = await readProvisioningAttemptAge(wallet);
  return age !== null && age < PROVISIONING_ATTEMPT_COOLDOWN_MS;
}
