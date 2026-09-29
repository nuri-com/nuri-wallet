/**
 * Whether a MuSig2 descriptor may be used as a send source for the credential that is loaded now.
 *
 * `WalletService.wallet` is an in-memory singleton and outlives an in-app account switch:
 * `bootstrapBitcoinOnLogin()` resets address state, but the descriptor stays installed until
 * hydration rebuilds it. Deriving a send address from an unbound descriptor hands out the *previous*
 * account's address, so every value is required to be positive and equal:
 * - no descriptor credential (never bound, or unbound by `resetAddressState()`) → refuse;
 * - no current credential (auth state not loaded yet) → refuse rather than assume it matches.
 */
export function isSendSourceBoundToCredential(
  descriptorCredId: string | null,
  currentCredId: string | null,
): boolean {
  return !!descriptorCredId && descriptorCredId === currentCredId;
}
