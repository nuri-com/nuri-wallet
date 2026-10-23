import type { PayIntent } from "./payIntent";

/**
 * The payment link the app was opened with, held until the signed-in home can
 * show it.
 *
 * A store rather than an event because the app is usually still booting (or
 * locked, or asking for a passkey) when the link arrives: an event emitted then
 * has no listener yet, and none of those steps may be skipped to reach the
 * screen faster.
 */
let pending: PayIntent | null = null;

export function queuePayIntent(intent: PayIntent): void {
  pending = intent;
}

/** The intent waiting to be shown, once. */
export function takePayIntent(): PayIntent | null {
  const next = pending;
  pending = null;
  return next;
}

/** Tests only: drop anything queued. */
export function clearPayIntent(): void {
  pending = null;
}
