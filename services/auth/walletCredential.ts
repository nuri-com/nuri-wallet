import { authStateManager } from "./AuthStateService";

/**
 * The wallet passkey credential the cached receive addresses belong to. Both caches are scoped to it,
 * so a value written by another identity is never handed back — an address is what a user pays into.
 * Also the identity a MuSig2 descriptor is bound to, so a source derived from one account can never be
 * used while another is loaded.
 */
export function currentWalletCredId(): string | null {
  return authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || null;
}
