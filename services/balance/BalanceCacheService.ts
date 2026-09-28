import { deleteAuthData, getAuthData, storeAuthData } from "../../lib/secureKeyStorage";
import { group, logger } from "../../lib/log";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";
import type { FiatCode } from "../../lib/tokens";

// Routine cache writes are trace-tier (they fire every poll); the balance store
// emits the EVENT line only when the amount actually changes.
const cacheLog = logger("services/balance/BalanceCacheService.ts");

export const BALANCE_CACHE_KEYS = {
  wallet: "@cache:walletBalance",
  card: "@cache:cardBalance",
  bitcoin: "@cache:bitcoinBalance",
  // The ON-CHAIN half of that figure. `bitcoin` is the total and cannot say how
  // it splits, so a restored balance used to land entirely on the arkade rail
  // and the on-chain row opened at zero until the network answered.
  bitcoinOnchain: "@cache:bitcoinOnchainBalance",
  bitcoinFiatRate: "@cache:bitcoinFiatRate",
  walletMulti: "@cache:walletBalanceMulti",
  dollar: "@cache:dollarBalance",
} as const;

export type CachedBalance = {
  amount: number;
  currency?: string | null;
  updatedAt?: string | null;
  address?: string | null;
};

export type CachedMultiBalance = {
  balances: Record<FiatCode, number>;
  updatedAt: string | null;
  address: string | null;
};

export async function getCachedBalance(key: string): Promise<CachedBalance | null> {
  try {
    const raw = await getAuthData(key);
    if (!raw) {
      if (key === BALANCE_CACHE_KEYS.bitcoin) {
        logWithId(
          `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
          "read miss",
          { key, reason: "empty" },
          { context: "background", event: "CACHE_MISS", action: "cache" },
        );
      }
      return null;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed.amount !== "number" || Number.isNaN(parsed.amount)) {
      if (key === BALANCE_CACHE_KEYS.bitcoin) {
        logWithId(
          `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
          "read miss",
          { key, reason: "invalid_amount", rawLen: raw.length },
          { context: "background", event: "CACHE_MISS", action: "cache" },
        );
      }
      return null;
    }
    const out = {
      amount: parsed.amount,
      currency: parsed.currency ?? null,
      updatedAt: parsed.updatedAt ?? null,
      address: parsed.address ?? null,
    };
    if (key === BALANCE_CACHE_KEYS.bitcoin) {
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
        "read hit",
        {
          amount: out.amount,
          currency: out.currency,
          address: out.address || "none",
          updatedAt: out.updatedAt || "none",
        },
        { context: "background", event: "CACHE_HIT", action: "cache" },
      );
    }
    return out;
  } catch {
    if (key === BALANCE_CACHE_KEYS.bitcoin) {
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
        "read miss",
        { key, reason: "parse_or_storage_error" },
        { context: "background", event: "CACHE_MISS", action: "cache" },
      );
    }
    return null;
  }
}

export async function setCachedBalance(
  key: string,
  amount: number | null,
  currency?: string | null,
  address?: string | null,
): Promise<void> {
  try {
    if (amount === null) {
      await deleteAuthData(key);
      if (key === BALANCE_CACHE_KEYS.bitcoin) {
        logWithId(
          `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
          "write delete",
          { key },
          { context: "background", event: "STATE", action: "cache" },
        );
      }
      return;
    }

    const payload = {
      amount,
      currency: currency?.toUpperCase?.() ?? null,
      updatedAt: new Date().toISOString(),
      address: address ?? null,
    };

    await storeAuthData(key, JSON.stringify(payload));
    if (key === BALANCE_CACHE_KEYS.bitcoin) {
      cacheLog.trace(
        `cache write ${group(payload.amount)} ${payload.currency ?? ""} addr=${payload.address || "none"}`,
      );
    }
  } catch {
    if (key === BALANCE_CACHE_KEYS.bitcoin) {
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.cache`,
        "write failed",
        { key, amount: amount ?? "delete", address: address || "none" },
        { context: "background", event: "VALIDATION", action: "cache" },
      );
    }
    // Best-effort cache write; ignore failures
  }
}

export async function clearCachedBalance(key: string): Promise<void> {
  try {
    await deleteAuthData(key);
  } catch {
    // Best-effort
  }
}

export async function getCachedMultiBalance(key: string): Promise<CachedMultiBalance | null> {
  try {
    const raw = await getAuthData(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.balances !== "object" ||
      parsed.balances === null ||
      Array.isArray(parsed.balances)
    ) {
      return null;
    }
    for (const val of Object.values(parsed.balances)) {
      if (typeof val !== "number" || Number.isNaN(val)) {
        return null;
      }
    }
    return {
      balances: parsed.balances as Record<FiatCode, number>,
      updatedAt: parsed.updatedAt ?? null,
      address: parsed.address ?? null,
    };
  } catch {
    return null;
  }
}

export async function setCachedMultiBalance(
  key: string,
  balances: Record<string, number>,
  address?: string | null,
): Promise<void> {
  try {
    const payload = {
      balances,
      updatedAt: new Date().toISOString(),
      address: address ?? null,
    };
    await storeAuthData(key, JSON.stringify(payload));
  } catch {
    // Best-effort cache write; ignore failures
  }
}
