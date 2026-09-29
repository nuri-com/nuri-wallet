// SwapKit v2 recovery key (contract 2.2.0).
//
// The v2 contract requires a wallet-generated `recoveryKey` on every authed
// call (commit/submit/status/list/cancel). The server persists only its
// SHA-256 hash and indexes orders by that hash, so a wallet that reproduces the
// same recoveryKey after a full app-data wipe can re-adopt its pending orders
// via `swap_list`.
//
// Product decision (owner): the recoveryKey is NOT private material and must
// NEVER trigger a passkey/FaceID prompt. Key it on the passkey CREDENTIAL ID
// (`walletPasskeyCredIdB64u`) — this is the identity the Arkade server already
// binds an account to, it is known from the ordinary passkey invocation at
// login (no fresh assertion), it is public material carried in
// `walletPublicKeys`, and it survives wipe+restore because restoring the same
// passkey reproduces the same credId. When the credId is not yet populated
// (older sessions/native paths mid-migration) we fall back to the wallet EOA
// address, which is equally public and equally wipe-stable. No signing key is
// touched and no new derivation scheme is added to the wallet.
import { bytesToHex, sha256 } from "../../lib/crypto";
import { authStateManager } from "../auth/AuthStateService";
import { getEthereumAddress } from "../../lib/secureKeyStorage";

const RECOVERY_KEY_DOMAIN = "nuri/swapkit/recovery/v1";

/** Domain-separated fixed-length token derived from a public, wipe-stable
 * wallet identity. Not a secret — a restore-lookup handle. */
function deriveFromIdentity(identity: string): string {
  const value = String(identity || "").trim();
  if (!value) throw new Error("recoveryKey derivation requires a wallet identity");
  const digest = sha256(new TextEncoder().encode(`${RECOVERY_KEY_DOMAIN}:${value}`));
  // 64 hex chars — satisfies the contract's `^.{32,}$` and is opaque on the wire.
  return bytesToHex(digest);
}

/** The passkey credential id this session is bound to, if known (no prompt). */
function currentPasskeyCredId(): string | null {
  return authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || null;
}

/** Derive the recoveryKey from a known credId (preferred) or EOA fallback. */
export function deriveSwapKitV2RecoveryKey(opts: {
  credIdB64u?: string | null;
  ownerAddress?: string | null;
}): string {
  const credId = opts.credIdB64u?.trim();
  if (credId) return deriveFromIdentity(`cred:${credId}`);
  const owner = opts.ownerAddress?.trim().toLowerCase();
  if (owner) return deriveFromIdentity(`eoa:${owner}`);
  throw new Error("recoveryKey derivation requires a passkey credId or wallet owner address");
}

/** Resolve the recoveryKey for the signed-in wallet without any prompt. Prefers
 * the passkey credId (the Arkade account binding); falls back to the EOA. */
export async function getSwapKitV2RecoveryKey(): Promise<string> {
  const credId = currentPasskeyCredId();
  if (credId) return deriveSwapKitV2RecoveryKey({ credIdB64u: credId });
  const owner = await getEthereumAddress();
  if (!owner)
    throw new Error("No passkey credId or wallet address available; cannot derive recoveryKey");
  return deriveSwapKitV2RecoveryKey({ ownerAddress: owner });
}
