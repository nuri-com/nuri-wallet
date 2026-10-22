import { SATS_PER_BTC } from "../../lib/bitcoin/convert";
import { paymentTimed, paymentTimingStart } from "../../lib/paymentTiming";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { isValidEvmAddress } from "../../lib/validation";
import { type SwapAmountBounds, foldSwapAmountBounds } from "./SwapAmountBounds";
import { type SwapKitV2LimitsResponse, getSwapKitV2Limits } from "./SwapKitV2Service";
import {
  executeV2StableToBtc,
  quoteV2StableToBtc,
  type V2StableToBtcQuote,
} from "./SwapKitV2StableToBtcService";
import {
  type BtcRail,
  type V2BtcToStableQuote,
  btcRailRefundAddress,
  executeV2BtcToStable,
  quoteV2BtcToStable,
  resolveCardSettleTarget,
} from "./SwapKitV2BtcToStableService";
import {
  executeV2DirectEvmSwap,
  quoteV2DirectEvmSwaps,
  type V2DirectEvmQuote,
} from "./SwapKitV2DirectEvmService";
import {
  BTC_ARKADE_ASSET,
  BTC_LIGHTNING_ASSET,
  BTC_ONCHAIN_ASSET,
  baseStableToken,
  type BaseStableAssetId,
  directEvmSettleToken,
  sendSettleStable,
  type SwapKitStableToken,
} from "./SwapKitStableAssets";

/**
 * ONE way to run a SwapKit swap, whatever the pair.
 *
 * Every direction used to arrive through its own function with its own
 * arguments, its own idea of when an order gets created, and its own screen. A
 * caller that wanted EURC→BTC and EURC→USDC had to know two different stories.
 * Here it knows one:
 *
 *   quoteSwap({ from, to, amount })   → prices, creates NOTHING
 *   executeSwap(acceptedQuote)        → creates, signs/pays, tracks
 *
 * The quote is the identifier. It carries everything the execution needs
 * (including an engine-private `detail`), so accepting a price and running it
 * are the same object handed along — there is no id to look up, nothing to
 * re-derive, and no second chance for the two halves to disagree about the pair,
 * the amount or the destination.
 *
 * This covers the SwapKit engines only. A plain transfer (a Wirex withdrawal,
 * an arkade offboard) has no exchange in it and therefore no price to fetch or
 * accept; forcing it through here would invent a step that does not exist.
 */

/** SwapKit asset id — `SYMBOL_CHAIN`, or one of the three Bitcoin rails. */
export type SwapAssetId = string;

export type SwapQuoteRequest = {
  from: SwapAssetId;
  to: SwapAssetId;
  /**
   * Deposit-side amount, in the FROM asset's own unit: sats for the Bitcoin
   * rails, whole tokens for the stables.
   */
  amount: number;
  /**
   * Where the receive side lands. A scanned recipient, or the address of the
   * rail the user picked — a bitcoin destination has no default, because the two
   * bitcoin rails share one asset id and guessing pays the wrong wallet.
   */
  settleTarget?: string;
  /**
   * WHICH bitcoin wallet pays, when the source is bitcoin. Both rails are the
   * same SwapKit asset, so the asset id cannot carry this — and the top-up
   * service treats an unnamed source as arkade, which would spend the wrong
   * wallet for a move the user started from the on-chain rail.
   */
  sendSource?: "arkade" | "onchain";
  /**
   * Which of the app's own balances the receive side lands on, when it is not
   * the user's EOA. Travels with the quote so the execution can write it into
   * the durable order — a balance credited optimistically needs the settlement
   * to find its way back to it, including after a restart.
   *
   * "external": someone else's address (a send that swaps on the way). The
   * swap settles to `settleTarget` as given and books nothing to this wallet.
   */
  destination?: "card" | "external";
  /**
   * A payment request: the recipient must receive exactly this, in the TO
   * asset's own unit (sats for Bitcoin, whole tokens for the stables). The
   * swap is priced and committed on the settle side and only options that
   * settle exactly this are offered; `amount` is then only an estimate.
   */
  exactReceive?: number;
};

