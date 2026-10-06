// Address book screen decisions, kept out of the component so they are
// testable without a renderer. Nothing here touches UI or a service.
import {
  type Destination,
  type DestinationType,
  destinationKey,
  MAX_DESTINATIONS,
  normalizeDestination,
  normalizeIban,
} from "../../lib/addressBook/contact";
import { isNuriLightningAddress } from "../../lib/pay/nuriUsername";
import { isValidEvmAddress } from "../../lib/validation";

/** Which existing send flow a destination opens in, and with what. */
export type SendRoute =
  | { kind: "bitcoin"; target: string; rail: "arkade" | "onchain" | "auto" }
  /** asset null: a general EVM address, paid from euro or dollar like a scanned 0x. */
  | { kind: "evm"; address: string; asset: "EURC" | "USDC" | null }
  | { kind: "sepa"; iban: string; bic: string; holder: string }
  | { kind: "unsupported"; reason: "network" | "rail" | "address" };

/**
 * Map a saved destination onto the app's existing send flows — the same
 * handlers a scanned code reaches. Only what the app can pay today routes;
 * everything else says why instead of guessing a rail.
 */
export function routeDestination(destination: Destination, contactLabel = ""): SendRoute {
  switch (destination.type) {
    case "crypto":
      // Arkade pays BTC only; an Ark contact saved for another asset (the
      // CLI/MCP accepts any) must not open a BTC send to that address.
      if (destination.network === "ark" && destination.asset === "BTC")
        return { kind: "bitcoin", target: destination.raw, rail: "arkade" };
      if (destination.network === "bitcoin" && destination.asset === "BTC") {
        return { kind: "bitcoin", target: destination.raw, rail: "auto" };
      }
      if (
        (destination.network === "evm" && destination.asset === "ANY") ||
        (destination.network === "base" &&
          (destination.asset === "EURC" || destination.asset === "USDC"))
      ) {
        // Same check the wallet send applies to a scan: a saved string that is
        // not an EVM address (the CLI/MCP stores any text) is not payable.
        if (!isValidEvmAddress(destination.raw)) return { kind: "unsupported", reason: "address" };
        return {
          kind: "evm",
          address: destination.raw.trim(),
          asset: destination.network === "evm" ? null : (destination.asset as "EURC" | "USDC"),
        };
      }
      return { kind: "unsupported", reason: "network" };
    case "lightning":
      // A Nuri user's `@nuri.com` address cannot receive (no Lightning receive
      // today), so a contact saved with one before is paid at its other rails.
      if (isNuriLightningAddress(destination.raw)) return { kind: "unsupported", reason: "rail" };
      return { kind: "bitcoin", target: destination.raw, rail: "arkade" };
    case "bank":
      return {
        kind: "sepa",
        iban: destination.iban,
        bic: destination.bic ?? "",
        // The account holder when saved, else the contact's name: SEPA can't
        // continue with blank names.
        holder: (destination.holder ?? "").trim() || contactLabel.trim(),
      };
    default:
      return { kind: "unsupported", reason: "rail" };
  }
}

/** Networks the add form offers for a crypto destination, with their assets. */
export const CRYPTO_NETWORK_OPTIONS: Array<{ network: string; asset: string }> = [
  { network: "bitcoin", asset: "BTC" },
  { network: "ark", asset: "BTC" },
  { network: "base", asset: "EURC" },
  { network: "base", asset: "USDC" },
  // One 0x address, any EVM token: the send asks euro or dollar, like a scan.
  { network: "evm", asset: "ANY" },
];

export const DESTINATION_TYPES: DestinationType[] = [
  "crypto",
  "lightning",
  "bank",
  "phone",
  "email",
];

/** One-line description of a destination for list rows. */
/**
 * One short line for a suggestion row, under the contact's name: the kind and
 * just enough of the address to tell two apart ("IBAN · MT18 … 0000").
 */
export function destinationHint(destination: Destination): string {
  const ends = (value: string, head: number, tail: number) =>
    value.length > head + tail + 1 ? `${value.slice(0, head)} … ${value.slice(-tail)}` : value;
  switch (destination.type) {
    case "bank":
      return `${destinationLabel(destination)} · ${ends(destination.iban.replace(/\s+/g, ""), 4, 4)}`;
    case "crypto":
    case "lightning":
      return `${destinationLabel(destination)} · ${ends(destination.raw, 6, 4)}`;
    case "phone":
      return destination.e164;
    case "email":
      return destination.email;
  }
}

