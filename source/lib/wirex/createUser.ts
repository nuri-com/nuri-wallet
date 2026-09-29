import { WIREX_PROXY_BASE_URL as NETWORK_WIREX_PROXY_BASE_URL } from "../../config/network";
import { errMsg } from "../errorMessage";
import {
  WIREX_DEFAULT_CHAIN_ID,
  WIREX_DEFAULT_BANK_ACCOUNT_TYPE,
  WIREX_ONBOARD_TIMEOUT_MS,
  WIREX_PUSH_TIMEOUT_MS,
  WIREX_HEALTH_TIMEOUT_MS,
  WIREX_PROGRESS_TIMEOUT_MS,
} from "../../config/constants";
const WIREX_DEFAULT_DEV_BASIC_AUTH = String(
  process.env.EXPO_PUBLIC_WIREX_DEV_BASIC_AUTH || "",
).trim();
const WIREX_DEFAULT_PROXY_BASE_URL = NETWORK_WIREX_PROXY_BASE_URL;

type WirexBankAccountType = "Sepa" | "Swift" | "FasterPayment" | "Ach" | "Spei";

type WirexDebugOnboardingInput = {
  walletAddress: string;
  email: string;
  country: string;
  chainId?: number;
  bankAccountType?: WirexBankAccountType;
  proxyBaseUrl?: string;
  sharingToken?: string;
  attemptAaBootstrap?: boolean;
};

type WirexDebugPushToCardInput = {
  walletAddress: string;
  amount: number;
  chainId?: number;
  proxyBaseUrl?: string;
  externalCardId?: string;
  currency?: string;
  tokens?: string[];
  tokenAddress?: string;
  execute?: boolean;
};

type WirexDebugPushToCardFlowInput = {
  walletAddress: string;
  amount: number;
  chainId?: number;
  proxyBaseUrl?: string;
  externalCardId?: string;
  currency?: string;
  tokenAddress?: string;
  execute?: boolean;
  cardNumber?: string;
  cardholderName?: string;
  cardLabel?: string;
  isThirdParty?: boolean;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  isBusiness?: boolean;
  currencies?: string[];
};

type WirexDebugCreateCardRecipientInput = {
  walletAddress: string;
  chainId?: number;
  proxyBaseUrl?: string;
  cardNumber: string;
  cardholderName: string;
  cardLabel?: string;
  isThirdParty?: boolean;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  isBusiness?: boolean;
  currencies?: string[];
};

type WirexDebugMintSandboxBalanceInput = {
  walletAddress: string;
  amount: number;
  chainId?: number;
  proxyBaseUrl?: string;
  currency?: string;
  tokenAddress?: string;
};

type WirexDebugOnboardingProgressInput = {
  walletAddress: string;
  proxyBaseUrl?: string;
};

