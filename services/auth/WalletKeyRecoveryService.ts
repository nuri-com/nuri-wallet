import { PRF_SALT } from "../../config/constants";
import { WALLET_RP_ID } from "../../config/passkey";
import { normalizePrfOutput, zeroize } from "../../lib/crypto";
import { logWithId } from "../../lib/OperationLogUtils";
import { adoptRecoveredWalletKeys, getEthereumAddress } from "../../lib/secureKeyStorage";
import { authStateManager } from "./AuthStateService";
import { useExistingWalletPasskey } from "./PasskeyNativeModuleService";
import {
  deriveWalletRootsFromPrf,
  persistSwapKitHtlcRootsFromPrf,
  type PrfBootstrapResult,
} from "./PasskeyPrfWalletBootstrapService";

/**
 * "recovered" — the unlock entry was rebuilt and the session is open.
 * "wrong_wallet" — the ceremony produced a different wallet; nothing was written.
 * "unavailable" — no passkey, no identity to verify against, or the ceremony or
 * the write failed. Nothing was written either way.
 */
export type WalletKeyRecoveryOutcome = "recovered" | "wrong_wallet" | "unavailable";

/**
 * Rebuild the combined unlock entry from the passkey PRF.
 *
 * The Keychain is only a cache: both roots are derived deterministically from
 * the PRF, so a wallet whose unlock entry went missing (bootstrap interrupted
 * before the combined commit, a single-key restore that dropped it) or became
 * unreadable (biometric enrolment changed under BIOMETRY_CURRENT_SET, corrupt
 * payload) is not lost — it just needs the entry written again. Retrying the
 * same read never fixes any of those.
 *
 * Fails closed on identity: the derived EVM address must equal the public
 * address this device already stores, so a different passkey can never quietly
 * replace the wallet the user is signed into. Deletes nothing under any outcome.
 */
export async function recoverWalletKeysFromPasskey(): Promise<WalletKeyRecoveryOutcome> {
  // The wallet this device is signed into. Without it there is nothing to check
  // the ceremony against, and overwriting the unlock entry unverified could
  // point the app at a different wallet entirely.
  const expected = (await getEthereumAddress())?.trim().toLowerCase() ?? "";
  if (!expected) {
    logWithId("🔐 KeyRecovery", "no stored address to verify against");
    return "unavailable";
  }

  const credIdHint =
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || undefined;

  let derived: PrfBootstrapResult | null = null;
  let prf: Uint8Array | null = null;
  try {
    const result = await useExistingWalletPasskey(WALLET_RP_ID, PRF_SALT, credIdHint);
    prf = normalizePrfOutput(result.prfB64 || "");
    if (!prf.length) {
      logWithId("🔐 KeyRecovery", "passkey returned an empty PRF");
      return "unavailable";
    }
    // Side-effect-free on purpose: the user may pick any passkey in the
    // ceremony, and until the address matches, NOTHING derived from it may
    // reach storage. bootstrapWalletFromPrf would already have written this
    // wallet's SwapKit HTLC roots by the time it returned an address to check.
    derived = deriveWalletRootsFromPrf(prf);
    if (derived.ethereumAddress.trim().toLowerCase() !== expected) {
      logWithId("🔐 KeyRecovery", "passkey belongs to a different wallet");
      return "wrong_wallet";
    }
    await adoptRecoveredWalletKeys(derived.bitcoinPrivateKey, derived.ethereumPrivateKey);
    // Confirmed the same wallet, so its roots are the ones already on disk —
    // rewriting them is idempotent, and repairs them if this recovery was
    // triggered by storage that lost more than the unlock entry.
    await persistSwapKitHtlcRootsFromPrf(prf);
    logWithId("🔐 KeyRecovery", "unlock entry rebuilt from passkey");
    return "recovered";
  } catch (error: unknown) {
    logWithId("🔐 KeyRecovery", "passkey recovery failed", {
      err: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  } finally {
    if (prf) zeroize(prf);
    if (derived) {
      zeroize(derived.bitcoinPrivateKey);
      zeroize(derived.ethereumPrivateKey);
    }
  }
}
