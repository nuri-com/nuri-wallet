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
// The commit response's bound actions ARE the execution: the server binds the
// BTC_LN → BTC leg and hands back the funding Lightning invoice; nothing is
// reconstructed client-side, and no send_asset executor is installed, so the
// only money that can move is paying the bound invoice.
import { isValidBitcoinAddressMainnet } from "../../lib/bitcoin/address";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { t } from "../../lib/i18n";
import { isValidEvmAddress } from "../../lib/validation";
import { getBitcoinReceiveAddress } from "../bitcoin/BitcoinAddressService";
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
}): Promise<{ options: V2ArkadeToBtcQuote[]; unavailable: V2ArkadeToBtcUnavailable[] }> {
  const owner = args.owner.trim();
  if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
  const toAddress = args.toAddress.trim();
  if (!isValidBitcoinAddressMainnet(toAddress))
    throw new Error("Recipient Bitcoin address is invalid.");
  if (!Number.isSafeInteger(args.sats) || args.sats <= 0)
    throw new Error("Enter a positive Bitcoin amount.");
  // Refund: THIS wallet's own Arkade boarding address (a Bitcoin address, as a
  // Lightning-funded order requires), never a server-named one — a refund lands
  // back in Arkade.
  const refundAddress = args.refundAddress ?? (await getBitcoinReceiveAddress());
  const amountBtc = args.sats / 100_000_000;
  const response: SwapKitV2QuoteResponse = await quoteSwapKitV2({
    from: FROM_ASSET,
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
  onStatus?: (text: string) => void;
  onOrderId?: (orderId: string) => void;
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
    const refundAddress = args.refundAddress ?? (await getBitcoinReceiveAddress());
    const amountBtc = args.sats / 100_000_000;

    args.onStatus?.(t("swap.status.exchanging"));

    const { orderId } = await commitAndTrackV2Order({
      flow: "arkade_to_btc",
      owner,
      from: FROM_ASSET,
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
      // Standard executors WITHOUT send_asset: the only bound action is the
      // Lightning funding invoice, paid from arkade. There is no EVM leg to
      // cap, so no approval ceiling is needed.
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
      // never draw an "arriving" row.
      own: await ownBitcoinDestinations(),
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
  const { options } = await quoteV2ArkadeToBtc({
    toAddress: args.toAddress,
    sats: args.sats,
    owner: args.owner,
  });
  const option = options[0];
  if (!option) throw new Error("No Lightning route to Bitcoin is available.");
  return executeV2ArkadeToBtc({
    toAddress: args.toAddress,
    sats: args.sats,
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    quotedReceive: option.settleAmount,
    owner: args.owner,
    ...(args.onStatus ? { onStatus: args.onStatus } : {}),
    ...(args.onOrderId ? { onOrderId: args.onOrderId } : {}),
  });
}