type WirexDebugCardSensitiveDetailsInput = {
  walletAddress: string;
  cardId: string;
  nonce: number;
  messageSignature: string;
  chainId?: number;
  proxyBaseUrl?: string;
};

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error: unknown) {
    const name =
      error && typeof error === "object" && "name" in error
        ? (error as { name?: unknown }).name
        : undefined;
    if (name === "AbortError") {
      throw new Error(`Wirex request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const requireString = (value: unknown, field: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`Missing ${field}`);
  }
  return normalized;
};

const hasDebugSteps = (value: unknown): value is { steps: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { steps?: unknown }).steps);

/**
 * The one way a proxy answer is read: the body, then the failure. A run that
 * came back with its debug steps is returned as-is even on a non-2xx — those
 * steps ARE the answer the debug screen asks for. `allowDebugSteps: false` is
 * for the plain reads, which have no steps to salvage.
 */
const unwrapWirexResponse = async (
  response: Response,
  failureLabel: string,
  allowDebugSteps = true,
): Promise<unknown> => {
  const payload = await parseJson(response);
  if (!response.ok) {
    if (allowDebugSteps && hasDebugSteps(payload)) return payload;
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : response.statusText;
    throw new Error(`${failureLabel} (${response.status}): ${detail}`);
  }
  return payload;
};

export const buildWirexSandboxEmail = (walletAddress: string): string => {
  const normalized = walletAddress.trim().toLowerCase();
  const suffix = normalized.startsWith("0x") ? normalized.slice(2, 8) : normalized.slice(0, 6);
  return `nuri.wirex+${suffix}@nuri.com`;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

export const WIREX_PROXY_BASE_URL = normalizeBaseUrl(WIREX_DEFAULT_PROXY_BASE_URL);
const WIREX_PROXY_API_KEY = String(process.env.EXPO_PUBLIC_WIREX_PROXY_API_KEY || "").trim();
const WIREX_PROXY_BASIC_AUTH_ENV = String(
  process.env.EXPO_PUBLIC_WIREX_PROXY_BASIC_AUTH || "",
).trim();
const WIREX_PROXY_BASIC_AUTH =
  WIREX_PROXY_BASIC_AUTH_ENV ||
  (WIREX_PROXY_BASE_URL.includes("dev.nuri.com") ? WIREX_DEFAULT_DEV_BASIC_AUTH : "");

const buildWirexProxyHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (WIREX_PROXY_API_KEY) {
    headers["x-api-key"] = WIREX_PROXY_API_KEY;
  }
  if (WIREX_PROXY_BASIC_AUTH) {
    const raw = WIREX_PROXY_BASIC_AUTH.startsWith("Basic ")
      ? WIREX_PROXY_BASIC_AUTH.slice(6).trim()
      : typeof globalThis.btoa === "function"
        ? globalThis.btoa(WIREX_PROXY_BASIC_AUTH)
        : WIREX_PROXY_BASIC_AUTH;
    if (raw) {
      headers.Authorization = `Basic ${raw}`;
    }
  }
  return headers;
};

export const runWirexDebugOnboarding = async (
  input: WirexDebugOnboardingInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const email = requireString(input.email, "email");
  const country = requireString(input.country, "country");
  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const bankAccountType = input.bankAccountType || WIREX_DEFAULT_BANK_ACCOUNT_TYPE;

  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());

  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/onboarding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          email,
          country,
          chainId,
          bankAccountType,
          sharingToken: input.sharingToken || undefined,
          attemptAaBootstrap:
            typeof input.attemptAaBootstrap === "boolean" ? input.attemptAaBootstrap : undefined,
        }),
        signal,
      }),
    WIREX_ONBOARD_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex proxy failed");
};

const normalizeTokenList = (input: WirexDebugPushToCardInput): string[] => {
  const direct = Array.isArray(input.tokens) ? input.tokens : [];
  const merged = [...direct];
  if (typeof input.tokenAddress === "string" && input.tokenAddress.trim()) {
    merged.push(input.tokenAddress.trim());
  }
  const uniq = new Set<string>();
  for (const token of merged) {
    const value = String(token || "").trim();
    if (value) {
      uniq.add(value);
    }
  }
  return Array.from(uniq);
};

/** The recipient half of a push-to-card body — the same fields whichever
 *  endpoint takes them. Blank strings are dropped so the proxy sees `undefined`
 *  rather than an empty name. */
const cardRecipientBody = (input: {
  cardLabel?: string;
  isThirdParty?: boolean;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  isBusiness?: boolean;
  currencies?: string[];
}): Record<string, unknown> => ({
  cardLabel: input.cardLabel?.trim() || undefined,
  isThirdParty: input.isThirdParty === true,
  firstName: input.firstName?.trim() || undefined,
  lastName: input.lastName?.trim() || undefined,
  companyName: input.companyName?.trim() || undefined,
  isBusiness: input.isBusiness === true,
  currencies: Array.isArray(input.currencies)
    ? input.currencies
        .map((value) =>
          String(value || "")
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean)
    : undefined,
});

export const runWirexDebugPushToCard = async (
  input: WirexDebugPushToCardInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Missing valid push-to-card amount");
  }

  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const tokens = normalizeTokenList(input);
  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/push-to-card`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          chainId,
          externalCardId: input.externalCardId?.trim() || undefined,
          currency: input.currency?.trim() || undefined,
          amount,
          tokens: tokens.length ? tokens : undefined,
          tokenAddress: input.tokenAddress?.trim() || undefined,
          execute: typeof input.execute === "boolean" ? input.execute : true,
        }),
        signal,
      }),
    WIREX_PUSH_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex push-to-card failed");
};

