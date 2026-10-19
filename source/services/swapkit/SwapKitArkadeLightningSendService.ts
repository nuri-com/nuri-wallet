import { claimSwapLoop, releaseSwapLoop } from "./SwapKitLoopRegistry";
// Arkade Lightning v2: quote, durable commit, then public refund material.
// Returns the bound funding action without moving money. The caller holds the
// shared order-loop claim until its approved funding send finishes, then releases
// it for the v2 tracker. This keeps wallet-summary wakeups from funding in parallel.
import { isValidArkAddress } from "@arkade-os/sdk";
import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  ARKADE_LIGHTNING_MAX_SEND_SATS,
  ARKADE_LIGHTNING_MIN_SEND_SATS,
} from "../../config/constants";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import {
  asSwapKitV2OrderId,
  cancelSwapKitV2Order,
  classifyErrorCode,
  commitSwapKitV2,
  isSwapKitV2Terminal,
  quoteSwapKitV2,
  SwapKitV2Error,
  type SwapKitV2Action,
  type SwapKitV2OrderView,
  type SwapKitV2QuoteOption,
  type SwapKitV2QuoteResponse,
} from "./SwapKitV2Service";
import { executeAndSubmitV2Action } from "./SwapKitV2ActionService";
import {
  abandonV2CommitIntent,
  persistV2CommitIntent,
  resolveV2CommitIntent,
  SwapKitV2OrderStore,
} from "./SwapKitV2OrderStore";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";

export const LIGHTNING_V2_CAPABILITIES = [
  "arkade_refund_material",
  "arkade_intents_fund",
  "arkade_intents_refund",
] as const;

/** Diagnostic label only; v2 selects the quoted optionId, never a route id. */
export const ARKADE_INTENTS_LIGHTNING_ROUTE_ID = "arkade-intents-btc-arkade-btc-ln";

const FROM_ASSET = "BTC_ARKADE";
const TO_ASSET = "BTC_LN";

export type ArkadeIntentsLightningSend = {
  txId: string;
  rfqId: string;
  refundLocktime: number;
  lockupAddress: string;
  fundAmountSats: number;
  fundingAction: SwapKitV2Action;
  recoveryKey: string;
  view: SwapKitV2OrderView;
  /** What the invoice asks for, decoded locally. Display only. */
  invoiceSats: number;
};

/**
 * The bounds the corridor serves, checked before anything is quoted.
 *
 * The solver refuses out-of-range itself, but learning that after the user has
 * entered an amount and pressed confirm is a worse way to find out.
 */
export function isArkadeLightningAmountInRange(sats: number): boolean {
  const amount = Math.trunc(Number(sats));
  return (
    Number.isFinite(amount) &&
    amount >= ARKADE_LIGHTNING_MIN_SEND_SATS &&
    amount <= ARKADE_LIGHTNING_MAX_SEND_SATS
  );
}

function lightningQuoteRequest(args: {
  invoice: string;
  invoiceSats: number;
  owner: string;
  refundAddress: string;
}) {
  return {
    from: FROM_ASSET,
    to: TO_ASSET,
    amount: (args.invoiceSats / 1e8).toFixed(8),
    side: "settle" as const,
    owner: args.owner,
    settleTarget: args.invoice,
    refundAddress: args.refundAddress,
    capabilities: LIGHTNING_V2_CAPABILITIES,
    signerClass: { arkade: "arkade-vhtlc" as const },
  };
}

type LightningQuoteRequest = ReturnType<typeof lightningQuoteRequest>;

/** The option a Lightning send commits: the first one whose required
 * capabilities this wallet has. Shared by the send and the prefetch so both
 * judge the same option. */
function selectLightningOption(quote: SwapKitV2QuoteResponse): SwapKitV2QuoteOption | undefined {
  return quote.options.find((candidate) =>
    candidate.requiredCapabilities.every((kind) =>
      (LIGHTNING_V2_CAPABILITIES as readonly string[]).includes(kind),
    ),
  );
}

/** Never reuse a prefetched quote past this age, whatever the server's own
 * validity says: the user is paying now, and an old price is not what they
 * reviewed. */
const PREFETCH_MAX_AGE_MS = 45_000;
/** Stop using a prefetched quote this long before the server stops standing
 * behind it, so the commit that follows cannot land after it expired. */
const PREFETCH_EXPIRY_MARGIN_MS = 15_000;

let prefetchedQuote: {
  key: string;
  quote: SwapKitV2QuoteResponse;
  usableUntilMs: number;
} | null = null;

function quoteRequestKey(request: LightningQuoteRequest): string {
  // Every field of the request, so a quote is only reused for the identical
  // payment: same invoice, amount, owner, refund address, capabilities, signer.
  return JSON.stringify(request);
}

function takePrefetchedLightningQuote(
  request: LightningQuoteRequest,
): SwapKitV2QuoteResponse | null {
  const held = prefetchedQuote;
  // Single use: whatever happens next, a later send quotes afresh.
  prefetchedQuote = null;
  if (!held || held.key !== quoteRequestKey(request)) return null;
  if (Date.now() >= held.usableUntilMs) return null;
  return held.quote;
}