/**
 * An input the execution needs that the amount alone does not supply. The
 * confirmation step reads this to know whether it must collect a destination
 * address before it can offer to run the swap.
 */
export type SwapQuoteRequirement = {
  field: "settleTarget";
  /** False when the engine has a default (this wallet's own account). */
  required: boolean;
  /** Which asset the address must be for, so it can be validated or scanned. */
  asset: SwapAssetId;
};

export type SwapEngineId = "direct-evm" | "stable-to-btc" | "lightning-to-btc" | "btc-to-stable";

/**
 * A price the user can be shown and accept. Nothing exists on the server for it
 * — no order, no durable row, nothing to expire — so a user may look at any
 * number of these and walk away.
 */
export type SwapQuote = {
  /** Stable key for lists and selection. Unique within one `quoteSwap` result. */
  id: string;
  engine: SwapEngineId;
  from: SwapAssetId;
  to: SwapAssetId;
  /** What leaves the wallet, in the from-asset's unit (sats for Bitcoin). */
  sendAmount: number;
  sendSymbol: string;
  /** What the route says arrives, in the to-asset's unit (sats for Bitcoin). */
  receiveAmount: number;
  receiveSymbol: string;
  /** receive / send. The rate the two amounts imply, for display. */
  rate: number;
  provider: string | null;
  /**
   * EVERY provider the route runs through, in route order. `provider` is only
   * the first of them, and a row that shows just that reads identically for two
   * different routes: `cow-usdc-base-satora-arkade` and its on-chain sibling
   * both said "CoW", so the Arkade road was on screen and unrecognisable.
   */
  providers: string[];
  /** Provider-estimated completion time, when the route states one. */
  etaSeconds?: number;
  /** The hop path, when the engine names one. Empty for a single-hop route. */
  path: string[];
  /** False for a route the app may price but not run (not yet Mainnet-proven). */
  executable: boolean;
  requirements: readonly SwapQuoteRequirement[];
  /** Wall-clock ms after which the quote must be refetched; null = no deadline. */
  expiresAt: number | null;
  /** Engine-private. Hand the quote back to `executeSwap` unchanged. */
  detail: unknown;
  /** Carried from the request, for the engine that executes this quote.
   * "external": it pays someone else, so nothing lands on this wallet. */
  destination?: "card" | "external";
  /**
   * WHICH bitcoin wallet this quote spends, for a quote that spends one. The
   * two rails are one asset id, so the caller's own bookkeeping — the outgoing
   * balance hold — cannot tell them apart from `from` alone, and holding the
   * arkade balance for a move off the on-chain rail hides sats that are still
   * there.
   */
  sendSource?: "arkade" | "onchain";
};

export type SwapExecuteOptions = {
  /** Human-readable progress, in the engine's own words. */
  onStatus?: (text: string) => void;
  /** Fires as soon as the order id exists — before any funds move. */
  onOrderId?: (orderId: string) => void;
};

export type SwapExecution = {
  /** SwapKit order id, or null when the engine settled without one. */
  orderId: string | null;
  /** Broadcast/deposit transaction, when this rail has one. */
  txHash: string | null;
  /** What actually left the wallet, in the from-asset's unit. */
  sentAmount: number;
  /**
   * What the accepted quote said would arrive. A quote, never a fill — the
   * exact fill is only knowable once the receiving transfer is mined.
   */
  quotedReceive: number | null;
};

type SwapEngine = {
  id: SwapEngineId;
  supports(request: SwapQuoteRequest): boolean;
  /** The exact v2 pairs `quote` asks for — so a pre-quote bound is read for the
   * same corridors the price would be, never a guessed one. */
  limitPairs(request: SwapQuoteRequest): Array<{ from: SwapAssetId; to: SwapAssetId }>;
  quote(request: SwapQuoteRequest): Promise<SwapQuote[]>;
  execute(quote: SwapQuote, options: SwapExecuteOptions): Promise<SwapExecution>;
};

