// lib/send/sendRouting.ts
// The one send flow's rule: the balance the user pays from decides the route.
// A recipient address in that balance's currency is paid directly; otherwise
// the money is swapped into the currency of an address the recipient has.
// Pure: no UI, no service.
import { type Contact, type Destination, savedContactFor } from "../addressBook/contact";
import type { ZapRemitDestination } from "../remit/zapremitForm";
import { routeDestination } from "../../screens/addressBook/addressBookModel";
import { isValidBitcoinAddressMainnet } from "../bitcoin/address";

/** Every balance a send can be paid from. */
export type SendBalance = "wallet" | "dollar" | "arkade" | "onchain";

export const SEND_BALANCES: readonly SendBalance[] = ["wallet", "dollar", "arkade", "onchain"];

export const isBitcoinBalance = (balance: SendBalance): balance is "arkade" | "onchain" =>
  balance === "arkade" || balance === "onchain";

export type SendRoute =
  /** Euro or Dollar to a wallet address: a plain token transfer. */
  | { kind: "evm-direct"; address: string }
  /** Bitcoin to a Bitcoin, Ark or Lightning destination: the Bitcoin send. */
  | { kind: "bitcoin-direct"; target: string }
  /** Euro or Dollar to a Bitcoin address: swapped to BTC on the way. */
  | { kind: "swap-to-bitcoin"; address: string }
  /** Bitcoin to a wallet address, or Euro/Dollar to an address that takes only
   * the other stable: swapped on the way. `asset` is the stable the recipient
   * asked for, null when any stable will do. */
  | { kind: "swap-to-stable"; address: string; asset: "EURC" | "USDC" | null };

/** Who a send goes to: every address they can be paid at, as one recipient. */
export type SendRecipient = {
  destinations: Destination[];
  /** A person (saved contact or Nuri user), shown by name instead of an address. */
  person: { name: string; nuriUsername?: string } | null;
  /** A bank or mobile money account abroad, picked or scanned. */
  payout?: ZapRemitDestination;
  /** An amount the scanned or pasted code asked for, in sats or in the stable. */
  amountSats?: string;
  amountStable?: string;
};

export const isSwapRoute = (
  route: SendRoute | null,
): route is Extract<SendRoute, { kind: "swap-to-bitcoin" | "swap-to-stable" }> =>
  route?.kind === "swap-to-bitcoin" || route?.kind === "swap-to-stable";

type Routed = { destination: Destination; route: ReturnType<typeof routeDestination> };

function routed(destinations: Destination[]): Routed[] {
  return destinations.map((destination) => ({
    destination,
    route: routeDestination(destination),
  }));
}

const cashAsset = (balance: "wallet" | "dollar"): "EURC" | "USDC" =>
  balance === "dollar" ? "USDC" : "EURC";

/** A plain onchain Bitcoin address (the only Bitcoin target a swap can settle to). */
function bitcoinAddressOf({ destination, route }: Routed): string | null {
  if (route.kind !== "bitcoin" || destination.type !== "crypto") return null;
  if (destination.network !== "bitcoin") return null;
  return isValidBitcoinAddressMainnet(route.target) ? route.target : null;
}

/**
 * How `balance` pays a recipient with these destinations, or null when it
 * cannot. Direct beats a swap: an address in the balance's own currency is
 * always the one paid.
 */
export function routeFor(balance: SendBalance, destinations: Destination[]): SendRoute | null {
  const all = routed(destinations);
  if (balance === "wallet" || balance === "dollar") {
    const asset = cashAsset(balance);
    const evm = all.find(
      ({ route }) => route.kind === "evm" && (route.asset === null || route.asset === asset),
    );
    if (evm && evm.route.kind === "evm") return { kind: "evm-direct", address: evm.route.address };
    // An address that takes only the other stable (a token payment request).
    const other = all.find(({ route }) => route.kind === "evm" && route.asset !== null);
    if (other && other.route.kind === "evm" && other.route.asset) {
      return { kind: "swap-to-stable", address: other.route.address, asset: other.route.asset };
    }
    // A saved Bitcoin address: the plain onchain one before the boarding one,
    // which only funds the recipient's Arkade balance.
    const btc = all
      .filter((entry) => bitcoinAddressOf(entry) !== null)
      .sort(
        (a, b) =>
          Number(a.destination.label === "boarding") - Number(b.destination.label === "boarding"),
      )[0];
    const address = btc ? bitcoinAddressOf(btc) : null;
    return address ? { kind: "swap-to-bitcoin", address } : null;
  }

  // Bitcoin: the cheapest Bitcoin destination this wallet pays directly.
  const rank = (entry: Routed): number => {
    if (entry.route.kind !== "bitcoin") return Number.POSITIVE_INFINITY;
    const offchain = entry.route.rail === "arkade";
    if (balance === "arkade") {
      if (offchain) return 0;
      return entry.destination.label === "boarding" ? 2 : 1;
    }
    // The onchain wallet pays only plain Bitcoin addresses: an Ark address
    // cannot be paid from it, and a Lightning one would quietly pay from Arkade.
    if (bitcoinAddressOf(entry) === null) return Number.POSITIVE_INFINITY;
    return entry.destination.label === "boarding" ? 1 : 0;
  };
  const best = all
    .map((entry) => ({ entry, cost: rank(entry) }))
    .filter(({ cost }) => Number.isFinite(cost))
    .sort((a, b) => a.cost - b.cost)[0];
  if (best && best.entry.route.kind === "bitcoin") {
    return { kind: "bitcoin-direct", target: best.entry.route.target };
  }
  const evm = all.find(({ route }) => route.kind === "evm");
  if (evm && evm.route.kind === "evm") {
    return { kind: "swap-to-stable", address: evm.route.address, asset: evm.route.asset };
  }
  return null;
}

