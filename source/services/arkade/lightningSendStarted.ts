import {
  getArkadeLightningSendOwnerKey,
  hasArkadeLightningSendFor,
} from "./internal/lightningSendStore";

/**
 * Whether this wallet ever started a Lightning send for a payment hash: one on
 * record (in flight, funded, or abandoned at the passkey prompt) or one that
 * settled and was deleted. Fails closed: no wallet identity or an unreadable
 * store counts as started.
 */
export async function lightningSendStartedFor(paymentHash: string): Promise<boolean> {
  try {
    const owner = await getArkadeLightningSendOwnerKey();
    if (!owner) return true;
    return await hasArkadeLightningSendFor(owner, paymentHash);
  } catch {
    return true;
  }
}