const BTC_ASSETS = new Set([BTC_ONCHAIN_ASSET, BTC_LIGHTNING_ASSET, "BTC_ARKADE"]);
const BASE_STABLE_ASSETS = new Set<string>(["EURC_BASE", "USDC_BASE"]);

const isBtc = (asset: SwapAssetId): boolean => BTC_ASSETS.has(asset);
const isBaseStable = (asset: SwapAssetId): asset is BaseStableAssetId =>
  BASE_STABLE_ASSETS.has(asset);

const satsFromBtc = (btc: number): number => Math.round(btc * SATS_PER_BTC);

const positive = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The symbol shown next to an amount of this asset. Bitcoin is counted in sats. */
function symbolOf(asset: SwapAssetId): string {
  if (isBtc(asset)) return "sats";
  return asset.split("_")[0] ?? asset;
}

// ── Engine: EURC ⇄ USDC on Base, over SwapKit v2 ─────────────────────────────

type DirectEvmDetail = { quote: V2DirectEvmQuote };

const directEvmEngine: SwapEngine = {
  id: "direct-evm",
  // Base stable to Base stable, or to another network's stable when it pays
  // someone else's address there (a send, #1783).
  supports: (request) =>
    isBaseStable(request.from) &&
    (isBaseStable(request.to) ||
      (request.destination === "external" && sendSettleStable(request.to) !== null)),
  limitPairs: (request) => [{ from: request.from, to: request.to }],
  async quote(request) {
    const external = request.destination === "external";
    const source = baseStableToken(request.from as BaseStableAssetId);
    const target = directEvmSettleToken(request.to, external);
    if (source.asset === target.asset) throw new Error("A swap needs two different assets.");
    if (external) externalEvmTarget(request.settleTarget);
    const quotes = await quoteV2DirectEvmSwaps({
      from: request.from as BaseStableAssetId,
      to: request.to,
      amount: request.amount,
      ...(request.settleTarget ? { settleTarget: request.settleTarget } : {}),
      ...(request.exactReceive !== undefined ? { exactReceive: request.exactReceive } : {}),
    });
    // Below dust: there is no swap to offer, which is an empty list rather than
    // an error — the same answer as a pair with no route.
    return quotes.map((quote) => ({
      id: `direct-evm:${quote.optionId}`,
      engine: "direct-evm" as const,
      from: source.asset,
      to: target.asset,
      sendAmount: quote.sendAmount,
      sendSymbol: source.symbol,
      receiveAmount: quote.receiveAmount,
      receiveSymbol: target.symbol,
      rate: quote.rate,
      provider: quote.provider,
      providers: quote.provider ? [quote.provider] : [],
      path: [source.asset, target.asset],
      // v2 executability is capability-relative: only finishable options return.
      executable: true,
      requirements: [{ field: "settleTarget", required: false, asset: target.asset }] as const,
      expiresAt: quote.expiresAt as number | null,
      ...(quote.etaSeconds != null ? { etaSeconds: quote.etaSeconds } : {}),
      ...(request.destination ? { destination: request.destination } : {}),
      detail: { quote } satisfies DirectEvmDetail,
    }));
  },
  async execute(quote, options) {
    const { quote: accepted } = quote.detail as DirectEvmDetail;
    const result = await executeV2DirectEvmSwap({
      quote: accepted,
      ...(quote.destination ? { destination: quote.destination } : {}),
      op: { scope: "SwapContract", action: "executeSwap" },
      ...(options.onOrderId ? { onOrderId: options.onOrderId } : {}),
    });
    return {
      orderId: result.orderId,
      txHash: null,
      sentAmount: result.swappedAmount,
      quotedReceive: result.quotedReceive,
    };
  },
};

// ── Engine: Base stable → Bitcoin (SwapKit v2) ───────────────────────────────

