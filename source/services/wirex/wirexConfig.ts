// services/wirex/wirexConfig.ts
// Config module for the Wirex Phase-1 integration (nuri-wirex-mcp service).

import { BASE_CHAIN_ID, WIREX_PROXY_BASE_URL } from "../../config/network";

// ── Chain ─────────────────────────────────────────────────────────────
// Base chain, selected by APP_NETWORK (mainnet 8453 / testnet 84532). The
// backend owns all account-abstraction (bundler/paymaster/RPC); this app never
// talks to a bundler. Single source of truth: config/network.
export const WIREX_CHAIN_ID = BASE_CHAIN_ID;

// ── Bridge envelope ───────────────────────────────────────────────────
// Consumed by the bridge crypto in a sibling file to encrypt signed approvals.
export const WIREX_BRIDGE_VERSION = "nuri-wirex-bridge-v1";
export const WIREX_BRIDGE_ENVELOPE_ALG = "P-256-ECDH+A256GCM";
export const WIREX_BRIDGE_RESPONSE_INFO = "nuri-wirex-bridge-response";

// ── Origins ───────────────────────────────────────────────────────────
// The nuri-wirex-mcp server is mounted under `/mcp` on the Wirex host.
// REST v1 lives at `/mcp/v1`; the bridge callback API lives at `/mcp/api`
// (a sibling of `/mcp/v1`, NOT nested under `/v1`).
const WIREX_MCP_ORIGIN = `${WIREX_PROXY_BASE_URL}/mcp`;
const WIREX_REST_BASE_URL = `${WIREX_MCP_ORIGIN}/v1`;

// ── REST route paths (relative to the `/mcp/v1` base) ─────────────────
export const WIREX_ROUTES = {
  onboardStart: "/onboard/start",
  onboardResult: "/onboard/result",
  registerResult: "/register/result",
  status: "/status",
  wallet: "/wallet",
  cardDetailsStart: "/card/details/start",
  cardDetailsResult: "/card/details/result",
  // PIN reveal (bridge-signed, same start→sign→poll pattern as card details)
  // Issue an ADDITIONAL virtual card for an existing account. Read-session
  // gated only — no bridge/passkey approval (MCP tool: wirex_card_issue_virtual).
  cardIssueVirtual: "/card/virtual",
  // Card management (light Wirex-direct reads; mutations need a signed action message)
  cardStatus: "/card/status",
  cardLimits: "/card/limits",
  cardFreeze: "/card/freeze",
  cardUnfreeze: "/card/unfreeze",
  cardSetLimit: "/card/set-limit",
  // Permanent close. Irreversible and not reissuable — Wirex has no reopen and no
  // reissue route; a replacement is close + cardIssueVirtual with a new PAN.
  cardClose: "/card/close",
  cardTransactions: "/card/transactions",
  // Bank rails (Sepa/AchPush/AchPull/FasterPayment/Swift) — same activity-feed
  // shape as /card/transactions, filtered to bank transactions.
  bankTransactions: "/bank/transactions",
  withdrawStart: "/withdraw/start",
  withdrawResult: "/withdraw/result",
  // Swap between the card's euro and dollar balances (MCP 0.46.0 / 0.68.0).
  fxStart: "/fx/start",
  fxResult: "/fx/result",
  // The account's user record: the KYC'd profile (the only source of the holder
  // name) and the per-rail capabilities. Wirex serves it from what it calls the
  // physical-eligibility route; nothing about plastic is read from it.
  physicalEligibility: "/card/physical/eligibility",
  // In-app 3DS challenge (pending is a read-session-gated read; respond is a signed mutation)
  threeDsPending: "/3ds/pending",
  threeDsRespond: "/3ds/respond",
  // Binds this install's push subscription to the `wirex` namespace. Read-session
  // gated; the wallet is derived from the session signature, never sent.
  notificationsBind: "/notifications/bind",
  ibanLookup: "/iban/lookup",
  sepaEstimate: "/sepa/estimate",
  sepaTransfer: "/sepa/transfer",
  // Push to card: saved payout cards (read-session gated list + add), a quote
  // (read-session gated), then the owner-signed transfer of that quote.
  payoutCards: "/card/payout-cards",
  cardTransferEstimate: "/card/transfer/estimate",
  cardTransfer: "/card/transfer",
} as const;

// ── Bridge callback ───────────────────────────────────────────────────
// The server accepts signed approvals at
// `POST {origin}/mcp/api/browser-sessions/{sessionId}/callback`.
export const bridgeCallbackUrl = (sessionId: string): string =>
  `${WIREX_MCP_ORIGIN}/api/browser-sessions/${encodeURIComponent(sessionId)}/callback`;

// ── Frozen config object ──────────────────────────────────────────────
export const wirexConfig = Object.freeze({
  chainId: WIREX_CHAIN_ID,
  restBaseUrl: WIREX_REST_BASE_URL,
  mcpOrigin: WIREX_MCP_ORIGIN,
  routes: WIREX_ROUTES,
  bridge: Object.freeze({
    version: WIREX_BRIDGE_VERSION,
    envelopeAlg: WIREX_BRIDGE_ENVELOPE_ALG,
    responseInfo: WIREX_BRIDGE_RESPONSE_INFO,
  }),
} as const);