/**
 * How `balance` pays this recipient. A payout abroad is paid from Bitcoin, or
 * from Euro/Dollar where the Tanzanian corridor takes that stable (its banks
 * take USDC only).
 */
export function recipientRoute(
  balance: SendBalance,
  recipient: SendRecipient,
): SendRoute | { kind: "payout-direct" } | null {
  const { payout } = recipient;
  if (payout) {
    if (balance === "arkade") return { kind: "payout-direct" };
    if (balance === "onchain" || payout.provider !== "tz") return null;
    return balance === "wallet" && payout.methodCode === "TZ_BANK"
      ? null
      : { kind: "payout-direct" };
  }
  return routeFor(balance, recipient.destinations);
}

/** A saved contact as a recipient: the person, with every address they can be paid at. */
export function recipientFromContact(contact: Contact): SendRecipient {
  return {
    destinations: contact.destinations.filter(isSendableDestination),
    person: {
      name: contact.label,
      ...(contact.nuriUsername ? { nuriUsername: contact.nuriUsername } : {}),
    },
  };
}

/**
 * The recipient these addresses name. An address that belongs to a saved
 * contact is that person, with all of their addresses.
 */
export function recipientFromDestinations(
  contacts: Contact[],
  destinations: Destination[],
  /** Keep exactly these addresses (a code naming its token or amount): the
   * contact only names the person. */
  keepDestinations = false,
): SendRecipient {
  const contact = destinations
    .map((destination) => savedContactFor(contacts, destination.raw, isSendableDestination))
    .find((found): found is Contact => found !== null);
  if (!contact) return { destinations, person: null };
  const person = recipientFromContact(contact);
  // A Nuri contact's saved addresses only name past payments (#1770): the
  // address in hand is paid, not an older one of theirs.
  return keepDestinations || contact.nuriUsername ? { ...person, destinations } : person;
}

/** A Base address saved or scanned for one token pays only in that token. */
export const tokenDestination = (raw: string, asset: "EURC" | "USDC"): Destination => ({
  type: "crypto",
  raw,
  network: "base",
  asset,
});

/** Destinations any balance could pay, directly or by a swap. */
export function isSendableDestination(destination: Destination): boolean {
  return SEND_BALANCES.some((balance) => routeFor(balance, [destination]) !== null);
}

/**
 * The balance the amount screen opens on: the card Send was pressed on when it
 * can pay, otherwise one that pays without a swap, otherwise any that can pay.
 * Within each tier a balance holding money comes first, in `order`.
 */
export function defaultSendBalance(args: {
  recipient: SendRecipient;
  /** Balances in preference order: the card Send was pressed on first. */
  order: readonly SendBalance[];
  /** Spendable amount per balance; only > 0 matters. */
  held: Partial<Record<SendBalance, number>>;
  /** The card Send was pressed on, when there was one. */
  started: readonly SendBalance[];
}): SendBalance | null {
  const { recipient, order, held, started } = args;
  const funded = (balance: SendBalance) => (held[balance] ?? 0) > 0;
  const route = (balance: SendBalance) => recipientRoute(balance, recipient);
  const fromStart = started.find((balance) => funded(balance) && route(balance) !== null);
  if (fromStart) return fromStart;
  const direct = order.find(
    (balance) =>
      funded(balance) && route(balance) !== null && !isSwapRoute(route(balance) as SendRoute),
  );
  if (direct) return direct;
  const anyFunded = order.find((balance) => funded(balance) && route(balance) !== null);
  if (anyFunded) return anyFunded;
  return order.find((balance) => route(balance) !== null) ?? null;
}