type StableToBtcDetail = {
  fromAsset: BaseStableAssetId;
  toAsset: SwapAssetId;
  /** v2 quote optionId the user accepted (sent verbatim with the commit). */
  optionId: string;
  /** The option's server quoteId (sent verbatim with the commit). */
  quoteId?: string;
  quotedSpendEurc: number;
  /** The accepted quote's settle amount in the SETTLED ASSET'S decimal unit
   * (BTC for on-chain/Arkade) — NOT the sats display value. This is the exact
   * string the commit binds as `minimumSettleAmount`; the contract unit is the
   * settled asset, so passing the sats display value would bind e.g. 30000 BTC
   * for a 0.0003 BTC quote and be rejected. */
  quotedSettleAmount: number;
  stablecoinWalletAddress: string;
  settleTarget: string | null;
  /** A payment request: committed on the settle side for exactly the quote's settlement. */
  exactSettle?: boolean;
};

const stableToBtcEngine: SwapEngine = {
  id: "stable-to-btc",
  supports: (request) => isBaseStable(request.from) && isBtc(request.to),
  // quote() asks for exactly `request.to` (see priceDestination below).
  limitPairs: (request) => [{ from: request.from, to: request.to }],
  async quote(request) {
    const eoa = await getEthereumAddress();
    if (!eoa) throw new Error("Ethereum wallet address not available.");
    const fromAsset = request.from as BaseStableAssetId;
    // The destination is stated, never guessed: both bitcoin rails are the same
    // asset here, so an unnamed target could only be picked by defaulting to one
    // of them — which is paying real money to a wallet the user did not choose.
    const settleTarget = request.settleTarget?.trim() || "";
    if (!settleTarget) throw new Error("A Bitcoin destination is required.");
    const priceDestination = async (destination: {
      to: SwapAssetId;
      settleTarget: string;
    }): Promise<SwapQuote[]> => {
      // A payment request is priced on the settle side, in decimal BTC.
      const exactBtc =
        request.exactReceive !== undefined ? request.exactReceive / SATS_PER_BTC : undefined;
      const { options } = await quoteV2StableToBtc({
        fromAsset,
        to: destination.to,
        amount: exactBtc ?? request.amount,
        side: exactBtc === undefined ? "deposit" : "settle",
        owner: eoa,
        settleTarget: destination.settleTarget,
      }).catch(() => ({ options: [] as V2StableToBtcQuote[] }));
      return options.flatMap((option) => {
        // The server's own deposit term, or no option: the requested amount is
        // what was ASKED, not what this option was priced at, and committing it
        // with this option's quote id binds terms the server never offered.
        const send = positive(option.depositAmount);
        if (send === null) return [];
        // A settlement that is missing, unparseable or non-positive cannot be
        // consented to: coercing it to 0 offered the route as executable and
        // bound `minimumSettleAmount: "0"`, i.e. the user approves a spend with
        // no floor on what comes back. Refuse the option instead.
        const settle = positive(option.settleAmount);
        if (settle === null) return [];
        const receive = isBtc(destination.to) ? satsFromBtc(settle) : settle;
        // A payment request is met exactly or not at all.
        if (request.exactReceive !== undefined && receive !== request.exactReceive) return [];
        return [
          {
            id: `stable-to-btc:${option.optionId}`,
            engine: "stable-to-btc" as const,
            from: fromAsset,
            to: destination.to,
            sendAmount: send,
            sendSymbol: symbolOf(fromAsset),
            receiveAmount: receive,
            receiveSymbol: symbolOf(destination.to),
            rate: send > 0 ? receive / send : 0,
            provider: option.provider,
            providers: option.provider ? [option.provider] : [],
            ...(option.etaSeconds != null ? { etaSeconds: option.etaSeconds } : {}),
            path: [fromAsset, destination.to],
            // v2 executability is capability-relative: the server returns ONLY
            // options this wallet's declared capabilities can finish.
            executable: true,
            requirements: [
              { field: "settleTarget", required: true, asset: destination.to },
            ] as const,
            expiresAt: null as number | null,
            ...(request.destination === "external" ? { destination: "external" as const } : {}),
            detail: {
              fromAsset,
              toAsset: destination.to,
              optionId: option.optionId,
              ...(option.quoteId ? { quoteId: option.quoteId } : {}),
              quotedSpendEurc: send,
              quotedSettleAmount: settle,
              stablecoinWalletAddress: eoa,
              settleTarget: destination.settleTarget,
              ...(exactBtc !== undefined ? { exactSettle: true } : {}),
            } satisfies StableToBtcDetail,
          },
        ];
      });
    };

    // Always request the plain on-chain BTC route to the stated destination.
    // For "Bitcoin Lightning" (arkade) the destination is the wallet's own
    // boarding address, so a stable → on-chain-BTC settle (LiFi / oneclick /
    // bitcoinvn, whichever the server quotes as executable) lands the funds
    // where arkade boards them from — one signature, no satora HTLC/claim. The
    // hidden direct-Arkade (satora) corridor is deliberately NOT requested.
    return priceDestination({ to: request.to, settleTarget });
  },
  async execute(quote, options) {
    const detail = quote.detail as StableToBtcDetail;
    const settleTarget = detail.settleTarget?.trim() || "";
    if (!settleTarget) throw new Error("A Bitcoin destination is required.");
    const result = await executeV2StableToBtc({
      fromAsset: detail.fromAsset,
      to: detail.toAsset,
      // The request the quote was made for.
      amount: detail.exactSettle ? detail.quotedSettleAmount : detail.quotedSpendEurc,
      side: detail.exactSettle ? "settle" : "deposit",
      optionId: detail.optionId,
      ...(detail.quoteId ? { quoteId: detail.quoteId } : {}),
      quotedDeposit: detail.quotedSpendEurc,
      quotedReceive: detail.quotedSettleAmount,
      owner: detail.stablecoinWalletAddress,
      settleTarget,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(options.onOrderId ? { onOrderId: options.onOrderId } : {}),
    });
    return {
      orderId: result.orderId,
      txHash: null,
      sentAmount: detail.quotedSpendEurc,
      quotedReceive: quote.receiveAmount,
    };
  },
};

