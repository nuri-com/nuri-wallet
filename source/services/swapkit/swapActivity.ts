// Which activity rows are legs of a swap. SwapKit lists every order of this
// wallet with the transactions its ledger recorded (funding, settlement,
// refund); a row whose transaction is one of them reads as that swap
// ("Euro → Bitcoin") instead of an anonymous wallet.
import { useEffect, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { BTC_LOGO, EUR_FLAG, USD_FLAG, VISA_LOGO } from "../../lib/railMarks";
import { wirexAccountService } from "../wirex/WirexAccountService";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { t } from "../../lib/i18n";
import { formatFiat } from "../../lib/currency/displayFiat";
import { groupCount } from "../../lib/formatting";
import { LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";
import { listSwapKitV2Orders } from "./SwapKitV2Service";

export type SwapRole = "funding" | "settlement" | "refund";

/**
 * The swap a transaction belongs to: what it sold, what it bought, where the
 * payout went, and which of the order's transactions this one is (one hash can
 * be both funding and payout of a same-chain swap).
 */
export type SwapLeg = {
  from: string;
  to: string;
  settleTarget: string;
  roles: SwapRole[];
  /** What left and what arrived, as the server's decimal strings (canonical unit). */
  sent?: string;
  received?: string;
};
type Legs = Map<string, SwapLeg>;

const txKey = (hash: string) => hash.trim().toLowerCase().replace(/^0x/, "");

// Everything is kept per wallet, in memory and on disk: a wallet replaced in
// the same run never reads, reuses or publishes the previous wallet's swaps.
const cacheKey = (owner: string) => `swap:legs:v2:${owner}`;
type Entry = { legs: Legs; loadedAt: number; inFlight: Promise<Legs> | null };
const byOwner = new Map<string, Entry>();
const entryFor = (owner: string): Entry => {
  let entry = byOwner.get(owner);
  if (!entry) {
    entry = { legs: new Map(), loadedAt: 0, inFlight: null };
    byOwner.set(owner, entry);
  }
  return entry;
};

const currentOwner = async () =>
  ((await getEthereumAddress().catch((): null => null)) ?? "").toLowerCase() || null;

async function cachedSwapLegs(owner: string): Promise<Legs> {
  const rows = await getCacheValue<[string, SwapLeg][]>(cacheKey(owner)).catch((): null => null);
  return new Map(Array.isArray(rows) ? rows : []);
}

async function loadSwapLegs(owner: string): Promise<Legs> {
  const recoveryKey = await getSwapKitV2RecoveryKey().catch((): null => null);
  if (!recoveryKey) throw new Error("wallet not unlocked yet");
  const listed = await listSwapKitV2Orders({ owner, recoveryKey });
  const map: Legs = new Map();
  for (const order of listed.orders ?? []) {
    const accepted = (order.accepted ?? {}) as {
      from?: unknown;
      to?: unknown;
      settleTarget?: unknown;
      acceptedDepositAmount?: unknown;
      minimumSettleAmount?: unknown;
    };
    const execution = (order.execution ?? {}) as {
      depositAmount?: unknown;
      settleAmount?: unknown;
    };
    const tx = (order.transactions ?? {}) as Record<string, unknown>;
    // The amounts the order ran with, else the bounds the user accepted.
    const sent = execution.depositAmount ?? accepted.acceptedDepositAmount;
    const received = execution.settleAmount ?? accepted.minimumSettleAmount;
    const base = {
      from: String(accepted.from ?? ""),
      to: String(accepted.to ?? ""),
      settleTarget: String(accepted.settleTarget ?? "").toLowerCase(),
      ...(sent != null && String(sent) ? { sent: String(sent) } : {}),
      ...(received != null && String(received) ? { received: String(received) } : {}),
    };
    for (const role of ["funding", "settlement", "refund"] as const) {
      const hash = tx[role];
      if (typeof hash !== "string" || !hash) continue;
      const key = txKey(hash);
      const roles = map.get(key)?.roles ?? [];
      map.set(key, { ...base, roles: [...roles, role] });
    }
  }
  logWithId(
    `${LOG_EMOJI.network} SwapLegs`,
    `${listed.orders?.length ?? 0} orders, ${map.size} transactions`,
    undefined,
    { source: "services/swapkit/swapActivity.ts#loadSwapLegs", event: "FLOW", action: "load" },
  );
  return map;
}

// One request per wallet at a time, at most once a minute, and never waited on
// forever: every open of a list used to start its own swap_list.
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 20_000;

export function refreshSwapLegs(owner: string): Promise<Legs> {
  const entry = entryFor(owner);
  if (entry.legs.size > 0 && Date.now() - entry.loadedAt < REFRESH_MS) {
    return Promise.resolve(entry.legs);
  }
  // The request stays the one in flight until the server answers, even when a
  // screen stopped waiting for it: a slow answer is never asked twice.
  entry.inFlight ??= loadSwapLegs(owner)
    .then((map) => {
      entry.legs = map;
      entry.loadedAt = Date.now();
      // Saved in the background: the list is labelled now, not after the write.
      void setCacheValue(cacheKey(owner), [...map.entries()]).catch(() => {});
      return map;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("swap_list timed out")), TIMEOUT_MS);
  });
  return Promise.race([entry.inFlight, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The swap legs of the signed-in wallet: its saved copy at once, then the
 * server's answer when `active` turns on (the list is mounted before the wallet
 * is unlocked, so a load at mount knows nothing). An answer is published only
 * while the same wallet is still signed in.
 */
export function useSwapLegs(active: boolean): Legs {
  const [value, setValue] = useState<Legs>(() => new Map());
  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      const owner = await currentOwner();
      if (!live || !owner) return;
      const still = async () => live && (await currentOwner()) === owner;
      const entry = entryFor(owner);
      if (entry.legs.size === 0) {
        const saved = await cachedSwapLegs(owner);
        if (saved.size > 0 && entry.legs.size === 0) entry.legs = saved;
      }
      if (await still()) setValue(entry.legs);
      try {
        const map = await refreshSwapLegs(owner);
        if (await still()) setValue(map);
      } catch (error) {
        logWithId(`${LOG_EMOJI.network} SwapLegs`, "not loaded", {
          error: String((error as Error)?.message ?? error),
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [active]);
  return value;
}

export function swapLegFor(legs: Legs, hash: string | null | undefined) {
  return hash ? (legs.get(txKey(hash)) ?? null) : null;
}

type Side = { name: string; image?: ImageSourcePropType };

const symbolOf = (id: string) => id.split(/[_@]/)[0] ?? id;

/** An asset as the home names it: by its currency, never a token ticker. */
function sideOf(id: string): Side {
  const symbol = symbolOf(id);
  if (/^BTC$/.test(symbol)) return { name: t("screen.HomeScreen.railBitcoin"), image: BTC_LOGO };
  if (/^EUR/.test(symbol)) return { name: t("screen.HomeScreen.railEuro"), image: EUR_FLAG };
  if (/^(USD|DAI$)/.test(symbol))
    return { name: t("screen.HomeScreen.railDollar"), image: USD_FLAG };
  return { name: symbol };
}

/** Decimal BTC as whole sats, from the string (no float rounding). */
function satsOf(decimal: string): number | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] ?? "").padEnd(8, "0");
  if (frac.length > 8 && /[1-9]/.test(frac.slice(8))) return null;
  return Number(m[1] || "0") * 100_000_000 + Number(frac.slice(0, 8));
}

/** A swap amount the way activity rows write money: "EUR 5.00", "BTC 6 844". */
export function swapAmountText(id: string, decimal: string | undefined): string | null {
  if (!decimal) return null;
  const symbol = symbolOf(id);
  if (/^BTC$/.test(symbol)) {
    const sats = satsOf(decimal);
    return sats === null ? null : `BTC ${groupCount(sats)}`;
  }
  const value = Number(decimal);
  if (!Number.isFinite(value)) return null;
  if (/^EUR/.test(symbol)) return formatFiat(value, "EUR");
  if (/^(USD|DAI$)/.test(symbol)) return formatFiat(value, "USD");
  return `${symbol} ${decimal}`;
}

/** Both sides of a swap, for its details: what was sold and what was bought. */
export type SwapSides = {
  from: { name: string; amount: string | null };
  to: { name: string; amount: string | null };
};

const CARD: Side = {
  name: t("screen.HomeScreen.groupCardBanking"),
  image: VISA_LOGO,
};

/**
 * How a row that is a leg of a swap reads: "Euro → Bitcoin", with the other
 * side's mark as the row's picture; a refund as the source money coming back.
 * Null when the row is no swap. Whether the payout went to the card is decided
 * now, from the card the wallet knows now, never from a copy saved earlier.
 */
export function swapRow(
  legs: Legs,
  hash: string | null | undefined,
  incoming: boolean,
): { title: string; image?: ImageSourcePropType; sides?: SwapSides } | null {
  const leg = swapLegFor(legs, hash);
  if (!leg) return null;
  const from = sideOf(leg.from);
  // Money that came back from a swap is the money it was paid with.
  if (incoming && leg.roles.includes("refund") && !leg.roles.includes("settlement")) {
    return { title: `${from.name} refund`, ...(from.image ? { image: from.image } : {}) };
  }
  const card = (wirexAccountService.depositAddress() ?? "").toLowerCase();
  const to = card && leg.settleTarget === card ? CARD : sideOf(leg.to);
  // Same money on both sides (EURC on Ethereum into your Euro, USDT into
  // Dollar): no swap to show, it is your own money moving between wallets.
  if (from.name === to.name) {
    return {
      title: t(
        incoming
          ? "screen.WalletTransactionsModal.fromYourWallet"
          : "screen.WalletTransactionsModal.toYourWallet",
      ),
    };
  }
  // Every swap reads the same way, both legs. The picture is the side outside
  // this wallet; Euro and Dollar are both the Cash wallet, so a swap between
  // them shows where the money went.
  const cash = (side: Side) => side.image === EUR_FLAG || side.image === USD_FLAG;
  const other = cash(from) && cash(to) ? to : incoming ? from : to;
  const sides: SwapSides = {
    from: { name: from.name, amount: swapAmountText(leg.from, leg.sent) },
    to: { name: to.name, amount: swapAmountText(leg.to, leg.received) },
  };
  return {
    title: `${from.name} → ${to.name}`,
    ...(other.image ? { image: other.image } : {}),
    sides,
  };
}
