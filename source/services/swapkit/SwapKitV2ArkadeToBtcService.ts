// Arkade → external on-chain Bitcoin address over SwapKit v2.
//
// WHY THIS EXISTS: the direct BTC_ARKADE → BTC corridor is disabled server-side
// ("Swap route disabled: Arkade → Bitcoin"), and instant Arkade offboard is
// unsafe anyway — some vtxos cannot be offboarded instantly. The rule is: when
// the recipient of an arkade send is an on-chain Bitcoin address, always route
// Lightning → Bitcoin. The server serves BTC_LN → BTC (fixedfloat), returning a
// BOLT11 invoice that settles on-chain to `settleTarget`; the wallet funds it by
// paying that invoice out of arkade via the standard pay_lightning_invoice
// executor — the exact same corridor a normal arkade Lightning send uses.
//
// ONE ORDER WHEN THE SERVER OFFERS IT: the server also serves BTC_ARKADE → BTC
// as one composite order (the Arkade solver pays the provider's invoice
// server-side), which saves the second order and its commit and still funds
// with one passkey. sendArkadeToBitcoinViaLightning prices both corridors at
// once and takes the composite when it is offered; the BTC_LN path stays as the
// fallback. Either way nothing offboards.
//
// The commit response's bound actions ARE the execution: the server binds the
// BTC_LN → BTC leg and hands back the funding Lightning invoice; nothing is
// reconstructed client-side, and no send_asset executor is installed, so the
// only money that can move is paying the bound invoice.
import { isValidBitcoinAddressMainnet } from "../../lib/bitcoin/address";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { t } from "../../lib/i18n";
import { isValidEvmAddress } from "../../lib/validation";
import { getBitcoinReceiveAddress } from "../bitcoin/BitcoinAddressService";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import {
  SWAPKIT_V2_ACTION_KINDS,
  type SwapKitV2QuoteOption,
  type SwapKitV2QuoteResponse,
  quoteSwapKitV2,
} from "./SwapKitV2Service";
import { makeStandardV2Executors } from "./SwapKitV2Executors";
import { ownBitcoinDestinations } from "../bitcoin/ownDestinations";
import { commitAndTrackV2Order } from "./SwapKitV2CommitFlow";

const SOURCE = "services/swapkit/SwapKitV2ArkadeToBtcService.ts";
void SOURCE;

const FROM_ASSET = "BTC_LN";
/** The one-order corridor: the server pays the Lightning hop itself. */
const COMPOSITE_FROM_ASSET = "BTC_ARKADE";
export type ArkadeToBtcSource = typeof FROM_ASSET | typeof COMPOSITE_FROM_ASSET;
/** The signer that funds this route: the Arkade wallet pays the bound Lightning
 * invoice. Quote and commit MUST name the same one. */
const ARKADE_TO_BTC_SIGNER_CLASS = { arkade: "arkade-vhtlc" } as const;
const TO_ASSET = "BTC";

/** Standard order-flow capabilities WITHOUT send_asset: this flow funds by
 * paying the bound Lightning invoice, never by sending to a server-named
 * address, so send_asset must stay unavailable (fail-closed). */
// No sign_typed_data either: nothing in this flow can bind a signature.
// Nor execute_evm_call: this flow has no EVM leg, so it has no route an EVM
// call could be bound to (the live corridors fund by Lightning invoice only).
const ARKADE_TO_BTC_CAPABILITIES = SWAPKIT_V2_ACTION_KINDS.filter(
  (kind) => kind !== "send_asset" && kind !== "sign_typed_data" && kind !== "execute_evm_call",
);

export type V2ArkadeToBtcQuote = {
  optionId: string;
  /** Server quoteId of the accepted option; sent back verbatim on commit. */
  quoteId?: string;
  from: string;
  to: string;
  /** Sats leaving arkade (the BTC_LN funding side, canonical sats rule). */
  sats: number;
  /** On-chain BTC the recipient receives, decimal BTC. */
  settleAmount: number;
  requiredCapabilities: string[];
  etaSeconds?: number;
  limits: SwapKitV2QuoteOption["limits"];
  provider: string | null;
  /** Until when the server commits this quote, when it says. */
  validUntil?: string;
};

export type V2ArkadeToBtcUnavailable = { provider?: string; reason?: string };

function toV2Quote(option: SwapKitV2QuoteOption): V2ArkadeToBtcQuote {
  return {
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    from: option.from,
    to: option.to,
    sats: Math.round(Number(option.depositAmount) * 100_000_000),
    settleAmount: Number(option.settleAmount),
    requiredCapabilities: option.requiredCapabilities ?? [],
    ...(option.expectedSettlement?.p50Seconds
      ? { etaSeconds: Number(option.expectedSettlement.p50Seconds) }
      : {}),
    limits: option.limits ?? null,
    provider: option.optionId.split(":")[0] || null,
    ...(option.validUntil ? { validUntil: String(option.validUntil) } : {}),
  };
}

