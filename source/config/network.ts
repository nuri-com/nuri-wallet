/**
 * SINGLE source of truth for every testnet-vs-mainnet choice.
 *
 * Selected at build time via the `APP_NETWORK` env var → `app.config.ts`
 * `extra.appNetwork`. Mainnet is the default when unset. Nothing else in the
 * app may hardcode a chain id, RPC URL, token address, or server per network —
 * read it from here so a testnet/mainnet mix is impossible.
 */
export type AppNetwork = "testnet" | "mainnet";

function readExtraAppNetwork(): string | undefined {
  try {
    // Lazy require: node/test environments have no expo-constants (its module
    // references RN's __DEV__ and throws on import). Default to mainnet there.
    const Constants = require("expo-constants").default;
    return Constants?.expoConfig?.extra?.appNetwork;
  } catch {
    return undefined;
  }
}

export const APP_NETWORK: AppNetwork = readExtraAppNetwork() === "testnet" ? "testnet" : "mainnet";

export const IS_MAINNET = APP_NETWORK === "mainnet";

const pick = (mainnet: string | undefined, testnet: string | undefined, fallback: string): string =>
  ((IS_MAINNET ? mainnet : testnet) || "").trim() || fallback;

// ── Base chain ────────────────────────────────────────────────────────
export const BASE_CHAIN_ID = IS_MAINNET ? 8453 : 84532;

// ── Base EURC (the settlement token differs per network) ──────────────
// Mainnet: Circle's canonical EURC. Testnet: the Wirex settlement EURC on Base
// Sepolia (a DIFFERENT token, 6 dec) — the token the Wirex account tracks.
export const BASE_EURC = IS_MAINNET
  ? {
      address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as `0x${string}`,
      decimals: 6,
      chainId: 8453 as const,
    }
  : {
      address: "0xF70461ffb413981852683657A310892227e3989e" as `0x${string}`,
      decimals: 6,
      chainId: 84532 as const,
    };

// ── Base USDC ─────────────────────────────────────────────────────────
// Circle's canonical USDC on Base mainnet. Only the SwapKit BTC↔EURC routes
// touch it: they hop through USDC, so a leg that fails after the hub delivers
// leaves USDC in the EOA. Mainnet-only — SwapKit routes do not exist on testnet
// (see SWAPKIT_ENABLED), so there is no testnet counterpart to define.
export const BASE_USDC = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  decimals: 6,
  chainId: 8453 as const,
};

// ── Base gas faucet eligibility ───────────────────────────────────────
// The dripper only funds an EOA that already holds one of these (Sybil gate);
// anything else is refused `no_eure`. Mirrors the deployed faucet contract's
// onchain `eligibleTokens` array (storage slot 2, length 5), read 2026-08-07 —
// keep in sync with the contract, not with any client-side token list. Mainnet
// literals on purpose: the faucet exists only on Base mainnet, so this list must
// not follow APP_NETWORK.
// Lowercase on purpose: EIP-55 casing carries no meaning for a balanceOf target,
// and membership tests against a wallet's token list must be case-insensitive.
// Each symbol below was confirmed by calling symbol() on Base mainnet.
export const BASE_FAUCET_ELIGIBLE_TOKENS = [
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", // EURC
  "0xb4bb2032a73a53c0aa7dc9ee2d9658a978fa7bc2", // WUSD
  "0x379e120c1921bfd8f5e0a1a3c699e7e800b66606", // WEUR
] as const satisfies readonly `0x${string}`[];

// Circle's canonical (native, not bridged) USDC on Arbitrum One. A swap whose
// route runs through Arbitrum can leave the user's funds sitting here the same
// way a failed Base leg leaves them in BASE_USDC — the sweep allow-list and the
// recovery swap both resolve the contract from this one definition.
export const ARBITRUM_USDC = {
  address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}`,
  decimals: 6,
  chainId: 42161 as const,
};

// Satora's claimed Bitcoin asset, before conversion to USDC. Recovery consent
// must bind this original tBTC input, not the later USDC bridge output.
export const ARBITRUM_TBTC = {
  address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" as `0x${string}`,
  decimals: 18,
  chainId: 42161 as const,
};

// ── Alchemy key ───────────────────────────────────────────────────────
// The paid plan. Every chain the app reads or signs on goes through it (see
// lib/rpc/chainRpc) rather than a public endpoint: unkeyed public nodes rate
// limit, lag, and have no support path, and these calls move user funds.
export const ALCHEMY_API_KEY = (
  process.env.EXPO_PUBLIC_ALCHEMY_API_KEY || "5hzL6G00_2wbx3JHQ_e4P"
).trim();

// ── Base RPC ──────────────────────────────────────────────────────────
// Must be Alchemy: the wallet tx scanner uses alchemy_getAssetTransfers, an
// Alchemy-only extension. Default uses the shared Nuri Alchemy key; override
// per network via env to swap the key.
export const BASE_RPC_URL = pick(
  process.env.EXPO_PUBLIC_BASE_MAINNET_RPC_URL,
  process.env.EXPO_PUBLIC_BASE_SEPOLIA_RPC_URL,
  IS_MAINNET
    ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
    : `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
);

// ── Wirex MCP proxy (per-network server) ──────────────────────────────
export const WIREX_PROXY_BASE_URL = IS_MAINNET
  ? "https://banking.nuri.com"
  : "https://wirex.nuri.com";

