import { Wallet } from "ethers";
import { expect, it, vi } from "vitest";
import { describeLiveIfEnv } from "../../test/liveEnv";

vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageCode: "en" }],
}));

import {
  buildWirexSandboxEmail,
  checkWirexProxyHealth,
  getWirexDebugOnboardingProgress,
  runWirexDebugMintSandboxBalance,
  runWirexDebugOnboarding,
  runWirexDebugPushToCardFlow,
} from "./createUser";
import {
  BANK_ACCOUNT_TYPE,
  COUNTRY,
  DEFAULT_PUSH_CARD_LABEL,
  DEFAULT_PUSH_CARD_NUMBER,
  DEFAULT_PUSH_CARDHOLDER_NAME,
  DEFAULT_PUSH_TO_CARD_AMOUNT,
  DEFAULT_PUSH_TO_CARD_CURRENCY,
} from "./debugConfig";
import { asNumber, asObject, asString } from "./debugHelpers";
import { isStepHealthy } from "./onboardingAnalysis";

const LIVE_ENV = ["NURI_LIVE_CONTRACTS", "EXPO_PUBLIC_WIREX_PROXY_BASIC_AUTH"] as const;
const WIREX_SANDBOX_PROXY_BASE_URL = "https://wirex.nuri.com";
const WIREX_SANDBOX_CHAIN_ID = 84532;
const WIREX_SANDBOX_MINT_AMOUNT = Number(DEFAULT_PUSH_TO_CARD_AMOUNT);
const WIREX_SANDBOX_E2E_TIMEOUT_MS = 540_000;
const WIREX_CARD_LIMIT_NUMERIC_KEYS = ["daily_limit", "daily_usage", "monthly_limit"] as const;
const AUTH_HEALTH_FAILURES = new Set(["http_401", "http_403"]);

function readObject(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? null : asObject(value);
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(true);
  return value as unknown[];
}

function nonEmptyStringValue(value: unknown): string {
  return asString(value).trim();
}

function finiteNumberValue(value: unknown): number | null {
  const sharedNumber = asNumber(value);
  if (sharedNumber !== null) return sharedNumber;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => readObject(current)?.[key], root);
}

function readFirstRecord(
  root: unknown,
  paths: readonly (readonly string[])[],
): Record<string, unknown> | null {
  for (const path of paths) {
    const record = readObject(readPath(root, path));
    if (record) return record;
  }
  return null;
}

function readFirstArray(root: unknown, paths: readonly (readonly string[])[]): unknown[] | null {
  let firstPresentArray: unknown[] | null = null;
  for (const path of paths) {
    const value = readPath(root, path);
    if (!Array.isArray(value)) continue;
    if (value.length > 0) return value;
    firstPresentArray ??= value;
  }
  return firstPresentArray;
}

function expectObjectShape(value: unknown, label: string): Record<string, unknown> {
  const record = readObject(value);
  expect(record, `${label} must be an object`).not.toBeNull();
  return record as Record<string, unknown>;
}

function expectStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = nonEmptyStringValue(record[key]);
  expect(value.length, `${label}.${key} must be a non-empty string`).toBeGreaterThan(0);
  return value;
}

function expectFiniteField(record: Record<string, unknown>, key: string, label: string): number {
  const value = finiteNumberValue(record[key]);
  expect(value, `${label}.${key} must be finite`).not.toBeNull();
  return value as number;
}

function expectStepListSucceeded(payload: unknown, label: string) {
  const steps = requireArray(readObject(payload)?.steps, `${label}.steps`);
  expect(steps.length, `${label}.steps must be non-empty`).toBeGreaterThan(0);
  for (const rawStep of steps) {
    const step = expectObjectShape(rawStep, `${label}.steps[]`);
    expectStringField(step, "name", `${label}.steps[]`);
    expect(isStepHealthy(step), `${label}.${String(step.name)} must be healthy`).toBe(true);
  }
}

