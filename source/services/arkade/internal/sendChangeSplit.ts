// Does this send leave change the node will refuse?
//
// The Ark server keeps sats exactly (`sum(inputs) == sum(outputs)`) and refuses
// any output under its `vtxoMinAmount`. Together those two rules mean a send
// whose remainder lands in `(0, vtxoMinAmount)` cannot exist at all: the
// remainder is too small for a change output, arkd allows no subdust output
// below that floor either, and dropping it into a fee would break conservation.
// So the wallet has to spend one more VTXO to lift the change over the floor,
// or the amount has to be refused before an approval is armed and a passkey
// prompt is spent.
//
// `ArkadeSendService.sendArkadeToArk` only ever proved the requested amount
// (issue #1595: a 3,970-sat send from a 4,139-sat VTXO was refused by the
// server with `output #1 amount is lower than min vtxo amount: 330` after the
// user had already approved). This module turns that into a decision that can
// be taken before anything is signed, and it is kept free of the SDK so it can
// be unit-tested.
import { normalizeExpiryMs } from "./settlementExpiryGap";

/** The two facts a spendable VTXO contributes to the decision. */
export type SendSplitCoin = {
  value?: unknown;
  expiresAt?: unknown;
  /** SDK 0.5 height expiry, in the same units the SDK multiplies by 1000. */
  expiresAtHeight?: unknown;
  /** Legacy (pre-0.5 SDK) envelope; only the batch expiry is read. */
  virtualStatus?: unknown;
};

export type SendSplitPlan<T> =
  /** The wallet's own selection is valid: let it choose. */
  | { kind: "auto" }
  /** Spend exactly these inputs: the wallet's own pick plus a top-up. */
  | { kind: "grow"; coins: T[] }
  /** No input set can fund this amount legally; offer the largest that can. */
  | { kind: "refuse"; maxSendableSats: number };

function coinSats(coin: SendSplitCoin): number {
  const sats = Number(coin?.value);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

/**
 * The coin's batch expiry as a comparable number of milliseconds, mirroring the
 * installed SDK's own normalization (`normalizeVtxo` + `toBatchExpiry`) so the
 * wallet's pick and this plan cannot order the same coins differently:
 *
 * - a canonical `expiresAt` wins over `expiresAtHeight`, which wins over the
 *   legacy `virtualStatus.batchExpiry` envelope;
 * - a height expiry is compared as `height * 1000`, exactly as the SDK does;
 *   treating it as missing puts a height-expiring coin last and can turn an
 *   exact spend the wallet handles into a false refusal;
 * - a legacy `batchExpiry` is already the sort key in both of the SDK's own
 *   branches (date, or height-in-seconds scaled back up).
 *
 * Unreadable expiry sorts last, which only ever adds coins to the selection.
 */
function coinExpiryMs(coin: SendSplitCoin): number {
  const hasCanonical = coin?.expiresAt !== undefined || coin?.expiresAtHeight !== undefined;
  if (hasCanonical) {
    if (coin.expiresAt !== undefined) {
      const fromDate = normalizeExpiryMs(coin.expiresAt);
      if (fromDate !== null) return fromDate;
    }
    const height = Number(coin.expiresAtHeight);
    if (Number.isFinite(height) && height > 0) return Math.trunc(height * 1000);
    return Number.MAX_SAFE_INTEGER;
  }
  const batchExpiry = (coin?.virtualStatus as { batchExpiry?: unknown } | undefined)?.batchExpiry;
  if (typeof batchExpiry === "string" && batchExpiry.trim() && !/^\d+$/.test(batchExpiry.trim())) {
    return normalizeExpiryMs(batchExpiry) ?? Number.MAX_SAFE_INTEGER;
  }
  const legacy = Number(batchExpiry);
  return Number.isFinite(legacy) && legacy > 0 ? Math.trunc(legacy) : Number.MAX_SAFE_INTEGER;
}

/**
 * Order coins the way the SDK's own send selection does (soonest batch expiry
 * first, then largest), so "grow" keeps spending the coins the wallet would
 * have spent anyway rather than re-ordering the user's VTXOs.
 */
function orderedCoins<T extends SendSplitCoin>(coins: readonly T[]): T[] {
  return [...coins].sort((a, b) => {
    const expiryDiff = coinExpiryMs(a) - coinExpiryMs(b);
    if (expiryDiff !== 0) return expiryDiff;
    return coinSats(b) - coinSats(a);
  });
}

/**
 * Plan the inputs for an offchain send of `amountSats` off `coins`.
 *
 * Unreadable input is "auto": a wallet that cannot be read must not be turned
 * into a refusal, and the send keeps its previous behaviour.
 */
export function planSendChangeSplit<T extends SendSplitCoin>(
  coins: readonly T[] | null | undefined,
  amountSats: number,
  minVtxoSats: number,
): SendSplitPlan<T> {
  const amount = Math.trunc(Number(amountSats));
  const floor = Math.trunc(Number(minVtxoSats));
  if (!Array.isArray(coins) || coins.length === 0) return { kind: "auto" };
  if (!(amount > 0) || !(floor > 0)) return { kind: "auto" };

  const spendable = orderedCoins(coins.filter((coin) => coinSats(coin) > 0));
  const picked: T[] = [];
  let total = 0;
  for (const coin of spendable) {
    picked.push(coin);
    total += coinSats(coin);
    if (total >= amount) break;
  }
  // Short of the amount: that is the wallet's own insufficient-funds error and
  // not this check's to raise.
  if (total < amount) return { kind: "auto" };
  // Change of exactly zero, or change the node will accept: nothing to fix.
  if (total === amount) return { kind: "auto" };
  if (total - amount >= floor) return { kind: "auto" };

  // Change under the floor. Adding a coin only ever grows the remainder, so
  // keep spending until it either clears the floor or the wallet runs out.
  for (let index = picked.length; index < spendable.length; index += 1) {
    const coin = spendable[index];
    picked.push(coin);
    total += coinSats(coin);
    if (total - amount >= floor) return { kind: "grow", coins: picked };
  }

  // Every spendable VTXO is already in, and the remainder is still under the
  // floor: the amount sits in the gap just below the balance and no input set
  // can fund it. The largest amount that can be sent is the balance less the
  // floor, which leaves exactly one floor-sized change VTXO.
  return { kind: "refuse", maxSendableSats: Math.max(0, total - floor) };
}
