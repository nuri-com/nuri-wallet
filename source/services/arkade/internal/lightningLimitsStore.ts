// The Lightning send and receive limits the app shows while an amount is typed
// (dependency-free store; the hook and server read are in ../lightningLimits).
//
// They follow the solver's live card, which the Arkade server reads from the
// solver's relay (/arkade/lightning/limits), so a limit Arkade raises reaches
// the keypad without an app update. The fixed constants are only the fallback
// until the first answer, or while the server cannot be reached. The solver
// still refuses an amount it will not fill; these only say so earlier.

import {
  ARKADE_LIGHTNING_MAX_SEND_SATS,
  ARKADE_LIGHTNING_MIN_SEND_SATS,
  ARKADE_RECEIVE_MAX_SATS,
  ARKADE_RECEIVE_MIN_SATS,
} from "../../../config/constants";

export type SatsRange = { minSats: number; maxSats: number };
export type ArkadeLightningLimits = { send: SatsRange; receive: SatsRange };

export const FALLBACK_LIGHTNING_LIMITS: ArkadeLightningLimits = {
  send: { minSats: ARKADE_LIGHTNING_MIN_SEND_SATS, maxSats: ARKADE_LIGHTNING_MAX_SEND_SATS },
  receive: { minSats: ARKADE_RECEIVE_MIN_SATS, maxSats: ARKADE_RECEIVE_MAX_SATS },
};

/** Read the server again at most this often. */
const REFRESH_EVERY_MS = 5 * 60 * 1000;

let limits = FALLBACK_LIGHTNING_LIMITS;
let lastReadMs = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function range(raw: unknown): SatsRange | null {
  const r = raw as { min_sats?: unknown; max_sats?: unknown } | null | undefined;
  const minSats = Math.trunc(Number(r?.min_sats));
  const maxSats = Math.trunc(Number(r?.max_sats));
  if (!Number.isSafeInteger(minSats) || !Number.isSafeInteger(maxSats)) return null;
  if (minSats <= 0 || maxSats < minSats) return null;
  return { minSats, maxSats };
}

/**
 * The server's answer over the limits in hand: a missing or malformed side
 * keeps its current range (the last valid one, or the fallback before any).
 * Null when neither side is valid, so the read does not count as fresh.
 */
export function parseLightningLimits(
  raw: unknown,
  current: ArkadeLightningLimits = FALLBACK_LIGHTNING_LIMITS,
): ArkadeLightningLimits | null {
  const r = raw as { send?: unknown; receive?: unknown } | null | undefined;
  const send = range(r?.send);
  const receive = range(r?.receive);
  if (!send && !receive) return null;
  return { send: send ?? current.send, receive: receive ?? current.receive };
}

export function getArkadeLightningLimits(): ArkadeLightningLimits {
  return limits;
}

function setLimits(next: ArkadeLightningLimits): void {
  const same =
    next.send.minSats === limits.send.minSats &&
    next.send.maxSats === limits.send.maxSats &&
    next.receive.minSats === limits.receive.minSats &&
    next.receive.maxSats === limits.receive.maxSats;
  if (same) return;
  limits = next;
  for (const listener of listeners) listener();
}

/** Re-read the limits unless they were read in the last few minutes. */
export function refreshArkadeLightningLimits(
  read: () => Promise<unknown>,
  nowMs: number = Date.now(),
): Promise<void> {
  if (inFlight) return inFlight;
  if (lastReadMs && nowMs - lastReadMs < REFRESH_EVERY_MS) return Promise.resolve();
  inFlight = (async () => {
    try {
      const next = parseLightningLimits(await read(), limits);
      if (next) {
        setLimits(next);
        lastReadMs = nowMs;
      }
    } catch {
      // Unreachable or refused: keep what we have; the next open tries again.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function subscribeArkadeLightningLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetArkadeLightningLimitsForTest(): void {
  limits = FALLBACK_LIGHTNING_LIMITS;
  lastReadMs = 0;
  inFlight = null;
  listeners.clear();
}