// ── Engine: Bitcoin → Base stable, over SwapKit v2 ───────────────────────────

/** The Bitcoin corridor each wallet funds: the Arkade balance pays the native
 * BTC_ARKADE route, the on-chain wallet the BTC one. Never Arkade into an
 * on-chain route: moving the sats on-chain first only adds a fee, a block of
 * waiting and a step that can fail, for a swap Arkade pays directly (dev
 * excludes it for the same reason). Shared by quote() and limitPairs(). */
const btcRailsFor = (sendSource: "arkade" | "onchain"): BtcRail[] =>
  sendSource === "onchain" ? [BTC_ONCHAIN_ASSET] : [BTC_ARKADE_ASSET];

type BtcToStableDetail = {
  sats: number;
  /** The amount the quote was requested for. The commit must name this exact
   * request: the server binds the accepted quote to it, and the option's own
   * deposit can differ (Arkade Intents states a ceiling below the amount). */
  requestedSats: number;
  /** The exact v2 option the user accepted. */
  optionId: string;
  /** The option's server quoteId (sent verbatim with the commit). */
  quoteId?: string;
  quotedReceiveStable: number;
  /** The hub-USDC amount the accepted option bound — the settle-leg approval cap
   * when the route carries a wallet-signed EVM leg; null otherwise (a pure
   * send_asset offboard or a Lightning route has no EVM approval to cap). */
  expectedUsdc: number | null;
  /** WHICH Bitcoin corridor this option is on — never inferred at execute. */
  rail: BtcRail;
  sendSource: "arkade" | "onchain";
  /** Which stable the quote was taken in — carried so execute settles the same
   * token the user was shown, never the default. */
  stable: SwapKitStableToken;
  /** The wallet or the card: which EVM address receives. The rails and their
   * offers are identical for both; only the settle target differs, and it is
   * bound at quote time so execute pays exactly the account the user saw. */
  destination: "wallet" | "card" | "external";
  settleTarget: string;
  /** A payment request: the exact stable amount committed on the settle side. */
  settleExact?: string;
};