/**
 * Fetch the corridor quote for an invoice while the user is still reviewing
 * the send, so pressing confirm does not wait on it. Moves no money, commits
 * nothing and signs nothing; a failure here is ignored and the send quotes
 * normally. The quote is only ever used for the identical request.
 */
export async function prefetchArkadeIntentsLightningQuote(params: {
  invoice: string;
  refundAddress: string;
}): Promise<void> {
  const invoice = String(params.invoice || "").trim();
  const refundAddress = String(params.refundAddress || "").trim();
  if (!invoice || !refundAddress || !isValidArkAddress(refundAddress)) return;
  const { amountSats: invoiceSats, expiresAt } = decodeBolt11Facts(invoice);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() / 1000 >= expiresAt) return;
  if (!isArkadeLightningAmountInRange(invoiceSats)) return;
  const owner = await getEthereumAddress();
  if (!owner) return;
  const request = lightningQuoteRequest({ invoice, invoiceSats, owner, refundAddress });
  const fetchedAtMs = Date.now();
  const quote = await quoteSwapKitV2(request);
  // The expiry that matters is the one of the option the send will pick, with
  // the same predicate the send uses. No stated validity on THAT option: do not
  // hold the quote at all.
  const option = selectLightningOption(quote);
  if (!option) return;
  const validUntilMs = Date.parse(String(option.validUntil ?? ""));
  if (!Number.isFinite(validUntilMs)) return;
  prefetchedQuote = {
    key: quoteRequestKey(request),
    quote,
    usableUntilMs: Math.min(
      fetchedAtMs + PREFETCH_MAX_AGE_MS,
      validUntilMs - PREFETCH_EXPIRY_MARGIN_MS,
    ),
  };
}

/** Drop any held quote (logout, send screen closed). */
export function clearPrefetchedArkadeIntentsLightningQuote(): void {
  prefetchedQuote = null;
}

/**
 * Quote and create the corridor swap. Moves no money: the caller funds
 * `lockupAddress` with `fundAmountSats` under its own approval.
 *
 * `senderPublicKey` and `refundAddress` are bound into the lockup covenant, so
 * neither may be defaulted server-side and both travel on the create.
 */