export function destinationSummary(destination: Destination): string {
  const short = (value: string) =>
    value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
  switch (destination.type) {
    case "crypto":
      return `${destination.asset} · ${destination.network} · ${short(destination.raw)}`;
    case "lightning":
      return `Lightning · ${short(destination.raw)}`;
    case "bank":
      return `IBAN · ${destination.iban.replace(/(.{4})/g, "$1 ").trim()}`;
    case "phone":
      return destination.e164;
    case "email":
      return destination.email;
  }
}

/**
 * Saved destinations the Bitcoin send screen can pay (onchain, Arkade, Lightning). */
export function acceptsBitcoinSend(destination: Destination): boolean {
  return routeDestination(destination).kind === "bitcoin";
}

/** Saved destinations the wallet send can pay: EVM addresses, or Base ones saved for this asset. */
export function acceptsWalletSend(asset: "EURC" | "USDC"): (destination: Destination) => boolean {
  return (destination) => {
    const route = routeDestination(destination);
    return route.kind === "evm" && (route.asset === null || route.asset === asset);
  };
}

/** Saved destinations the SEPA recipient step can pay. */
export function acceptsBankSend(destination: Destination): boolean {
  return destination.type === "bank";
}

/** What a finished send offers to save: the destination and a name to start from. */
export type SaveOffer = { destination: Destination; name?: string; nuriUsername?: string };

/**
 * The saveable destination of a finished Bitcoin send, or null. A BOLT11
 * invoice is single-use and a remittance phone number is not a Bitcoin
 * destination, so neither is offered; a Lightning address / LNURL is.
 */
/** One destination row of the add/edit form. */
export type DraftDestination = {
  type: DestinationType;
  raw: string;
  networkIndex: number;
  bic: string;
  holder: string;
  /** A saved destination's own label ("onchain", "boarding"), kept through an edit. */
  label?: string;
  /**
   * A saved crypto network/asset this form has no kind for (the core and the
   * desktop tools allow any, e.g. solana/USDC). Saved back as it was; cleared
   * only when the user picks another kind for the row.
   */
  other?: { network: string; asset: string };
};

export const emptyDraftDestination = (type: DestinationType = "crypto"): DraftDestination => ({
  type,
  raw: "",
  networkIndex: 0,
  bic: "",
  holder: "",
});

/**
 * A form row switched to another type starts empty: an EVM address is never
 * carried into the IBAN field (or the other way round). Same type: unchanged.
 */
export function retypeDraftDestination(
  entry: DraftDestination,
  type: DestinationType,
): DraftDestination {
  return entry.type === type ? entry : emptyDraftDestination(type);
}

/** The form row for a saved destination (see AddressBookScreen). */
export function draftFieldsFor(destination: Destination): DraftDestination {
  const found =
    destination.type === "crypto"
      ? CRYPTO_NETWORK_OPTIONS.findIndex(
          (o) => o.network === destination.network && o.asset === destination.asset,
        )
      : 0;
  const networkIndex = Math.max(0, found);
  const other =
    destination.type === "crypto" && found < 0
      ? { other: { network: destination.network, asset: destination.asset } }
      : {};
  return {
    ...other,
    type: destination.type,
    raw: destination.type === "bank" ? destination.iban : destination.raw,
    networkIndex,
    bic: destination.type === "bank" ? (destination.bic ?? "") : "",
    holder: destination.type === "bank" ? (destination.holder ?? "") : "",
    ...(destination.label ? { label: spelledLabel(destination.label) } : {}),
  };
}

/** A form row as a destination to validate and save (the core normalizes it). */
export function destinationFromDraft(entry: DraftDestination): Destination {
  const label = entry.label ? { label: entry.label } : {};
  return { ...destinationFromDraftFields(entry), ...label } as Destination;
}

function destinationFromDraftFields(entry: DraftDestination): Destination {
  switch (entry.type) {
    case "crypto": {
      const option =
        entry.other ?? CRYPTO_NETWORK_OPTIONS[entry.networkIndex] ?? CRYPTO_NETWORK_OPTIONS[0];
      return { type: "crypto", raw: entry.raw, network: option.network, asset: option.asset };
    }
    case "bank":
      return { type: "bank", raw: entry.raw, iban: "", bic: entry.bic, holder: entry.holder };
    case "phone":
      return { type: "phone", raw: entry.raw, e164: "" };
    case "email":
      return { type: "email", raw: entry.raw, email: "" };
    default:
      return { type: "lightning", raw: entry.raw };
  }
}