/**
 * Quote arkade → on-chain BTC address. The funding side is sats out of arkade
 * (BTC_LN); the settle side is on-chain BTC delivered to the recipient. The
 * server prices only options this wallet's capabilities can finish.
 */
export async function quoteV2ArkadeToBtc(args: {
  toAddress: string;
  sats: number;
  owner: string;
  refundAddress?: string;
  /** BTC_LN (default): the wallet pays the bound invoice. BTC_ARKADE: one
   * composite order, refunded to the wallet's own Arkade address. */
  from?: ArkadeToBtcSource;
}): Promise<{ options: V2ArkadeToBtcQuote[]; unavailable: V2ArkadeToBtcUnavailable[] }> {
  const owner = args.owner.trim();
  if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
  const toAddress = args.toAddress.trim();
  if (!isValidBitcoinAddressMainnet(toAddress))
    throw new Error("Recipient Bitcoin address is invalid.");
  if (!Number.isSafeInteger(args.sats) || args.sats <= 0)
    throw new Error("Enter a positive Bitcoin amount.");
  const from = args.from ?? FROM_ASSET;
  const refundAddress = args.refundAddress ?? (await arkadeToBtcRefundAddress(from));
  const amountBtc = args.sats / 100_000_000;
  const response: SwapKitV2QuoteResponse = await quoteSwapKitV2({
    from,
    to: TO_ASSET,
    amount: String(amountBtc),
    side: "deposit",
    owner,
    settleTarget: toAddress,
    refundAddress,
    capabilities: ARKADE_TO_BTC_CAPABILITIES,
    signerClass: ARKADE_TO_BTC_SIGNER_CLASS,
  });
  return {
    options: (response.options ?? []).map(toV2Quote),
    unavailable: (response.unavailable ?? []).map((entry) => ({
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
  };
}

/** Refund: THIS wallet's own address, never a server-named one. A Lightning-
 * funded order (BTC_LN) refunds on the Bitcoin chain, so it takes the Arkade
 * boarding address (a Bitcoin address); the composite (BTC_ARKADE) refunds the
 * Arkade lockup, so it takes the Arkade address. Both land back in Arkade. */
async function arkadeToBtcRefundAddress(from: ArkadeToBtcSource): Promise<string> {
  if (from === COMPOSITE_FROM_ASSET) {
    const address = await getArkadeReceiveAddress();
    if (!address) throw new Error("Arkade receive address not available.");
    return String(address);
  }
  return getBitcoinReceiveAddress();
}

export type ExecuteV2ArkadeToBtcArgs = {
  toAddress: string;
  sats: number;
  /** The exact option the user accepted. */
  optionId: string;
  /** Server quoteId of the accepted option; sent back verbatim on commit. */
  quoteId?: string;
  /** On-chain BTC the accepted quote stated the recipient receives, decimal
   * BTC. Bound as the immutable minimumSettleAmount. */
  quotedReceive: number;
  owner: string;
  refundAddress?: string;
  /** This wallet's own arkade receive address, when the caller already read it
   * from the wallet (never a user- or server-supplied value). Used as the
   * refund address when none is given, and as the "ours" check for the move. */
  ownReceiveAddress?: string;
  onStatus?: (text: string) => void;
  onOrderId?: (orderId: string) => void;
  /** The corridor the accepted option was quoted on (default BTC_LN). */
  from?: ArkadeToBtcSource;
};

/**
 * Commit the accepted BTC_LN → BTC option and drive its action loop in the
 * background. The single bound funding action is a Lightning invoice paid out
 * of arkade; no send_asset executor is installed, so nothing else can move.
 */
export async function executeV2ArkadeToBtc(
  args: ExecuteV2ArkadeToBtcArgs,
): Promise<{ orderId: string }> {
  const op = newOp("SwapKitV2ArkadeToBtc", "executeV2ArkadeToBtc", LOG_EMOJI.bitcoin);
  try {
    const owner = args.owner.trim();
    if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
    const toAddress = args.toAddress.trim();
    if (!isValidBitcoinAddressMainnet(toAddress))
      throw new Error("Recipient Bitcoin address is invalid.");
    if (!args.optionId) throw new Error("The accepted option is missing.");
    if (!Number.isSafeInteger(args.sats) || args.sats <= 0)
      throw new Error("Enter a positive Bitcoin amount.");
    if (!Number.isFinite(args.quotedReceive) || args.quotedReceive <= 0) {
      throw new Error("The accepted quote is missing.");
    }
    // A Lightning-funded order refunds on the Bitcoin chain, so the refund must
    // be a Bitcoin address (the server refuses an Arkade one for BTC_LN). The
    // wallet's Arkade boarding address is one: a refund lands back in Arkade.
    // The composite refunds its Arkade lockup to the wallet's Arkade address.
    const from = args.from ?? FROM_ASSET;
    const readOwnAddress =
      args.ownReceiveAddress ||
      (args.refundAddress && from === FROM_ASSET ? null : await getBitcoinReceiveAddress());
    const refundAddress =
      args.refundAddress ??
      (from === FROM_ASSET ? (readOwnAddress as string) : await arkadeToBtcRefundAddress(from));
    const amountBtc = args.sats / 100_000_000;

    args.onStatus?.(t("swap.status.exchanging"));

    const { orderId } = await commitAndTrackV2Order({
      flow: "arkade_to_btc",
      owner,
      from,
      to: TO_ASSET,
      amount: String(amountBtc),
      side: "deposit",
      settleTarget: toAddress,
      refundAddress,
      acceptedDeposit: String(args.sats),
      acceptedDepositAmount: String(amountBtc),
      minimumSettleAmount: String(args.quotedReceive),
      capabilities: ARKADE_TO_BTC_CAPABILITIES,
      optionId: args.optionId,
      ...(args.quoteId ? { quoteId: args.quoteId } : {}),
      // Standard executors WITHOUT send_asset: the only bound actions are the
      // Lightning funding invoice paid from arkade (BTC_LN), or the composite's
      // refund material and single Arkade lockup funding (BTC_ARKADE). There is
      // no EVM leg to cap, so no approval ceiling is needed.
      loopOptions: { executors: makeStandardV2Executors({}) },
      onOrderId: args.onOrderId,
      // The arkade SOURCE rail has no transfer store, so give the move store
      // the sats it spends to render the outgoing leg on the arkade rail.
      moveAmounts: {
        sendAmount: args.sats,
        receiveAmount: Math.round(args.quotedReceive * 100_000_000),
      },
      // The same corridor serves an internal arkade -> on-chain move AND a send
      // to someone else's address; only these decide which it is, so a send can
      // never draw an "arriving" row. When the refund address above was read
      // here it IS the wallet's own arkade receive address, so it is reused
      // rather than read again; a caller-supplied one is never trusted as ours.
      own: await ownBitcoinDestinations(readOwnAddress ? { arkade: readOwnAddress } : undefined),
      // The funding leg is an Arkade VHTLC spend, which is exactly how
      // quoteV2ArkadeToBtc priced it. Committing under the EVM EOA default
      // created the order under a signer class this route never uses, and the
      // engine derives every action deadline from it.
      signerClass: ARKADE_TO_BTC_SIGNER_CLASS,
    });

    op.log("v2 arkade→btc committed", { orderId: `${orderId}`, optionId: args.optionId });
    op.end("Executed");
    return { orderId };
  } catch (e) {
    op.error("execute failed", e instanceof Error ? e.message : String(e));
    op.end("ERR");
    throw e;
  }
}

/**
 * One-call arkade → on-chain Bitcoin address over Lightning: quote the corridor,
 * take the best server-priced option, and commit it as a tracked order. This is
 * the single entry both the external send and the internal arkade→onchain move
 * funnel through — neither ever collaborative-exit offboards. Resolves once the
 * order is committed; progress is the pill + the Bitcoin-rail pending row.
 */
export async function sendArkadeToBitcoinViaLightning(args: {
  toAddress: string;
  sats: number;
  owner: string;
  onStatus?: (text: string) => void;
  onOrderId?: (orderId: string) => void;
}): Promise<{ orderId: string }> {
  // A tap while the early quote is still on its way waits for it rather than
  // asking again.
  if (prefetching?.key === prefetchKey(args)) await prefetching.done;
  const choice = takePrefetchedArkadeToBtc(args) ?? (await chooseArkadeToBtc(args));
  const { from, option, refundAddress } = choice;
  return executeV2ArkadeToBtc({
    toAddress: args.toAddress,
    sats: args.sats,
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    quotedReceive: option.settleAmount,
    owner: args.owner,
    from,
    ownReceiveAddress: refundAddress,
    ...(args.onStatus ? { onStatus: args.onStatus } : {}),
    ...(args.onOrderId ? { onOrderId: args.onOrderId } : {}),
  });
}

type ArkadeToBtcChoice = {
  from: ArkadeToBtcSource;
  option: V2ArkadeToBtcQuote;
  refundAddress: string;
};

/** Quote both corridors and pick: the one-order composite when the server
 * offers it, the two-order Lightning path as fallback, and within the chosen
 * corridor the option that delivers the most BTC. */
async function chooseArkadeToBtc(args: {
  toAddress: string;
  sats: number;
  owner: string;
}): Promise<ArkadeToBtcChoice> {
  // One read of the wallet's own receive address serves the quote, the commit
  // and the own-destination check: it is the same address each time, and each
  // read is a full wallet summary.
  const refundAddress = await getBitcoinReceiveAddress();
  const [lightning, composite] = await Promise.all([
    quoteV2ArkadeToBtc({
      toAddress: args.toAddress,
      sats: args.sats,
      owner: args.owner,
      refundAddress,
    }).catch(() => ({ options: [] as V2ArkadeToBtcQuote[] })),
    quoteV2ArkadeToBtc({
      toAddress: args.toAddress,
      sats: args.sats,
      owner: args.owner,
      from: COMPOSITE_FROM_ASSET,
    }).catch(() => ({ options: [] as V2ArkadeToBtcQuote[] })),
  ]);
  // Only the server-paid Lightning composites: an Arkade-source route that
  // offboarded instead would break the never-offboard rule above.
  const oneOrder = composite.options.filter((option) =>
    option.provider?.startsWith("arkade-intents-"),
  );
  const from = oneOrder.length ? COMPOSITE_FROM_ASSET : FROM_ASSET;
  const option = mostReceived(oneOrder.length ? oneOrder : lightning.options);
  if (!option) throw new Error("No Lightning route to Bitcoin is available.");
  return { from, option, refundAddress };
}

// ── Quote before the tap ─────────────────────────────────────────────
// The send screen knows the address and the amount before the user confirms,
// so the quote can run while they review it, as a scanned invoice's does.
// Read-only (no order, no signature); used at most once, only for exactly the
// same address, amount and owner, and only while the server still stands by it.

/** Never reuse a prefetched quote past this age, whatever its stated validity. */
const PREFETCH_MAX_AGE_MS = 45_000;
/** Stop using it this long before the server stops standing by it. */
const PREFETCH_EXPIRY_MARGIN_MS = 15_000;

let prefetched: { key: string; choice: ArkadeToBtcChoice; usableUntilMs: number } | null = null;
let prefetching: { key: string; done: Promise<void> } | null = null;
// Bumped by every new prefetch and every clear: a quote that finishes after a
// newer request or a clear is not kept.
let prefetchGeneration = 0;

const prefetchKey = (args: { toAddress: string; sats: number; owner: string }) =>
  `${args.toAddress.trim()}|${args.sats}|${args.owner.trim().toLowerCase()}`;

function takePrefetchedArkadeToBtc(args: {
  toAddress: string;
  sats: number;
  owner: string;
}): ArkadeToBtcChoice | null {
  const held = prefetched;
  prefetched = null;
  if (!held || held.key !== prefetchKey(args) || Date.now() >= held.usableUntilMs) return null;
  return held.choice;
}

/** Quote an Arkade send to a Bitcoin address ahead of the tap. Never throws. */
export async function prefetchArkadeToBitcoinQuote(args: {
  toAddress: string;
  sats: number;
  owner: string;
}): Promise<void> {
  if (!isValidBitcoinAddressMainnet(args.toAddress.trim())) return;
  if (!Number.isSafeInteger(args.sats) || args.sats <= 0) return;
  const key = prefetchKey(args);
  const generation = ++prefetchGeneration;
  const done = (async () => {
    try {
      const fetchedAtMs = Date.now();
      const choice = await chooseArkadeToBtc(args);
      const validUntilMs = Date.parse(String(choice.option.validUntil ?? ""));
      // No stated validity on the option the send would take: do not hold it.
      if (!Number.isFinite(validUntilMs)) return;
      if (generation !== prefetchGeneration) return;
      prefetched = {
        key,
        choice,
        usableUntilMs: Math.min(
          fetchedAtMs + PREFETCH_MAX_AGE_MS,
          validUntilMs - PREFETCH_EXPIRY_MARGIN_MS,
        ),
      };
    } catch {}
  })();
  prefetching = { key, done };
  await done;
  if (prefetching?.done === done) prefetching = null;
}

/** Drop any held quote (send screen closed, input changed). */
export function clearPrefetchedArkadeToBitcoinQuote(): void {
  prefetchGeneration++;
  prefetched = null;
  prefetching = null;
}

/** The option that delivers the most BTC; the server's order breaks ties. */
export function mostReceived(options: V2ArkadeToBtcQuote[]): V2ArkadeToBtcQuote | undefined {
  return options.reduce<V2ArkadeToBtcQuote | undefined>(
    (best, option) => (!best || option.settleAmount > best.settleAmount ? option : best),
    undefined,
  );
}
