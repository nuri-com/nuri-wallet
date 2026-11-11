// lib/send/evmRecipientCheck.ts
// Who may be paid at a plain `0x...` (#1783). A Nuri user is paid from any
// balance; anyone else only at an address whose network is named (`base:0x...`),
// at a Bitcoin address or over Lightning. A plain `0x...` (network "evm") names
// no network, so it is paid only when it belongs to a Nuri user, asked now, and
// then as that user. Pure: the lookups are injected.
import type { Destination } from "../addressBook/contact";
import { shortAddress } from "../formatting";
import type { SendRecipient } from "./sendRouting";

/**
 * The send sheet's note when a Nuri user is paid at another address than the
 * one scanned or saved for them (#1897), or null when there is nothing to say.
 * Compared against the address actually paid, case-insensitively, so it holds
 * whichever rail picked that address.
 */
export function paidAddressNote(
  replacedAddress: string | null | undefined,
  paidAddress: string,
): { scanned: string; paid: string } | null {
  const scanned = replacedAddress?.trim() ?? "";
  const paid = paidAddress.trim();
  if (!scanned || !paid || scanned.toLowerCase() === paid.toLowerCase()) return null;
  return { scanned: shortAddress(scanned), paid: shortAddress(paid) };
}

/** An EVM address with no network named. */
export const isUnnamedEvm = (destination: Destination): boolean =>
  destination.type === "crypto" && destination.network === "evm";

export type EvmRecipientLookup = {
  /** Lowercase address -> username, or null for nobody. Throws when it cannot ask. */
  usernames: (addresses: string[]) => Promise<Record<string, string | null>>;
  /** The Nuri user as a recipient, at the addresses their username has now;
   * null when the username pays nowhere. */
  nuriUser: (username: string) => Promise<SendRecipient | null>;
};

/**
 * The recipient to pay, or null when it is refused: an outside address with no
 * network named, and nothing else to pay them at. A recipient just looked up
 * by username is already current and need not come through here.
 */
export async function checkEvmRecipient(
  recipient: SendRecipient,
  lookup: EvmRecipientLookup,
): Promise<SendRecipient | null> {
  if (recipient.payout) return recipient;
  const unnamed = recipient.destinations.filter(isUnnamedEvm);
  if (unnamed.length === 0) return recipient;

  // A Nuri user is paid at the addresses their username has now, never at an
  // address saved or typed for them, which may be retired (#1770).
  const known = recipient.person?.nuriUsername?.toLowerCase();
  const key = (destination: Destination) => destination.raw.trim().toLowerCase();
  const usernames = known
    ? [known]
    : await lookup
        .usernames([...new Set(unnamed.map(key))])
        .then((names) => unnamed.map((destination) => names[key(destination)]));
  for (const username of usernames) {
    if (!username) continue;
    const user = await lookup.nuriUser(username);
    if (!user) continue;
    // Made visible, not refused (#1897): an old address still pays the user's
    // current one, but the send sheet names the address it replaced.
    const current = new Set(user.destinations.map(key));
    const replaced = unnamed.some((destination) => current.has(key(destination)))
      ? null
      : unnamed[0].raw.trim();
    return {
      ...user,
      ...(recipient.amountSats ? { amountSats: recipient.amountSats } : {}),
      ...(recipient.amountStable ? { amountStable: recipient.amountStable } : {}),
      ...(replaced ? { replacedAddress: replaced } : {}),
    };
  }
  // Nobody's: their other addresses (Bitcoin, Lightning, a named network) stay.
  const rest = recipient.destinations.filter((destination) => !isUnnamedEvm(destination));
  return rest.length > 0 ? { ...recipient, destinations: rest } : null;
}