export const runWirexDebugCreateCardRecipientFromCard = async (
  input: WirexDebugCreateCardRecipientInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const cardNumber = requireString(input.cardNumber, "cardNumber").replace(/[\s-]/g, "");
  const cardholderName = requireString(input.cardholderName, "cardholderName");

  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/push-to-card/recipient-from-card`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          chainId,
          cardNumber,
          cardholderName,
          ...cardRecipientBody(input),
        }),
        signal,
      }),
    WIREX_PUSH_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex card recipient creation failed");
};

export const runWirexDebugMintSandboxBalance = async (
  input: WirexDebugMintSandboxBalanceInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Missing valid sandbox mint amount");
  }

  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/push-to-card/mint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          chainId,
          amount,
          currency: input.currency?.trim() || undefined,
          tokenAddress: input.tokenAddress?.trim() || undefined,
        }),
        signal,
      }),
    WIREX_PUSH_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex sandbox mint failed");
};

export const runWirexDebugPushToCardFlow = async (
  input: WirexDebugPushToCardFlowInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Missing valid push-to-card amount");
  }

  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/push-to-card/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          chainId,
          amount,
          externalCardId: input.externalCardId?.trim() || undefined,
          currency: input.currency?.trim() || undefined,
          tokenAddress: input.tokenAddress?.trim() || undefined,
          execute: typeof input.execute === "boolean" ? input.execute : true,
          cardNumber: input.cardNumber?.trim() || undefined,
          cardholderName: input.cardholderName?.trim() || undefined,
          ...cardRecipientBody(input),
        }),
        signal,
      }),
    WIREX_PUSH_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex push demo failed");
};

export const getWirexDebugOnboardingProgress = async (
  input: WirexDebugOnboardingProgressInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(
        `${proxyBaseUrl}/v1/debug/onboarding/progress?walletAddress=${encodeURIComponent(walletAddress)}`,
        {
          method: "GET",
          headers: {
            ...buildWirexProxyHeaders(),
          },
          signal,
        },
      ),
    WIREX_PROGRESS_TIMEOUT_MS,
  );
  return await unwrapWirexResponse(response, "Wirex onboarding progress failed", false);
};

export const runWirexDebugCardSensitiveDetails = async (
  input: WirexDebugCardSensitiveDetailsInput,
): Promise<unknown> => {
  const walletAddress = requireString(input.walletAddress, "walletAddress");
  const cardId = requireString(input.cardId, "cardId");
  const messageSignature = requireString(input.messageSignature, "messageSignature");
  const nonce = Number(input.nonce);
  if (!Number.isFinite(nonce) || nonce <= 0) {
    throw new Error("Missing valid card-details nonce");
  }

  const chainId = Number.isFinite(input.chainId) ? Number(input.chainId) : WIREX_DEFAULT_CHAIN_ID;
  const proxyBaseUrl = normalizeBaseUrl(String(input.proxyBaseUrl || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    throw new Error("Missing Wirex proxy base URL");
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${proxyBaseUrl}/v1/debug/cards/details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildWirexProxyHeaders(),
        },
        body: JSON.stringify({
          walletAddress,
          cardId,
          nonce,
          chainId,
          messageSignature,
        }),
        signal,
      }),
    WIREX_PUSH_TIMEOUT_MS,
  );

  return await unwrapWirexResponse(response, "Wirex card details failed", false);
};

export const checkWirexProxyHealth = async (
  proxyBaseUrlInput?: string,
): Promise<{ ok: boolean; service?: string; detail?: string }> => {
  const proxyBaseUrl = normalizeBaseUrl(String(proxyBaseUrlInput || WIREX_PROXY_BASE_URL).trim());
  if (!proxyBaseUrl) {
    return { ok: false, detail: "missing_proxy_base_url" };
  }

  try {
    const response = await withTimeout(
      (signal) =>
        fetch(`${proxyBaseUrl}/health`, {
          method: "GET",
          headers: {
            ...buildWirexProxyHeaders(),
          },
          signal,
        }),
      WIREX_HEALTH_TIMEOUT_MS,
    );
    const payload = (await parseJson(response)) as Record<string, unknown> | null;
    if (!response.ok) {
      return { ok: false, detail: `http_${response.status}` };
    }
    return {
      ok: payload?.ok === true,
      service: typeof payload?.service === "string" ? payload.service : undefined,
      detail: payload?.ok === true ? "ok" : "invalid_health_payload",
    };
  } catch (error: unknown) {
    const msg = errMsg(error);
    return {
      ok: false,
      detail: msg,
    };
  }
};
