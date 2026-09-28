export const NURI_INTERNAL_LINK_PATTERN = /^(?:nuri|nuriwallet)(?:-[a-z0-9]+)?:\/\//i;

export const FACTORY_RESET_SCREEN = "factory-reset";
export const FACTORY_RESET_LINK = `nuri://${FACTORY_RESET_SCREEN}`;

export const SHOW_IBAN_SCREEN = "show-iban";
export const SHOW_CARD_NUMBER_SCREEN = "show-card-number";

export const V1_WALLET_MIGRATION_SCREEN = "v1-wallet-migration-screen";
export const V1_WALLET_MIGRATION_LINK = `nuri://${V1_WALLET_MIGRATION_SCREEN}`;

export const BITCOIN_SCREEN = "bitcoin";
export const CARD_SCREEN = "card";
export const WALLET_SCREEN = "wallet";

/**
 * Every destination the deep-link router in App.tsx can reach, in one place so
 * the router, notification payloads and the debug tools cannot drift apart.
 * A screen missing from here is rejected rather than routed.
 */
export const INTERNAL_LINK_DESTINATIONS = [
  { screen: BITCOIN_SCREEN, label: "Bitcoin tab" },
  { screen: CARD_SCREEN, label: "Card tab" },
  { screen: WALLET_SCREEN, label: "Wallet tab" },
  { screen: SHOW_IBAN_SCREEN, label: "Card · bank details" },
  { screen: SHOW_CARD_NUMBER_SCREEN, label: "Card · card number" },
  { screen: V1_WALLET_MIGRATION_SCREEN, label: "v1 wallet migration" },
  { screen: FACTORY_RESET_SCREEN, label: "Factory reset (opens the delete flow)" },
] as const;

export type InternalLinkScreen = (typeof INTERNAL_LINK_DESTINATIONS)[number]["screen"];

/**
 * Screens the router accepts but that are not their own destination — `keys` is
 * a second name for the wallet tab. Listing them separately keeps the debug
 * picker free of duplicates while still accepting a link that works everywhere
 * else in the app.
 */
const INTERNAL_LINK_ALIASES = ["keys"] as const;

const ROUTABLE_SCREENS: readonly string[] = [
  ...INTERNAL_LINK_DESTINATIONS.map((entry) => entry.screen),
  ...INTERNAL_LINK_ALIASES,
];

export function internalLinkFor(screen: InternalLinkScreen): string {
  return `nuri://${screen}`;
}

/** The screen a link points at, or null when it is not one we can route. */
export function readInternalLinkScreen(url: unknown): string | null {
  if (typeof url !== "string" || !NURI_INTERNAL_LINK_PATTERN.test(url)) return null;
  const [path] = url.replace(NURI_INTERNAL_LINK_PATTERN, "").split(/[?#]/);
  const screen = path.split("/").filter(Boolean)[0] ?? "";
  return ROUTABLE_SCREENS.includes(screen) ? screen : null;
}

/**
 * The link reduced to scheme plus screen. Notification payloads arrive from the
 * server, and the EventBus logs string payloads — so a link carrying a query
 * (`nuri://card?token=…`) would put whatever it holds into the logs even though
 * the router ignores it. Rebuilding the link from the validated screen means
 * only that screen can ever be emitted.
 */
export function canonicalInternalLink(url: string): string | null {
  const screen = readInternalLinkScreen(url);
  if (!screen) return null;
  const [scheme] = url.split("://");
  return `${scheme}://${screen}`;
}
