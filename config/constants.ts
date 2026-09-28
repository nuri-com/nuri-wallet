import { BASE_CHAIN_ID } from "./network";

// ── Naming ──────────────────────────────────────────────────────────
// Every registered LNURL username also resolves as <username>.<parent> via the
// arkade CCIP-Read gateway. The server owns the parent domain; the status
// response does not carry it, so the app composes the name itself.
// ponytail: a plain constant, not a server round-trip. The server resolves a
// list of parents (old ones keep working), so this only names the one we show.
export const ENS_PARENT_DOMAIN = "nuri.eth";

// ── Polling intervals ────────────────────────────────────────────────
export const CARD_BALANCE_POLL_INTERVAL_MS = 10_000;
export const WALLET_POLL_INTERVAL_MS = 8_000;
export const WALLET_PENDING_CHECK_INTERVAL_MS = 12_000;
export const IBAN_PROVISION_ATTEMPT_COOLDOWN_MS = 8_000;
export const BITCOIN_BALANCE_POLL_INTERVAL_MS = 15_000;
export const BITCOIN_PENDING_TX_CHECK_COOLDOWN_MS = 30_000;
export const PENDING_POLL_MS = 30_000;

// ── Timeouts & delays ───────────────────────────────────────────────
export const CARD_POLL_STEP_TIMEOUT_MS = 12_000;

// ── Limits & thresholds ─────────────────────────────────────────────
// UI range for the Wirex daily card limit. The Wirex API documents no maximum
// (-1 = unlimited) and validates server-side; 30k is the assumed platform
// daily cap. The old 8000 came from the retired Gnosis card limits.
export const LIMIT_MAX = 30_000;
// Physical-card ordering is built but Wirex hasn't fully enabled it for us
// (fee payload unparseable, orders rejected server-side) — hide the entry
// point until they do. Set to true to show the "Get Physical Card" CTA.

export const STABLECOIN_MIN_SEND_AMOUNT = 0.01;
// Server `utxoMinAmount` (3000) + `intentFee.onchainOutput` (200). The offboard
// fee is deducted FROM the amount, so a 3000-sat send lands at 2800 and the
// server rejects the output. Was 10_000, sized for the Boltz chain swap and its
// claim fees; that rail is gone. Only an early UI guard — ArkadeSendService
// reads the live minimum and refuses with the exact numbers — so if the server
// raises either value this goes stale in the harmless direction only.
export const ARKADE_BITCOIN_ONCHAIN_MIN_SEND_SATS = 3_200;
// Product floor for SwapKit swaps (Emin); the server does not enforce it yet.
export const BITCOIN_LNURL_MIN_SEND_SATS = 500;
// What the Arkade Intents Lightning corridor serves today. The solver refuses
// out-of-range itself; these exist so the user is told at the keypad instead of
// mid-flow, and they are expected to move as the corridor ramps up.
export const ARKADE_LIGHTNING_MIN_SEND_SATS = 500;
export const ARKADE_LIGHTNING_MAX_SEND_SATS = 50_000;
// The Lightning-legged swap into a Base stable has its own floor: the provider
// states a fiat-denominated minimum, so the live number rides on the quote
// (`limits.minSats`) and this is only the fallback for a quote that omits it.
// The ceiling is the corridor's, above — the provider's own max never binds.
export const ARKADE_INTENTS_STABLE_MIN_SATS_FALLBACK = 8_000;
// What a buy-bitcoin amount input opens on, in whole euros. Shared by every
// buy entry point so they all start on the same number.
export const BUY_DEFAULT_EUR = 21;
export const SWAPKIT_DEFAULT_EUR = String(BUY_DEFAULT_EUR);
export const EPS_PREVIEW_LIMIT = 12000;
export const DEFAULT_CRYPTO = "BTC";
export const DEFAULT_NETWORK = "bitcoin";
export const CSV_BLOCKS = 52500;
// The Arkade co-signer states its on-chain CSV policy in seconds, and the live
// `nuri_server_csv` from the server is the only authority. This is used ONLY
// when that value is unavailable — the timelock is part of the script, so a
// wrong value derives a wrong address.
export const ARKADE_ONCHAIN_CSV_TIMELOCK = { type: "seconds", value: 6674432 } as const;
export const BITCOIN_NETWORK = "mainnet";
export const MERCURYO_BUILD_MARKER = "mtid-client-enabled-2026-02-27-r1";
// Mercuryo's own floor for a purchase.
export const MERCURYO_MIN_EUR = 20;
export const CHROME_PACKAGE = "com.android.chrome";

