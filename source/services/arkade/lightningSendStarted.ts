import {
  getArkadeLightningSendOwnerKey,
  hasArkadeLightningSendFor,
} from "./internal/lightningSendStore";

/**
 * Whether this wallet ever started a Lightning send for a payment hash: one on
 * record (in flight, funded, or abandoned at the passkey prompt) or one that
 * settled and was deleted. Fails closed: no wallet identity or an unreadable
 * store counts as started.
 *
 * `exceptDeclinedOrderId`: that order's record does not count while it is
 * provably never-sent, i.e. the user cancelled its passkey prompt and no
 * funding txid exists for it (#1780). The caller still checks that order's
 * action journal.
 */
export async function lightningSendStartedFor(
  paymentHash: string,
  options: { exceptDeclinedOrderId?: string } = {},
): Promise<boolean> {
  try {
    const owner = await getArkadeLightningSendOwnerKey();
    if (!owner) return true;
    return await hasArkadeLightningSendFor(owner, paymentHash, options);
  } catch {
    return true;
  }
}