function expectWalletShape(payload: unknown, label: string, requireBalance = false) {
  const wallet = readFirstRecord(payload, [["snapshot", "wallet"], ["wallet"], ["data", "wallet"]]);
  expect(wallet, `${label} must include a wallet shape`).not.toBeNull();
  const walletRecord = wallet as Record<string, unknown>;
  expectStringField(walletRecord, "wallet_address", `${label}.wallet`);
  const balances = requireArray(walletRecord.balances, `${label}.wallet.balances`);
  if (requireBalance) {
    expect(balances.length, `${label}.wallet.balances must be non-empty`).toBeGreaterThan(0);
  }
  for (const [index, rawBalance] of balances.entries()) {
    const balance = expectObjectShape(rawBalance, `${label}.wallet.balances[${index}]`);
    expect(
      nonEmptyStringValue(balance.token_symbol) || nonEmptyStringValue(balance.token_address),
      `${label}.wallet.balances[${index}] must identify a token`,
    ).not.toBe("");
    expectFiniteField(balance, "balance", `${label}.wallet.balances[${index}]`);
  }
}

function expectStatusShape(payload: unknown, label: string) {
  const root = expectObjectShape(payload, label);
  expect(root.ok, `${label}.ok must be true`).toBe(true);
  const summary = expectObjectShape(root.summary, `${label}.summary`);
  expectStringField(root, "userStatus", label);
  expectStringField(summary, "verificationStatus", `${label}.summary`);
  expectFiniteField(summary, "bankAccountsCount", `${label}.summary`);
  expectFiniteField(summary, "cardsCount", `${label}.summary`);
}

function expectCardAndLimitShapes(payload: unknown, label: string) {
  const cards = readFirstArray(payload, [["snapshot", "cards"], ["cards"], ["data", "cards"]]);
  expect(cards, `${label} must include a cards array`).not.toBeNull();
  const cardsArray = cards ?? [];
  expect(cardsArray.length, `${label} must include at least one card`).toBeGreaterThan(0);

  for (const [index, rawCard] of cardsArray.entries()) {
    const card = expectObjectShape(rawCard, `${label}.cards[${index}]`);
    expectStringField(card, "id", `${label}.cards[${index}]`);
    expectStringField(card, "status", `${label}.cards[${index}]`);
    const limit = readObject(card.limit) ?? readObject(card.limits);
    if (limit) {
      for (const key of WIREX_CARD_LIMIT_NUMERIC_KEYS) {
        if (limit[key] !== undefined) {
          expectFiniteField(limit, key, `${label}.cards[${index}].limit`);
        }
      }
      if (limit.currency !== undefined) {
        expectStringField(limit, "currency", `${label}.cards[${index}].limit`);
      }
    }
  }

  const capability = readFirstRecord(payload, [
    ["summary", "cardTransferCapability"],
    ["operations", "push", "summary", "cardTransferCapability"],
  ]);
  expect(capability, `${label} must include cardTransferCapability`).not.toBeNull();
  expectStringField(
    capability as Record<string, unknown>,
    "status",
    `${label}.cardTransferCapability`,
  );
}

function buildUniqueWirexSandboxEmail(walletAddress: string): string {
  const baseEmail = buildWirexSandboxEmail(walletAddress);
  const normalizedAddress = walletAddress.trim().toLowerCase().replace(/^0x/, "");
  const suffix = normalizedAddress.slice(6);
  return suffix ? baseEmail.replace("@", `.${suffix}@`) : baseEmail;
}

function expectCardTransactionsShape(payload: unknown, label: string) {
  const transactions = readFirstArray(payload, [
    ["snapshot", "cardTransactions", "transactions"],
    ["snapshot", "transactions"],
    ["transactions"],
    ["operations", "push", "transactions"],
    ["operations", "push", "snapshot", "cardTransactions", "transactions"],
  ]);
  expect(transactions, `${label}.transactions must be a recognized array`).not.toBeNull();
  const transactionItems = transactions ?? [];
  expect(
    transactionItems.length,
    `${label}.transactions must include the pushed transaction`,
  ).toBeGreaterThan(0);

  const first = expectObjectShape(transactionItems[0], `${label}.transactions[0]`);
  expectStringField(first, "id", `${label}.transactions[0]`);
  expectStringField(first, "created_at", `${label}.transactions[0]`);
  expectStringField(first, "type", `${label}.transactions[0]`);
  const direction = expectStringField(first, "direction", `${label}.transactions[0]`);
  expect(["Inbound", "Outbound", "Internal"]).toContain(direction);
  const status = expectStringField(first, "status", `${label}.transactions[0]`);
  expect(["Pending", "Completed", "Failed"]).toContain(status);

  const amount = readObject(first.source_amount) ?? readObject(first.destination_amount);
  expect(
    amount,
    `${label}.transactions[0] must include source_amount or destination_amount`,
  ).not.toBeNull();
  if (amount) {
    expectFiniteField(amount, "amount", `${label}.transactions[0].amount`);
    expect(
      nonEmptyStringValue(amount.currency) || nonEmptyStringValue(amount.token_symbol),
      `${label}.transactions[0].amount must include currency or token_symbol`,
    ).not.toBe("");
  }
}

