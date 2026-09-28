import { IS_MAINNET } from "./network";

// ── Mercuryo ────────────────────────────────────────────────────────
export const MERCURYO_STATUS_ENDPOINT = "https://buybitcoin.nuri.com/mercuryo/transactions";
export const MERCURYO_BUY_URL = "https://buybitcoin.nuri.com/buy";

// ── SwapKit ─────────────────────────────────────────────────────────
export const SWAPKIT_MCP_URL = "https://swapkit.nuri.com/mcp";
// SwapKit v2 (#268 rebuild): quote/commit + generic evidence submit. New orders
// go here; the v1 URL above remains ONLY for legacy-order tracking/recovery.
export const SWAPKIT_V2_MCP_URL = "https://swapkit.nuri.com/v2/mcp";

// ── Bitcoin / Mempool ────────────────────────────────────────────────
export const MEMPOOL_BASE_URL = "https://mempool.space";
export const MEMPOOL_API_BASE_URL = `${MEMPOOL_BASE_URL}/api`;
export const MEMPOOL_PRICES_URL = `${MEMPOOL_API_BASE_URL}/v1/prices`;
// A second Esplora when mempool.space cannot be reached at all. Same API, so a
// request only has to change host — some networks route mempool.space nowhere,
// and a wallet that cannot read a balance because of one host is a wallet that
// tells the user their coins are gone. Mempool-only paths (`/v1/...`) are not
// served here and are never failed over.
export const ESPLORA_FALLBACK_API_BASE_URL = "https://blockstream.info/api";
export const mempoolTxUrl = (txid: string) => `${MEMPOOL_BASE_URL}/tx/${encodeURIComponent(txid)}`;

// ── Base Chain Explorer ──────────────────────────────────────────────
// The wallet's onchain transactions live on Base, so explorer links must
// point at basescan (mainnet) / sepolia.basescan (testnet).
export const BASESCAN_BASE_URL = IS_MAINNET
  ? "https://basescan.org"
  : "https://sepolia.basescan.org";
export const basescanTxUrl = (hash: string) =>
  `${BASESCAN_BASE_URL}/tx/${encodeURIComponent(hash)}`;
export const basescanAddressUrl = (address: string) =>
  `${BASESCAN_BASE_URL}/address/${encodeURIComponent(address)}`;
export const basescanTokenUrl = (token: string, account: string) =>
  `${BASESCAN_BASE_URL}/token/${encodeURIComponent(token)}?a=${encodeURIComponent(account)}`;

// ── App Update ────────────────────────────────────────────────────────
export const UPDATE_BASE_URL = "https://update.nuri.com";

// Base RPC/chain selection lives in config/network.ts (APP_NETWORK switch).

// ── FX Rates ──────────────────────────────────────────────────────────
// api.frankfurter.app is retired: it 301s to this /v1 path, and on web the
// browser follows that redirect off-origin (breaking the same-origin proxy), so
// call the current host directly. It serves open CORS, hence no /api/* proxy.
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?from=USD&to=EUR,GBP";

// ── Support contact ──────────────────────────────────────────────────
export const TELEGRAM_URL = "https://t.me/nuridotcom";
export const SIGNAL_URL =
  "https://signal.group/#CjQKICN6EHeIM5npt5GQNRPMR37TlK8eQQjLJjzgaaEmnajFEhDNfEVmvzI7F8mXxemdd37r";
export const CALL_URL = "https://cal.com/em/talk-to-the-founder";

// ── Nostr relays ──────────────────────────────────────────────────────
export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://relay.nostr.net",
];

// Wirex proxy base URL (per-network) lives in config/network.ts.
