// Guards the `nuri://factory-reset` deep link against the cold-start race with
// the launch biometric auto-unlock, WITHOUT trapping normal opens.
//
// The race: Linking.getInitialURL() resolves concurrently with launch init,
// which can present the biometric lock (resetMode=false) and start a non-reset
// auto-unlock BEFORE the deep-link handler sets reset mode. A successful unlock
// would then dismiss the lock before Delete wallet is reachable.
//
// The intent is armed ONLY while a non-reset auto-unlock is genuinely in flight —
// i.e. a wallet-unlocked notification is still expected to consume it — and is
// cleared if that attempt settles WITHOUT unlocking (cancel/failure). Using the
// live auto-access lifecycle (not lock visibility) is what keeps a normal open,
// a cancelled/failed auto, and an already-settled auto from leaving a stale flag
// that would force a second authentication to leave reset mode.
let autoAccessInFlight = false;
let pendingReset = false;

// BiometricLockModal brackets its non-reset auto-unlock with these.
export function noteAutoAccessStarted(): void {
  autoAccessInFlight = true;
}

export function noteAutoAccessSettled(unlocked: boolean): void {
  autoAccessInFlight = false;
  // A cancelled/failed auto-unlock produces no wallet-unlocked notification, so
  // nothing would consume an armed intent — clear it.
  if (!unlocked) pendingReset = false;
}

// Called by the factory-reset deep-link handler. Arms only if an auto-unlock can
// still land and dismiss the lock before reset mode takes hold.
export function armFactoryResetIfAutoAccessInFlight(): void {
  if (autoAccessInFlight) pendingReset = true;
}

export function consumePendingFactoryReset(): boolean {
  const wasPending = pendingReset;
  pendingReset = false;
  return wasPending;
}

// Test-only: reset module state between cases.
export function __resetFactoryResetIntentForTests(): void {
  autoAccessInFlight = false;
  pendingReset = false;
}