/**
 * Fills the empty BIC of every bank row whose IBAN has a known BIC. A typed BIC
 * is never replaced. Returns the same array when nothing changed.
 */
export function fillKnownBics(
  entries: DraftDestination[],
  known: ReadonlyMap<string, string>,
): DraftDestination[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.type !== "bank" || entry.bic.trim()) return entry;
    const bic = known.get(normalizeIban(entry.raw));
    if (!bic) return entry;
    changed = true;
    return { ...entry, bic };
  });
  return changed ? next : entries;
}

/** Every filled-in row of the form, in order; empty rows are dropped. */
export function destinationsFromDraft(entries: DraftDestination[]): Destination[] {
  return entries.filter((e) => e.raw.trim()).map(destinationFromDraft);
}

/** The small label above a destination on the contact page ("USDC · Base", "IBAN"). */
/** Our spelling is "onchain"; contacts saved before this fix say "on-chain". */
function spelledLabel(label: string): string {
  return label.replace(/\bon-chain\b/gi, "onchain");
}

export function destinationLabel(destination: Destination): string {
  const label = destination.label ? spelledLabel(destination.label) : "";
  if (destination.type === "crypto" && destination.network === "bitcoin") {
    // The two Bitcoin addresses a Nuri user publishes, named for what they are.
    if (label === "onchain") return "BTC Nuri";
    if (label === "boarding") return "BTC Arkade Boarding";
  }
  const base = destinationKindLabel(destination);
  return label ? `${base} · ${label}` : base;
}

/** Plain names: "BTC", "BTC Arkade", "USDC Base", "EVM", "IBAN". */
function destinationKindLabel(destination: Destination): string {
  switch (destination.type) {
    case "crypto": {
      if (destination.network === "evm") return "EVM";
      if (destination.network === "bitcoin") return destination.asset;
      const network =
        destination.network === "ark"
          ? "Arkade"
          : destination.network === "base"
            ? "Base"
            : destination.network;
      return `${destination.asset} ${network}`;
    }
    case "lightning":
      return "Lightning";
    case "bank":
      return "IBAN";
    case "phone":
      return "Phone";
    case "email":
      return "Email";
  }
}

/** The full value shown (and copied) for a destination: never shortened. */
export function destinationValue(destination: Destination): string {
  switch (destination.type) {
    case "bank":
      return destination.iban.replace(/(.{4})/g, "$1 ").trim();
    case "phone":
      return destination.e164;
    case "email":
      return destination.email;
    default:
      return destination.raw.trim();
  }
}

