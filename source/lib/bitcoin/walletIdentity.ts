/**
 * The identity a MuSig2 descriptor belongs to, captured before the async work that resolves its keys.
 *
 * Keys are resolved over an await (co-signer context) and an in-app login can replace the identity in
 * that window: `resetAddressState()` resets address state and the credentials change, but the previous
 * run keeps going. Anything that installs a descriptor therefore travels with the identity it started
 * under and is installed only while that identity is still the loaded one — a credential comparison
 * made at install time would accept the stale run, because by then the new credential is the current
 * one.
 */
export type WalletIdentity = {
  /** Credential the resolved keys belong to (null = the snapshot carried none). */
  credId: string | null;
  /** Identity epoch, bumped whenever the address state is reset for a new identity. */
  epoch: number;
};

/** Whether an install captured under `started` may still be applied while `current` is loaded. */
export function isSameWalletIdentity(started: WalletIdentity, current: WalletIdentity): boolean {
  return started.epoch === current.epoch && started.credId === current.credId;
}