// ── URLs ────────────────────────────────────────────────────────────
export const IOS_APP_STORE_URL = "https://apps.apple.com/de/app/nuri-com/id6754772131";

// ── Cache config ────────────────────────────────────────────────────
export const TX_PREFETCH_LIMIT = 100;
export const BTC_PREFETCH_TTL_MS = 60_000;
export const BTC_AUTO_HEAD_REFRESH_TTL_MS = 30_000;

// ── WebAuthn / PRF ──────────────────────────────────────────────────
export const PRF_SALT = "nuri-prf-salt-v1";
export const WEBAUTHN_RP_ID = "nuri.com";

// ── Arkade debug ────────────────────────────────────────────────────
export const ARKADE_MODAL_MAX_LOGS = 180;
export const ARKADE_MODAL_MAX_PINNED_LOGS = 80;
export const ARKADE_MODAL_ACTION_TIMEOUT_MS = 35_000;
export const ARKADE_MODAL_PAYMENT_TIMEOUT_MS = 600_000;
export const ARKADE_MODAL_SWEEP_TIMEOUT_MS = 180_000;

// ── Arkade services ──────────────────────────────────────────────────
export const AUTH_CACHE_TTL_MS = 240_000;
export const SPEND_APPROVAL_POLL_MS = 1_000;
export const SPEND_APPROVAL_TIMEOUT_MS = 600_000;
export const ARKADE_HTTP_TIMEOUT_MS = 20_000;
export const ARKADE_SWAP_MANAGER_POLL_MS = 30_000;
export const ARKADE_LNURL_AUTO_PUBLISH_DEFAULT_SATS = 402;
export const ARKADE_BOARDING_MONITOR_INTERVAL_MS = 20_000;

// ── Nostr services ───────────────────────────────────────────────────
export const NOSTR_RELAY_TIMEOUT_MS = 9_000;
export const NOSTR_ALERT_DEDUPE_TTL_MS = 600_000;
export const NOSTR_IDENTITY_CACHE_TTL_MS = 30_000;
export const NOSTR_SYNC_INTERVAL_MS = 30_000;
export const NOSTR_LAST_SYNC_SKEW_SEC = 120;
export const NOSTR_SOCKET_TIMEOUT_MS = 6_000;
export const SUPPORT_NOSTR_PUBKEY =
  "npub1r7y83c4w57jc8skud7e4m6x9qt9g7s6zel6mnvj64lh00lc7tynsdx89vj";
export const NOSTR_SYNC_WINDOW_SEC = 7 * 24 * 60 * 60; // 7 days
export const NOSTR_MAX_SEEN_IDS = 500;

// ── SwapKit ──────────────────────────────────────────────────────────
export const SWAPKIT_QUOTE_DEADLINE_BUFFER_MS = 30_000;

// ── Logging ──────────────────────────────────────────────────────────
export const LOG_MAX_MSG_CHARS = 140;
export const LOG_MAX_SOURCE_CHARS = 72;
export const LOG_REPEAT_SUPPRESS_WINDOW_MS = 1_300;
// Poll-class lines (incl. the arkade sign trace) are driven by multiple steady
// polls — 15s, 20s, and 30s-class — so the window must clear the slowest one.
export const LOG_POLL_REPEAT_SUPPRESS_WINDOW_MS = 35_000;
export const NETWORK_STATS_LOG_INTERVAL_MS = 60_000;
export const NETWORK_STATS_TOP_N = 3;
export const NETWORK_LOG_SUPPRESS_WINDOW_MS = 220;
export const NETWORK_LOG_SUPPRESS_MAX = 1_500;

// ── Support ──────────────────────────────────────────────────────────
export const SUPPORT_MAX_LOG_ENTRIES = 160;
export const SUPPORT_MAX_LOG_ENTRY_CHARS = 320;
export const SUPPORT_MAX_LOG_ENTRY_CHARS_WARN = 900;
export const SUPPORT_MAX_LOG_ENTRY_CHARS_ERROR = 1_400;
export const MAX_SUPPORT_DUMP_TEXT_CHARS = 3_400;
export const SUPPORT_RELAY_TIMEOUT_MS = 7_000;
export const SUPPORT_DUMP_PREFIX = "NURI_SUPPORT_DUMP_V2";