const btcToStableEngine: SwapEngine = {
  id: "btc-to-stable",
  // Settles the stable to this wallet's own EOA, or to the card account when
  // the move's destination is the card (#1458). Same rails and same offers
  // either way: the card is a different EVM address that receives, nothing
  // else. It needs no extra filter here: this flow never declares EVM signing
  // (BTC_TO_STABLE_CAPABILITIES), so every option the server returns is
  // finished by the one Bitcoin payment and pays the stable straight to the
  // settle target — nothing is left for the card, which cannot sign, to do.
  supports: (request) => isBtc(request.from) && isBaseStable(request.to),
  limitPairs: (request) =>
    btcRailsFor(request.sendSource ?? "arkade").map((rail) => ({ from: rail, to: request.to })),
  async quote(request) {
    const sendSource = request.sendSource ?? "arkade";
    const toStable = request.to as BaseStableAssetId;
    const stable = baseStableToken(toStable);
    const owner = await getEthereumAddress();
    if (!owner) return [];
    const destination: "wallet" | "card" | "external" =
      request.destination === "card" || request.destination === "external"
        ? request.destination
        : "wallet";
    // Resolved ONCE, before anything is priced: a card that cannot receive
    // this stable (another token, or no card account yet) throws here, so no
    // route is ever shown for it, and the quote and the commit bind the same
    // account.
    // Someone else's address is paid exactly as the send stated it; only this
    // wallet's own accounts are resolved here.
    const settleTarget =
      destination === "external"
        ? externalEvmTarget(request.settleTarget)
        : await resolveCardSettleTarget(destination, owner, toStable);
    // The sheet names the card account it showed the user; the resolution is
    // the authority. A mismatch means the screen is stale — price nothing
    // rather than pay an address the user did not see.
    if (
      destination === "card" &&
      request.settleTarget &&
      request.settleTarget.trim().toLowerCase() !== settleTarget.toLowerCase()
    ) {
      throw new Error("Card account changed. Open the move again.");
    }
    // The refund address the quote binds MUST equal the one commit will use —
    // quoting with the EVM address and committing with the Bitcoin/Arkade one
    // is two different bound requests. Resolve each rail's own refund up front
    // and pass it into BOTH quote and (via detail) execute.
    // One corridor per wallet: Arkade quotes BTC_ARKADE, the on-chain wallet
    // quotes BTC.
    const rails = btcRailsFor(sendSource);
    const perRail = await Promise.all(
      rails.map(async (rail) => {
        const refundAddress = await btcRailRefundAddress(rail, sendSource);
        if (!refundAddress) return { rail, options: [] as V2BtcToStableQuote[] };
        return quoteV2BtcToStable({
          rail,
          toStable,
          sats: request.amount,
          owner,
          settleTarget,
          refundAddress,
          // A payment request is priced on the settle side.
          ...(request.exactReceive !== undefined
            ? { settleExact: String(request.exactReceive) }
            : {}),
        })
          .then((result) => ({ rail, options: result.options }))
          .catch(() => ({ rail, options: [] as V2BtcToStableQuote[] }));
      }),
    );
    const quotes: SwapQuote[] = [];
    for (const { rail, options } of perRail) {
      for (const option of options) {
        // A payment request is met exactly or not at all.
        if (request.exactReceive !== undefined && option.settleAmount !== request.exactReceive) {
          continue;
        }
        // Present EVERY option the server priced — no client-side provider
        // filter. A pure send_asset offboard or a Lightning route carries no
        // hub-USDC leg; that is not a reason to hide it. The user chooses.
        quotes.push({
          id: `btc-to-stable:${option.optionId}`,
          engine: "btc-to-stable" as const,
          from: request.from,
          to: request.to,
          // Sats are fixed by the user; on the BTC_ARKADE rail the VHTLC also
          // carries a spread, but v2 binds the deposit in the option itself —
          // `option.sats` is exactly what leaves the wallet.
          sendAmount: option.sats,
          sendSymbol: symbolOf(request.from),
          receiveAmount: option.settleAmount,
          receiveSymbol: symbolOf(request.to),
          rate: option.sats > 0 ? option.settleAmount / option.sats : 0,
          provider: option.provider,
          providers: option.provider ? [option.provider] : [],
          ...(option.etaSeconds != null ? { etaSeconds: option.etaSeconds } : {}),
          // The corridor is the path's first leg, so the instant-settling tier
          // recognises a native BTC_ARKADE route (off-chain) apart from a BTC
          // offboard (waits for a block). A USDC hub is named only when the
          // server's option carries a real USDC_BASE leg (`expectedUsdc`);
          // most routes pay the target directly, and a hub the route never
          // takes is a wrong label on the route card.
          path:
            option.expectedUsdc != null && request.to !== "USDC_BASE"
              ? [rail, "USDC_BASE", request.to]
              : [rail, request.to],
          // v2 executability is capability-relative: the server returns ONLY
          // options this wallet's declared capabilities can finish.
          executable: true,
          requirements: [] as const,
          expiresAt: null as number | null,
          sendSource,
          detail: {
            sats: option.sats,
            requestedSats: request.amount,
            optionId: option.optionId,
            ...(option.quoteId ? { quoteId: option.quoteId } : {}),
            quotedReceiveStable: option.settleAmount,
            expectedUsdc: option.expectedUsdc,
            rail,
            sendSource,
            stable,
            destination,
            settleTarget,
            ...(request.exactReceive !== undefined
              ? { settleExact: String(request.exactReceive) }
              : {}),
          } satisfies BtcToStableDetail,
          // Carried so the executed move is booked to the balance that
          // receives it: the card's, not the wallet's, and nothing for a send.
          ...(destination === "card" || destination === "external" ? { destination } : {}),
        });
      }
    }
    return quotes;
  },
  async execute(quote, options) {
    const detail = quote.detail as BtcToStableDetail;
    const owner = await paymentTimed("owner address", () => getEthereumAddress());
    if (!owner) throw new Error("Base wallet address not available.");
    const { orderId } = await executeV2BtcToStable({
      rail: detail.rail,
      toStable: detail.stable.asset as BaseStableAssetId,
      sats: detail.sats,
      ...(detail.requestedSats ? { requestedSats: detail.requestedSats } : {}),
      optionId: detail.optionId,
      ...(detail.quoteId ? { quoteId: detail.quoteId } : {}),
      quotedReceiveStable: detail.quotedReceiveStable,
      expectedUsdc: detail.expectedUsdc,
      owner,
      // The account the quote priced, never re-resolved: the user accepted a
      // price for THIS recipient.
      settleTarget: detail.settleTarget,
      destination: detail.destination,
      sendSource: detail.sendSource,
      ...(detail.settleExact ? { settleExact: detail.settleExact } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(options.onOrderId ? { onOrderId: options.onOrderId } : {}),
    });
    return {
      // The order the durable tracker follows. The card books its credit
      // against it and settles or reverts that credit by the same id.
      orderId,
      txHash: null,
      sentAmount: detail.sats,
      quotedReceive: detail.quotedReceiveStable,
    };
  },
};

/** A send's recipient on the stable side: a real EVM address, never a default. */
function externalEvmTarget(settleTarget: string | undefined): string {
  const target = settleTarget?.trim() ?? "";
  if (!isValidEvmAddress(target)) throw new Error("A wallet address is required.");
  return target;
}

const ENGINES: readonly SwapEngine[] = [directEvmEngine, stableToBtcEngine, btcToStableEngine];

/** The Bitcoin legs that settle off-chain: no block to wait for. */
const INSTANT_BTC_LEGS = new Set<string>([BTC_ARKADE_ASSET, BTC_LIGHTNING_ASSET]);

/**
 * A route that settles in seconds rather than waiting for a confirmation.
 *
 * The path is the evidence: an Arkade or Lightning leg never touches the chain,
 * while an on-chain BTC leg waits for a block. A DIRECT Arkade route — one hop,
 * BTC_ARKADE as its first leg — sits in this tier; a BTC offboard does not.
 *
 * An on-chain BTC leg anywhere vetoes it: a mixed path — an Arkade hop that then
 * offboards — still waits for a block, so counting it as instant would let it
 * outrank a route that genuinely finishes in seconds.
 */
function isInstantSettling(quote: SwapQuote): boolean {
  // An on-chain leg anywhere in the chain settles this route in blocks, however
  // instant its other legs are — a mixed path is as slow as its slowest hop, so
  // it must not outrank a route that finishes in seconds.
  if (quote.path.some((leg) => leg.trim().toUpperCase() === BTC_ONCHAIN_ASSET)) return false;
  return quote.path.some((leg) => INSTANT_BTC_LEGS.has(leg.trim().toUpperCase()));
}

function engineFor(request: SwapQuoteRequest): SwapEngine {
  const engine = ENGINES.find((candidate) => candidate.supports(request));
  if (!engine) throw new Error(`No swap route from ${request.from} to ${request.to}.`);
  return engine;
}

/**
 * What this swap would pay out, best rate first. Creates nothing: a user may
 * quote as often as they like and leave nothing behind on the server.
 *
 * An empty list means this pair has no route right now (or nothing worth
 * swapping at this amount) — not an error.
 */
export async function quoteSwap(request: SwapQuoteRequest): Promise<SwapQuote[]> {
  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    throw new Error("A swap needs a positive amount.");
  }
  const quotes = await engineFor(request).quote(request);
  // effectiveRate is settle/deposit, so "higher is better" holds in both
  // directions. Runnable routes sort above display-only ones, and among those
  // the instant-settling rails lead: they finish in seconds where an offboard
  // waits for a confirmation, and the cents between them do not buy that back.
  // Within that tier the rate decides — a direct Arkade hop and the Lightning
  // corridor are both instant, so the better price wins on merit rather than on
  // which rail it happens to use. Every other route is still listed, in rate
  // order, for a user who wants one.
  return quotes
    .slice()
    .sort(
      (a, b) =>
        Number(b.executable) - Number(a.executable) ||
        Number(isInstantSettling(b)) - Number(isInstantSettling(a)) ||
        b.rate - a.rate,
    );
}