/** Contacts filed under their initial, A–Z then "#", like a phone's contact list. */
export function groupByInitial<T extends { label: string }>(
  contacts: T[],
  initialOf: (name: string) => string,
): Array<{ letter: string; contacts: T[] }> {
  const groups = new Map<string, T[]>();
  for (const contact of [...contacts].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  )) {
    const letter = initialOf(contact.label);
    groups.set(letter, [...(groups.get(letter) ?? []), contact]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
    .map(([letter, list]) => ({ letter, contacts: list }));
}

/** What the Nuri directory serves for a username (lib/pay/resolvePayRecipient). */
export type NuriUserRails = {
  lightningAddress: string | null;
  evmAddress: string | null;
  arkadeAddress: string | null;
  /** Boarding address (funds Arkade). */
  btcAddress: string | null;
  /** Co-signed onchain wallet address. */
  onchainAddress?: string | null;
};

/**
 * Every destination a Nuri user can be paid at: their one EVM address (euro or
 * dollar), their Arkade and Bitcoin addresses. Only what the directory actually
 * lists. Their `@nuri.com` Lightning address is left out: Lightning receive is
 * not available, so a payment to it cannot arrive.
 */
export function destinationsFromNuriUser(rails: NuriUserRails): Destination[] {
  const out: Destination[] = [];
  if (rails.lightningAddress && !isNuriLightningAddress(rails.lightningAddress)) {
    out.push({ type: "lightning", raw: rails.lightningAddress });
  }
  if (rails.evmAddress) {
    out.push({ type: "crypto", raw: rails.evmAddress, network: "evm", asset: "ANY" });
  }
  if (rails.arkadeAddress) {
    out.push({ type: "crypto", raw: rails.arkadeAddress, network: "ark", asset: "BTC" });
  }
  // Bitcoin onchain first: it is the user's onchain wallet. The boarding
  // address pays into their Arkade balance; both are plain bc1 addresses.
  if (rails.onchainAddress) {
    out.push({
      type: "crypto",
      raw: rails.onchainAddress,
      network: "bitcoin",
      asset: "BTC",
      label: "onchain",
    });
  }
  if (rails.btcAddress) {
    out.push({
      type: "crypto",
      raw: rails.btcAddress,
      network: "bitcoin",
      asset: "BTC",
      label: "boarding",
    });
  }
  return out;
}

function draftKey(entry: DraftDestination): string | null {
  try {
    // Identity only: a bank row is the same destination before its BIC is in.
    return destinationKey(normalizeDestination(destinationFromDraft(entry), true));
  } catch {
    return null;
  }
}

/**
 * A finished Nuri lookup applied to the form, only if it is still the form
 * the lookup was started from (same contact, same typed username). Anything
 * else (another contact opened, the field edited, the form closed) keeps the
 * form as it is: another user's rails never land in the wrong contact.
 */
export function applyNuriLookup<
  D extends { id?: string; name: string; nuriUsername: string; destinations: DraftDestination[] },
>(
  draft: D | null,
  lookup: {
    draftId: string | null;
    typed: string;
    username: string;
    rails: Parameters<typeof destinationsFromNuriUser>[0];
  },
): D | null {
  if (!draft || (draft.id ?? null) !== lookup.draftId || draft.nuriUsername !== lookup.typed) {
    return draft;
  }
  return {
    ...draft,
    nuriUsername: lookup.username,
    name: draft.name.trim() ? draft.name : lookup.username,
    destinations: mergeIntoDraft(draft.destinations, destinationsFromNuriUser(lookup.rails)),
  };
}

/**
 * The form's rows with a looked-up user's destinations added: empty rows give
 * way, anything already in the form is not added twice, the user's own rows
 * are kept as they are.
 */
export function mergeIntoDraft(
  entries: DraftDestination[],
  incoming: Destination[],
): DraftDestination[] {
  const kept = entries.filter((e) => e.raw.trim());
  const seen = new Set(kept.map(draftKey).filter((k): k is string => k !== null));
  const added = incoming.map(draftFieldsFor).filter((entry) => {
    const key = draftKey(entry);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Only what fits: a contact holds at most MAX_DESTINATIONS, and a form the
  // core would refuse to save helps nobody.
  const merged = [...kept, ...added.slice(0, Math.max(0, MAX_DESTINATIONS - kept.length))];
  return merged.length ? merged : [emptyDraftDestination()];
}

/** One entry of the form's "type" picker: kind of destination and, for crypto, which one. */
export type DestinationKind =
  | "evm"
  | "bitcoin"
  | "ark"
  | "base-usdc"
  | "base-eurc"
  | "lightning"
  | "bank"
  | "phone"
  | "email"
  /** A saved crypto network/asset the form has no kind for; kept, never offered. */
  | "other";

export const DESTINATION_KINDS: DestinationKind[] = [
  "lightning",
  "evm",
  "base-usdc",
  "base-eurc",
  "bank",
  "ark",
  "bitcoin",
  "phone",
  "email",
];

const CRYPTO_KIND_INDEX: Partial<Record<DestinationKind, number>> = {
  bitcoin: 0,
  ark: 1,
  "base-eurc": 2,
  "base-usdc": 3,
  evm: 4,
};

export function kindOf(entry: DraftDestination): DestinationKind {
  if (entry.type !== "crypto") return entry.type;
  if (entry.other) return "other";
  const option = CRYPTO_NETWORK_OPTIONS[entry.networkIndex] ?? CRYPTO_NETWORK_OPTIONS[0];
  if (option.network === "base") return option.asset === "EURC" ? "base-eurc" : "base-usdc";
  if (option.network === "evm") return "evm";
  return option.network === "ark" ? "ark" : "bitcoin";
}

/**
 * A row switched to another kind. Between the EVM kinds (any, USDC, EURC) the
 * address is the same one, so it stays; any other switch starts the row empty
 * (an EVM address is never carried into the IBAN field).
 */
export function withKind(entry: DraftDestination, kind: DestinationKind): DraftDestination {
  const current = kindOf(entry);
  if (current === kind) return entry;
  const cryptoIndex = CRYPTO_KIND_INDEX[kind];
  const isEvm = (k: DestinationKind) => k === "evm" || k.startsWith("base-");
  const bothBase = isEvm(current) && isEvm(kind);
  const base =
    cryptoIndex !== undefined
      ? { ...emptyDraftDestination("crypto"), networkIndex: cryptoIndex }
      : emptyDraftDestination(kind as DestinationType);
  return bothBase ? { ...base, raw: entry.raw } : base;
}