describeLiveIfEnv("Wirex sandbox live E2E contracts", LIVE_ENV, () => {
  it(
    "creates a throwaway sandbox account, mints funds, pushes to card, and verifies returned shapes",
    async (ctx: { skip: () => void }) => {
      const health = await checkWirexProxyHealth(WIREX_SANDBOX_PROXY_BASE_URL);
      if (!health.ok) {
        if (AUTH_HEALTH_FAILURES.has(health.detail ?? "")) {
          throw new Error(
            `Wirex sandbox E2E proxy auth precondition failed (${health.detail ?? "unknown"})`,
          );
        }
        console.warn(
          `[live-test] Skipping Wirex sandbox E2E: proxy health precondition failed (${health.detail ?? "unknown"})`,
        );
        ctx.skip();
        return;
      }

      const wallet = Wallet.createRandom();
      const walletAddress = wallet.address;
      const email = buildUniqueWirexSandboxEmail(walletAddress);

      const onboarding = await runWirexDebugOnboarding({
        walletAddress,
        email,
        country: COUNTRY,
        chainId: WIREX_SANDBOX_CHAIN_ID,
        bankAccountType: BANK_ACCOUNT_TYPE,
        proxyBaseUrl: WIREX_SANDBOX_PROXY_BASE_URL,
        attemptAaBootstrap: false,
      });
      expectStatusShape(onboarding, "onboarding");
      expectWalletShape(onboarding, "onboarding");
      expectStepListSucceeded(onboarding, "onboarding");

      const progress = await getWirexDebugOnboardingProgress({
        walletAddress,
        proxyBaseUrl: WIREX_SANDBOX_PROXY_BASE_URL,
      });
      expectObjectShape(progress, "progress");

      const mint = await runWirexDebugMintSandboxBalance({
        walletAddress,
        chainId: WIREX_SANDBOX_CHAIN_ID,
        proxyBaseUrl: WIREX_SANDBOX_PROXY_BASE_URL,
        amount: WIREX_SANDBOX_MINT_AMOUNT,
        currency: DEFAULT_PUSH_TO_CARD_CURRENCY,
      });
      const mintRecord = expectObjectShape(mint, "mint");
      expect(mintRecord.ok, "mint.ok must be true").toBe(true);
      expectWalletShape(mint, "mint", true);
      expectStringField(mintRecord, "selectedTokenAddress", "mint");

      const pushFlow = await runWirexDebugPushToCardFlow({
        walletAddress,
        chainId: WIREX_SANDBOX_CHAIN_ID,
        proxyBaseUrl: WIREX_SANDBOX_PROXY_BASE_URL,
        amount: WIREX_SANDBOX_MINT_AMOUNT,
        currency: DEFAULT_PUSH_TO_CARD_CURRENCY,
        execute: true,
        cardNumber: DEFAULT_PUSH_CARD_NUMBER,
        cardholderName: DEFAULT_PUSH_CARDHOLDER_NAME,
        cardLabel: DEFAULT_PUSH_CARD_LABEL,
      });
      const pushRecord = expectObjectShape(pushFlow, "pushFlow");
      expect(pushRecord.ok, "pushFlow.ok must be true").toBe(true);
      expectStringField(pushRecord, "externalCardId", "pushFlow");
      expectStringField(pushRecord, "selectedTokenAddress", "pushFlow");
      expectWalletShape(pushFlow, "pushFlow");
      expectCardAndLimitShapes(pushFlow, "pushFlow");
      expectCardTransactionsShape(pushFlow, "pushFlow");

      const summary = expectObjectShape(pushRecord.summary, "pushFlow.summary");
      expect(summary.executeRequested, "pushFlow.summary.executeRequested").toBe(true);
      expect(summary.recipientReady, "pushFlow.summary.recipientReady").toBe(true);
      expect(summary.fundsMinted, "pushFlow.summary.fundsMinted").toBe(true);
      expectStringField(summary, "estimationId", "pushFlow.summary");
      expectStringField(summary, "transferId", "pushFlow.summary");
    },
    WIREX_SANDBOX_E2E_TIMEOUT_MS,
  );
});