// ── Remit corridor (Lightning → Tanzanian shilling mobile money) ──────
// The MCP endpoint the send screen quotes and mints its BOLT11 against. A public
// hostname, pinned here for the same reason as WIREX_PROXY_BASE_URL.
export const REMIT_MCP_URL = "https://remit.nuri.com/mcp";
// Lightning → Kenyan shilling (M-Pesa, through ZapRemit) lives on its own host.
export const REMIT_KES_MCP_URL = "https://remit.paymentrequired.com/mcp";

// ── Notification server ───────────────────────────────────────────────
// Owns the device-token registry and does the actual sending (Expo Push for
// native, VAPID-signed web push for the PWA). A public hostname, not a secret,
// so it is pinned here like WIREX_PROXY_BASE_URL rather than injected — an env
// var would have to be set in every EAS environment, and forgetting one would
// silently disable notifications for that channel. The override exists for
// pointing a dev build at a local server.
export const NOTIFICATIONS_API_BASE_URL = (
  process.env.EXPO_PUBLIC_NOTIFICATIONS_API_URL || "https://notifications.nuri.com"
).trim();

// The PUBLIC half of the Web Push VAPID keypair, used by the PWA to subscribe.
// Public by design — it is handed to the browser's push service on every
// subscribe — so it is pinned here for the same reason as the host above: an env
// var would have to be set in every EAS environment, and one omission would
// leave web push silently off. The PRIVATE half signs pushes and exists only on
// notifications.nuri.com; it must never appear in this repo or the bundle.
// Rotating the pair invalidates every existing subscription — the client
// detects the mismatch and re-subscribes (see NotificationService.web.ts).
export const VAPID_PUBLIC_KEY = (
  process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY ||
  "BLXqYxQFvu7_iCcJ-SXkpSGQ328IJoMWDDLvT5V3cVslC84xAu734mVGemoTXMbSyRKRVLYQuOfkL2lu9Z_w6TA"
).trim();

// AA deployment (ZeroDev bundler/paymaster) is owned by the Wirex proxy
// server-side — the app never talks to a bundler on the prod path. The only
// on-device AA bootstrap is the self-host DEBUG flow, which keeps its own env
// vars in lib/wirex/debugConfig.ts. So no AA endpoints belong here.

// ── Wirex AA contract registry (per-network) ──────────────────────────
// The Wirex "contract registry" resolves the module addresses
// (FundsManagement / Accounts / ExecutionDelayPolicy) via contractByName. It is
// deployed at a DIFFERENT address per network. Read by the prod register-
// calldata verification gate (lib/wirex/registerVerification.ts), which rebuilds
// the register batch locally on the active network before signing. The self-host
// DEBUG bootstrap always runs on Base Sepolia and uses the testnet address.
export const WIREX_CONTRACT_REGISTRY_TESTNET =
  "0xC801a0f38E20500B5840c4927553b3409890bc3c" as `0x${string}`;
// The same registry the backend nuri-wirex-mcp uses on prod (AA_CONTRACT_REGISTRY)
// to build register calldata — verified against a live mainnet registration.
export const WIREX_CONTRACT_REGISTRY_MAINNET =
  "0xAFa697ebC7919998AF5CdE325Fbe990dC926aae4" as `0x${string}`;
export const WIREX_CONTRACT_REGISTRY = IS_MAINNET
  ? WIREX_CONTRACT_REGISTRY_MAINNET
  : WIREX_CONTRACT_REGISTRY_TESTNET;

// Wirex partner id (bytes16) — network-dependent, just like the registry. Wirex assigns a different
// partner id per environment, and the backend nuri-wirex-mcp bakes it into the register calldata
// (createUserAccountWithWallet(partnerId)). Both values verified 2026-07-08 against the servers'
// AA_PARTNER_ID: testnet is the code default (unset on sandbox), mainnet is set on prod. The app's
// register-calldata rebuild MUST use the active-network value or the byte-compare fails.
export const WIREX_PARTNER_ID_TESTNET = "0x00000000000000000000000000000027" as `0x${string}`;
export const WIREX_PARTNER_ID_MAINNET = "0x00000000000000002000000000000027" as `0x${string}`;
export const WIREX_PARTNER_ID = IS_MAINNET ? WIREX_PARTNER_ID_MAINNET : WIREX_PARTNER_ID_TESTNET;

// ── SwapKit availability ──────────────────────────────────────────────
// SwapKit routes (BTC-Lightning ↔ EURC) only exist on mainnet — real Lightning
// has no testnet with value. On testnet the swap flows are disabled.
export const SWAPKIT_ENABLED = IS_MAINNET;

/**
 * Startup guardrail — throws if the resolved network config is internally
 * incoherent (a mix). Call once at app boot.
 */
export function assertNetworkCoherent(): void {
  const problems: string[] = [];
  if (BASE_EURC.chainId !== BASE_CHAIN_ID) {
    problems.push(`BASE_EURC.chainId=${BASE_EURC.chainId} != BASE_CHAIN_ID=${BASE_CHAIN_ID}`);
  }
  if (!BASE_RPC_URL) problems.push("BASE_RPC_URL is empty");
  if (!WIREX_PROXY_BASE_URL) problems.push("WIREX_PROXY_BASE_URL is empty");
  if (problems.length > 0) {
    throw new Error(`[network] incoherent APP_NETWORK=${APP_NETWORK}: ${problems.join("; ")}`);
  }
}

// Fail fast at boot if the resolved network config is incoherent. Runs once
// when this module is first imported (very early — everything depends on it).
assertNetworkCoherent();
