import { BASE_CHAIN_ID, WIREX_PROXY_BASE_URL } from "../../config/network";

export const COUNTRY = "DE";
export const CHAIN_ID = BASE_CHAIN_ID;
export const BANK_ACCOUNT_TYPE = "Ach";
export const HARDCODED_WIREX_PROXY_URL = WIREX_PROXY_BASE_URL;
export const DEFAULT_BASE_SEPOLIA_PUBLIC_RPC_URL = String(
  process.env.EXPO_PUBLIC_BASE_SEPOLIA_PUBLIC_RPC_URL ||
    process.env.EXPO_PUBLIC_BASE_SEPOLIA_RPC_URL ||
    "",
).trim();
export const DEFAULT_SELFHOST_BUNDLER_RPC_URL = String(
  process.env.EXPO_PUBLIC_WIREX_SELFHOST_BUNDLER_RPC_URL ||
    process.env.EXPO_PUBLIC_WIREX_AA_SELFHOST_BUNDLER_RPC_URL ||
    "",
).trim();
export const DEFAULT_SELFHOST_PAYMASTER_ADDRESS = String(
  process.env.EXPO_PUBLIC_WIREX_SELFHOST_PAYMASTER_ADDRESS ||
    process.env.EXPO_PUBLIC_WIREX_AA_SELFHOST_PAYMASTER_ADDRESS ||
    "",
).trim();
export const DEFAULT_WIREX_SUMSUB_CLIENT_ID = String(
  process.env.EXPO_PUBLIC_WIREX_SUMSUB_CLIENT_ID || "",
).trim();
export const WIREX_SUMSUB_CLIENT_ID_FALLBACKS = ["noah.com_112876", "brla.digital_101963"];
export const DEFAULT_PUSH_TO_CARD_AMOUNT = "5";
export const DEFAULT_PUSH_TO_CARD_CURRENCY = "EUR";
export const DEFAULT_PUSH_CARD_NUMBER = "4242424242424242";
export const DEFAULT_PUSH_CARDHOLDER_NAME = "Nuri Sandbox Recipient";
export const DEFAULT_PUSH_CARD_LABEL = "Nuri Test Recipient";
export const MAX_VISIBLE_JSON_CHARS = 12000;
export const WALLET_PASSKEY_PRF_SALT = "nuri-prf-salt-v1";

export const STAGE_DONE = "done";
export const STAGE_ACTION = "action_required";
export const STAGE_PENDING = "pending";
export const STAGE_FAILED = "failed";
export const LIVE_PROGRESS_POLL_MS = 1200;
export const AA_BOOTSTRAP_RETRY_DELAY_MS = 1500;
export const AA_ONBOARDING_SYNC_RETRY_MAX = 8;
export const AA_BOOTSTRAP_RETRY_MAX = 2;
export const AA_CREATE_BOOTSTRAP_PASSES_MAX = 2;
export const PASSKEY_CAPTURE_DEFAULT_HINT =
  "Tap a WebAuthn button below to trigger the passkey/hardware-key prompt.";

export type StageState =
  | typeof STAGE_DONE
  | typeof STAGE_ACTION
  | typeof STAGE_PENDING
  | typeof STAGE_FAILED;