// ── Faucet ───────────────────────────────────────────────────────────
export const FAUCET_RELAY_TIMEOUT_MS = 8_000;
// Transient relay failures (timeout, network drop, 429/5xx) are retried; a
// deliberate server refusal is not. The total budget bounds how long a send
// can sit on the drip before falling through.
export const FAUCET_RELAY_MAX_ATTEMPTS = 3;
export const FAUCET_RELAY_RETRY_DELAY_MS = 700;
export const FAUCET_RELAY_RETRY_BUDGET_MS = 18_000;
// After a drip is mined the balance can still read stale; poll before deciding
// the wallet is unfunded.
export const FAUCET_BALANCE_CONFIRM_TIMEOUT_MS = 12_000;
export const FAUCET_BALANCE_POLL_INTERVAL_MS = 2_000;

// ── App services ─────────────────────────────────────────────────────
export const NETWORK_FAILURE_WINDOW_MS = 20_000;
export const NETWORK_FAILURE_STREAK_THRESHOLD = 2;
export const APP_UPDATE_TIMEOUT_MS = 2_500;

// ── Pricing ──────────────────────────────────────────────────────────
export const CHAINLINK_DECIMALS = 8;
export const FX_RATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Chainlink AggregatorV2V3 price-feed proxies on Base mainnet (chain 8453).
// FX is network-independent reference data, so these are always read from Base
// mainnet even when the app runs on Base Sepolia.
export const CHAINLINK_EUR_USD_FEED = "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F";
export const CHAINLINK_GBP_USD_FEED = "0xCceA6576904C118037695eB71195a5425E69Fa15";

// ── RPC ──────────────────────────────────────────────────────────────
export const RPC_REQUEST_TIMEOUT_MS = 5_000;

// ── Wirex ────────────────────────────────────────────────────────────
// Follows APP_NETWORK (mainnet 8453 / testnet 84532). Single source: config/network.
export const WIREX_DEFAULT_CHAIN_ID = BASE_CHAIN_ID;
export const WIREX_DEFAULT_BANK_ACCOUNT_TYPE = "Ach";
export const WIREX_ONBOARD_TIMEOUT_MS = 300_000;
export const WIREX_PUSH_TIMEOUT_MS = 90_000;
export const WIREX_HEALTH_TIMEOUT_MS = 8_000;
export const WIREX_PROGRESS_TIMEOUT_MS = 8_000;

// ── Notifications ────────────────────────────────────────────────────
// Android delivers silently without an explicit high-importance channel.
export const ANDROID_NOTIFICATION_CHANNEL_ID = "nuri-default";
// Served from public/ by the web export; the path is also the SW's scope.
export const NOTIFICATION_SERVICE_WORKER_PATH = "/nuri-service-worker.js";
// Envelope tag the SW stamps on messages so app listeners can ignore foreign
// postMessage traffic. Mirrored in public/nuri-service-worker.js.
export const NOTIFICATION_WEB_MESSAGE_TAG = "nuri:notification";

/**
 * Liveness ping between the PWA and its service worker. A worker that is
 * registered but no longer answering still satisfies
 * `navigator.serviceWorker.ready`, so the page pings before trusting a
 * registration it did not create in this session. Must match
 * public/nuri-service-worker.js.
 */
export const NOTIFICATION_WEB_SW_PING = "nuri:sw-ping";
export const NOTIFICATION_WEB_SW_PONG = "nuri:sw-pong";
/** arkade.money uses 500 ms: a live worker answers in single-digit ms. */
export const NOTIFICATION_WEB_SW_PING_TIMEOUT_MS = 500;
/** How long a freshly registered worker may take to install and activate. */
export const NOTIFICATION_WEB_SW_ACTIVATION_TIMEOUT_MS = 10_000;
// A tap with no window open cannot be delivered by postMessage — the new client
// is not listening yet. The SW puts the destination in the launch URL under
// these params instead. Mirrored in public/nuri-service-worker.js.
export const NOTIFICATION_WEB_TARGET_QUERY_PARAM = "nuriNotificationTarget";
export const NOTIFICATION_WEB_LINK_QUERY_PARAM = "nuriNotificationLink";
// Expo's push service. Credential-free, which is why only debug tooling sends
// from the client — production sending belongs in a backend.
export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_MAX_PER_REQUEST = 100;
export const NOTIFICATION_TEST_DELAY_OPTIONS_SECONDS = [10, 60, 300, 900];

// ── Experimental ─────────────────────────────────────────────────────
export const SIGN_APPROVAL_POLL_MS = 1_800;