export async function createArkadeIntentsLightningSend(params: {
  invoice: string;
  senderPublicKey: string;
  refundAddress: string;
  fromAddress?: string;
  simulate?: boolean;
}): Promise<ArkadeIntentsLightningSend> {
  const invoice = String(params.invoice || "").trim();
  const senderPublicKey = String(params.senderPublicKey || "").trim();
  const refundAddress = String(params.refundAddress || "").trim();
  if (!invoice) throw new Error("lightning invoice required");
  if (!senderPublicKey) throw new Error("lightning send refund key required");
  if (!refundAddress || !isValidArkAddress(refundAddress)) {
    throw new Error("lightning send refund address required");
  }

  const { amountSats: invoiceSats, expiresAt } = decodeBolt11Facts(invoice);
  // An expired invoice cannot be settled by anyone, and this rail funds a
  // lockup before the solver ever tries: paying one buys a refund to wait out
  // rather than a payment. The screen refuses it too — this is the boundary
  // that holds for a caller that is not the screen.
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() / 1000 >= expiresAt) {
    throw new Error("lightning invoice has expired");
  }
  if (!isArkadeLightningAmountInRange(invoiceSats)) {
    throw new Error(
      `lightning invoice amount must be between ${ARKADE_LIGHTNING_MIN_SEND_SATS} and ${ARKADE_LIGHTNING_MAX_SEND_SATS} sats`,
    );
  }

  const owner = await getEthereumAddress();
  if (!owner) throw new Error("Wallet owner is unavailable.");
  const request = lightningQuoteRequest({ invoice, invoiceSats, owner, refundAddress });
  // A quote fetched for this exact request while the user was still on the
  // review screen is used once, if the server still stands behind it; anything
  // else is quoted now. Every check below runs on it exactly as on a fresh one.
  const quote = takePrefetchedLightningQuote(request) ?? (await quoteSwapKitV2(request));
  const option = selectLightningOption(quote);
  if (!option) throw new Error("No Lightning route is available.");
  if (Number(option.settleAmount).toFixed(8) !== request.amount)
    throw new Error("SwapKit settle amount does not match the invoice.");
  const recoveryKey = await getSwapKitV2RecoveryKey();
  const idempotencyKey = `expo:lightning:${owner}:${decodeBolt11Facts(invoice).paymentHash}`;
  await persistV2CommitIntent({
    ...request,
    idempotencyKey,
    recoveryKey,
    flow: "arkade_lightning",
    acceptedDeposit: option.depositAmount,
    acceptedDepositAmount: option.depositAmount,
    minimumSettleAmount: request.amount,
  });
  // Nothing is signed before the reply names the order, so a failed or lost
  // reply is a plain failure: drop the intent and let the user pay again (the
  // same invoice re-sends the same key, which returns an order the server did
  // create).
  let view = await commitSwapKitV2({
    ...request,
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    idempotencyKey,
    recoveryKey,
    acceptedDepositAmount: option.depositAmount,
    minimumSettleAmount: request.amount,
  }).catch(async (error: unknown) => {
    await abandonV2CommitIntent(idempotencyKey).catch(() => {});
    throw error;
  });
  const orderId = asSwapKitV2OrderId(view.orderId);
  await resolveV2CommitIntent(idempotencyKey, orderId, view.status);
  if (!claimSwapLoop(orderId)) throw new Error("This Lightning payment is already in progress.");
  try {
    if (view.actions.length === 1 && view.actions[0].kind === "arkade_refund_material") {
      view = await executeAndSubmitV2Action(orderId, view.actions[0], {
        recoveryKey,
        executors: {
          arkade_refund_material: async (request) => {
            if (request.scope !== orderId) throw new Error("Refund material scope mismatch.");
            return { senderPublicKey, walletKeyRef: `nuri-arkade-intents-v1:${orderId}` };
          },
        },
      });
    }
    const fundingAction = view.actions[0];
    if (
      view.actions.length !== 1 ||
      fundingAction?.kind !== "arkade_intents_fund" ||
      fundingAction.state !== "ready"
    ) {
      throw new Error("Lightning order has no ready funding action.");
    }
    const recovery = view.publicRecovery as Record<string, unknown> | undefined;
    const lockupAddress = String(fundingAction.request.to || "");
    const fundAmountSats = Number(fundingAction.request.amountSats);
    const refundLocktime = Number(recovery?.refundLocktime);
    if (
      !isValidArkAddress(lockupAddress) ||
      fundingAction.request.asset !== FROM_ASSET ||
      !Number.isSafeInteger(fundAmountSats) ||
      fundAmountSats < invoiceSats ||
      fundAmountSats > Math.round(Number(option.depositAmount) * 1e8) ||
      recovery?.lockupAddress !== lockupAddress ||
      recovery?.destinationAddress !== refundAddress ||
      recovery?.senderPublicKey !== senderPublicKey ||
      Number(recovery?.amountSats) !== fundAmountSats ||
      !recovery?.rfqId ||
      !Number.isSafeInteger(refundLocktime) ||
      refundLocktime <= 0
    ) {
      throw new Error("Lightning funding action does not match the accepted lockup.");
    }
    return {
      txId: orderId,
      rfqId: String(recovery.rfqId),
      refundLocktime,
      lockupAddress,
      fundAmountSats,
      invoiceSats,
      fundingAction,
      recoveryKey,
      view,
    };
  } catch (error) {
    releaseSwapLoop(orderId);
    if (isProviderRefusal(error, view)) {
      await retireRefusedLightningOrder(orderId, recoveryKey);
    }
    throw error;
  }
}

/** The solver said no to this order (thrown, or stated on its view). */
function isProviderRefusal(error: unknown, view: SwapKitV2OrderView): boolean {
  if (error instanceof SwapKitV2Error && error.code === "provider_refused") return true;
  const failure = view.failure;
  return [error instanceof Error ? error.message : String(error), failure?.code, failure?.message]
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .some((text) => text === "provider_refused" || classifyErrorCode(text) === "provider_refused");
}

/**
 * A refused Lightning order was never funded here: its funding action is only
 * returned to the caller, never run, and the refund material it holds is public
 * key data, not a funding effect. Ask the server to cancel it (the server
 * refuses an order that moved funds) and drop it from this device only when it
 * confirms a terminal, non-completed state, so nothing resumes or reserves it.
 */
async function retireRefusedLightningOrder(orderId: string, recoveryKey: string): Promise<void> {
  const cancelled = await cancelSwapKitV2Order(asSwapKitV2OrderId(orderId), {
    recoveryKey,
  }).catch((): null => null);
  if (
    cancelled &&
    isSwapKitV2Terminal(cancelled) &&
    String(cancelled.status).toUpperCase() !== "COMPLETED"
  ) {
    await SwapKitV2OrderStore.remove(orderId).catch(() => {});
  }
}

/**
 * What the route says it will settle, checked against the locally decoded
 * invoice rather than trusted.
 *
 * These two disagreeing means the route is quoting a different payment than the
 * one the user scanned — and the difference leaves the wallet either way.
 */
export function assertLightningSettleAmount(
  swap: { [key: string]: unknown },
  invoiceSats: number,
): void {
  const settleAmountSats = Math.trunc(
    Number((swap as unknown as Record<string, unknown>).settleAmountSats),
  );
  if (
    Number.isFinite(settleAmountSats) &&
    settleAmountSats > 0 &&
    settleAmountSats !== invoiceSats
  ) {
    throw new Error("SwapKit settle amount does not match the invoice.");
  }
}
