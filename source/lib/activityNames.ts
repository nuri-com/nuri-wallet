// lib/activityNames.ts
// Which addresses of an activity row the Nuri names lookup can name (#1782),
// and how one is kept in the address book. Euro/Dollar rows carry an EVM
// address; Bitcoin rows an Arkade address rebuilt from the payment's script, a
// sender's or a recipient's Bitcoin address. Pure.
import type { Destination } from "./addressBook/contact";
import { bitcoinDestination, evmDestination } from "./addressBook/nuriContacts";
import { isArkAddress, isValidBitcoinAddressMainnet } from "./bitcoin/address";
import { isValidEvmAddress } from "./validation";

type NameableRow = {
  saveOffer?: { destination: Destination } | null;
  counterpartyAddress?: string;
  counterpartyAddresses?: string[];
};

/** An address the names lookup answers for: EVM, Arkade or Bitcoin. */
export function isNameableAddress(address: string): boolean {
  return (
    isValidEvmAddress(address) || isArkAddress(address) || isValidBitcoinAddressMainnet(address)
  );
}

/** The other side's addresses, the one it was paid at first; none for a row without one. */
export function nameableAddresses(row: NameableRow): string[] {
  const out: string[] = [];
  for (const raw of [
    row.saveOffer?.destination.raw,
    row.counterpartyAddress,
    ...(row.counterpartyAddresses ?? []),
  ]) {
    const address = String(raw || "").trim();
    if (!address || !isNameableAddress(address)) continue;
    if (out.some((a) => a.toLowerCase() === address.toLowerCase())) continue;
    out.push(address);
  }
  return out;
}

/**
 * Who paid an onchain receive: the one address its inputs came from, or null
 * when they came from several or from this wallet's own (`own`, any case).
 */
export function singleInputAddress(
  vin: ReadonlyArray<{ prevout?: { scriptpubkey_address?: string } | null }> | undefined,
  own: Iterable<string>,
): string | null {
  const mine = new Set([...own].map((a) => a.trim().toLowerCase()));
  const from = new Set<string>();
  for (const input of vin ?? []) {
    const address = String(input?.prevout?.scriptpubkey_address || "").trim();
    if (address && !mine.has(address.toLowerCase())) from.add(address);
  }
  return from.size === 1 ? [...from][0] : null;
}

/** How an address seen in a payment is kept on the user's contact. */
export function seenDestination(address: string): Destination {
  if (isValidEvmAddress(address)) return evmDestination(address);
  return bitcoinDestination(address, isArkAddress(address));
}
