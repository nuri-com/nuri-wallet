// One-tap passkey for the Payment Received screen (#1938).
//
// The screen fetches a server challenge before the tap (prepare), its button
// runs the passkey ceremony over that challenge on the tap itself, and the
// result is armed here together with the challenge's auth. The approval of the
// receive work (a Lightning claim or a boarding sweep) then takes it instead of
// opening a second confirm screen. Module-level because that approval may run
// on a different identity instance than the one the screen prepared with.
//
// No React Native or wallet imports: the slot is tested in the .test.ts lane.
import type { ArkadeAuthResponse } from "../ArkadeApiService";

export type ArmedUnlockPasskeyResult = {
  prfB64: string;
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type PreparedUnlockPasskey = {
  rpId: string;
  challengeB64u: string;
  credIdB64u: string;
  auth: ArkadeAuthResponse;
  preparedAtMs: number;
};

export type UnlockPasskeyItem = { kind: string };

export type UnlockPasskeyKind = "ln_receive_claim" | "boarding_sweep";

/**
 * One tap on the button, pinned when the ceremony starts: the challenge it
 * signs, the screen session it belongs to and the work it was started for.
 */
export type UnlockPasskeyAttempt = {
  prepared: PreparedUnlockPasskey;
  generation: number;
  kind: UnlockPasskeyKind;
};

/**
 * The server token behind a prepared challenge lives 300 s from the moment it
 * was fetched. An armed result older than this is dropped at approval time,
 * so the approval falls back to a fresh prompt instead of a refused token.
 */
export const ARMED_UNLOCK_PASSKEY_MAX_AGE_MS = 240_000;

/** How often the open screen fetches a new challenge, well inside the cap above. */
export const UNLOCK_PASSKEY_REFRESH_MS = 150_000;

/** Retry delay when fetching the challenge failed (the plain button stays meanwhile). */
export const UNLOCK_PASSKEY_RETRY_MS = 5_000;

let armed: {
  auth: ArkadeAuthResponse;
  result: ArmedUnlockPasskeyResult;
  preparedAtMs: number;
  kind: UnlockPasskeyKind;
} | null = null;

/**
 * Which receive work the screen's button can approve on one tap. Only a lone
 * item: one ceremony approves one approval, so with a Lightning claim and a
 * boarding sweep queued together the claim would take the result and the sweep
 * would need its own prompt after the button's page had taken the focus.
 */
export function oneTapUnlockPasskeyKind(
  items: ReadonlyArray<UnlockPasskeyItem>,
): UnlockPasskeyKind | null {
  if (items.length !== 1) return null;
  const kind = items[0]?.kind;
  return kind === "ln_receive_claim" || kind === "boarding_sweep" ? kind : null;
}

/**
 * A finished ceremony counts only for the attempt that started it, on the same
 * prefetch, while the screen session is still the one it started in and still
 * shows the same work. Anything else (screen hidden or dismissed and reopened,
 * the work changed or became mixed, a stray result) is dropped and runs nothing.
 */
export function acceptsUnlockPasskeyResult(
  attempt: UnlockPasskeyAttempt | null,
  current: {
    prepared: PreparedUnlockPasskey;
    generation: number;
    visible: boolean;
    kind: UnlockPasskeyKind | null;
  },
): attempt is UnlockPasskeyAttempt {
  return (
    attempt !== null &&
    current.visible &&
    attempt.prepared === current.prepared &&
    attempt.generation === current.generation &&
    attempt.kind === current.kind
  );
}

/** Arm an accepted attempt's result with the exact challenge it was signed over. */
export function armUnlockPasskey(
  attempt: UnlockPasskeyAttempt,
  result: ArmedUnlockPasskeyResult,
): void {
  const { prepared, kind } = attempt;
  if (prepared.auth.challenge !== prepared.challengeB64u) {
    armed = null;
    return;
  }
  armed = { auth: prepared.auth, result, preparedAtMs: prepared.preparedAtMs, kind };
}

/**
 * Single use: the approval for the work the tap was made for takes it; any
 * other approval gets null (and the result is gone) and prompts as usual.
 */
export function takeArmedUnlockPasskey(
  kind: UnlockPasskeyKind,
  nowMs = Date.now(),
): { auth: ArkadeAuthResponse; result: ArmedUnlockPasskeyResult } | null {
  const out = armed;
  armed = null;
  if (!out || out.kind !== kind) return null;
  const ageMs = nowMs - out.preparedAtMs;
  if (ageMs < 0 || ageMs > ARMED_UNLOCK_PASSKEY_MAX_AGE_MS) return null;
  return { auth: out.auth, result: out.result };
}

export function clearArmedUnlockPasskey(): void {
  armed = null;
}