/**
 * The move's amount bounds BEFORE any price is asked for, in the from-asset's
 * unit (sats for Bitcoin). Read-only: reads `swap_limits` for exactly the v2
 * pairs `quoteSwap` would price. Never throws — a pair no engine covers, an
 * older server without the tool, or a network error all answer "no bound
 * known", which leaves the move exactly as it behaved before.
 */
export async function swapAmountBounds(
  request: Pick<SwapQuoteRequest, "from" | "to" | "sendSource">,
): Promise<SwapAmountBounds> {
  const engine = ENGINES.find((candidate) => candidate.supports(request as SwapQuoteRequest));
  if (!engine) return { min: null, max: null };
  const pairs = engine.limitPairs(request as SwapQuoteRequest);
  const answers = await Promise.all(
    pairs.map(
      (pair): Promise<SwapKitV2LimitsResponse | null> =>
        getSwapKitV2Limits(pair).catch((): null => null),
    ),
  );
  return foldSwapAmountBounds(answers);
}

/**
 * Run the quote the user accepted: create, sign or pay, and hand the order to
 * its durable tracker. The ONLY call here that can move money.
 *
 * Pass the quote object back unchanged — it is the accepted price, and every
 * engine binds its execution to what that price said.
 */
export async function executeSwap(
  quote: SwapQuote,
  options: SwapExecuteOptions = {},
): Promise<SwapExecution> {
  if (!quote.executable) {
    throw new Error("This route cannot be executed yet.");
  }
  if (quote.expiresAt != null && Date.now() > quote.expiresAt) {
    throw new Error("This quote has expired. Check the price again.");
  }
  const engine = ENGINES.find((candidate) => candidate.id === quote.engine);
  if (!engine) throw new Error(`Unknown swap engine ${quote.engine}.`);
  paymentTimingStart("swap", { engine: quote.engine });
  return engine.execute(quote, options);
}
