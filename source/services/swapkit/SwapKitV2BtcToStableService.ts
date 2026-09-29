// BTC / BTC_ARKADE → Base stable over SwapKit v2 — the single v2 engine behind
// the btc→stable move into the wallet or the card (the only difference is
// settleTarget: the user's own EOA vs the Wirex smart account).
//
// Replaces the v1 SwapKitCardTopupService + ArkadeIntentsStableSwapService
// paths. The commit response's bound actions ARE the execution: the server
// binds a BTC deposit (on-chain rail) or drives an Arkade VHTLC (arkade rail),
// then the USDC→stable settle leg — nothing is reconstructed client-side.
//
// CORRIDOR SEPARATION (hard rule): `from` is exactly one of BTC or BTC_ARKADE
// — different wallets, different addresses, different balances — and `to` is
// exactly the stable named. One rail's route, balance or availability never
// implies another's. This service never falls one rail through to the other.
import { isValidBitcoinAddressMainnet } from "../../lib/bitcoin/address";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { t } from "../../lib/i18n";
import { isValidEvmAddress } from "../../lib/validation";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import {
  getBitcoinOnchainSendAddress,
  getBitcoinReceiveAddress,
} from "../bitcoin/BitcoinAddressService";
import { wirexService } from "../wirex/WirexService";
// Static import for the same reason as SwapContract/SwapKitCardTopupService: the
// web export is one bundle, so an async require has no chunk to resolve and the
// on-chain funding leg would throw "Requiring unknown module" on the PWA.
import { sendBitcoinOnchainFromMusig2 } from "../bitcoin/OnchainSendService";
import {
  type SwapKitV2SignerClass,
  SWAPKIT_V2_ACTION_KINDS,
  type SwapKitV2QuoteOption,
  type SwapKitV2QuoteResponse,
  quoteSwapKitV2,
} from "./SwapKitV2Service";
import { makeStandardV2Executors, makeV2SendAsset } from "./SwapKitV2Executors";
import type { SwapKitV2Executors } from "./SwapKitV2ActionService";
import { commitAndTrackV2Order } from "./SwapKitV2CommitFlow";
import {
  BTC_ARKADE_ASSET,
  BTC_ONCHAIN_ASSET,
  baseStableToken,
  stableFiatCode,
  type BaseStableAssetId,
} from "./SwapKitStableAssets";

const SOURCE = "services/swapkit/SwapKitV2BtcToStableService.ts";
void SOURCE;

/** The two Bitcoin rails this engine serves, kept strictly apart. */
export type BtcRail = "BTC" | "BTC_ARKADE";

/** Where the settled stable lands. "wallet" = the user's own EOA; "card" =
 * the Wirex smart account. The signer is ALWAYS the EOA either way. */
export type BtcToStableDestination = "wallet" | "card";

/** Which local Bitcoin wallet pays the on-chain BTC deposit (BTC rail only):
 * "arkade" offboards a VHTLC to the deposit address; "onchain" pays via MuSig2.
 * Irrelevant to the BTC_ARKADE rail, which funds its VHTLC through arkade_send. */
export type BtcSendSource = "arkade" | "onchain";

/** Standard order-flow capabilities PLUS send_asset — the on-chain BTC rail
 * funds a server-named deposit address, which only this flow is allowed to do. */
// No sign_typed_data: a BTC-source order has no EVM spend a signature could be
// bound to, so the wallet does not offer one (an option needing it is priced
// out as missing_capability rather than signed unbound).
// Nor execute_evm_call: no BTC→stable order can reconstruct an exact EVM
// route, and an unbound raw call is refused rather than signed. Every live
// corridor funds with send_asset, pay_lightning_invoice or Arkade Intents.
const BTC_TO_STABLE_CAPABILITIES = SWAPKIT_V2_ACTION_KINDS.filter(
  (kind) => kind !== "sign_typed_data" && kind !== "execute_evm_call",
);

export type V2BtcToStableQuote = {
  optionId: string;
  /** Server quoteId of the accepted option; sent back verbatim on commit. */
  quoteId?: string;
  from: BtcRail;
  to: string;
  /** Sats the user spends (the BTC side is bound in sats, canonical rule). */
  sats: number;
  /** Stable-side settle, decimal. */
  settleAmount: number;
  requiredCapabilities: string[];
  etaSeconds?: number;
  limits: SwapKitV2QuoteOption["limits"];
  provider: string | null;
  /** Hub USDC the route delivers to the EOA before the stable settle leg — the
   * approval cap for that leg. Null when the option carries no such leg. */
  expectedUsdc: number | null;
};

export type V2BtcToStableUnavailable = { provider?: string; reason?: string };

/** The refund address for a Bitcoin rail — the wallet's OWN address on that
 * rail, never a server-named one. Exported so the quote binds the exact same
 * refund the commit will use (quoting one address and committing another is two
 * different bound requests). Returns null when the address can't be resolved. */
export async function btcRailRefundAddress(
  rail: BtcRail,
  sendSource: BtcSendSource = "arkade",
): Promise<string | null> {
  try {
    if (rail === BTC_ARKADE_ASSET) {
      const addr = await getArkadeReceiveAddress();
      return addr ? String(addr) : null;
    }
    // An on-chain BTC deposit funded from the MuSig2 wallet must declare that
    // wallet's own send address — the one holding the UTXOs. LI.FI's BTC-source
    // rail builds the deposit from the declared address, and the boarding/
    // receive address is empty by design ("No UTXOs found for any sender
    // addresses"). No fallback: while the on-chain wallet is unavailable,
    // declaring another address would fund from one and declare another.
    if (sendSource === "onchain") {
      const addr = getBitcoinOnchainSendAddress();
      return addr && isValidBitcoinAddressMainnet(addr) ? addr : null;
    }
    const addr = await getBitcoinReceiveAddress();
    return addr && isValidBitcoinAddressMainnet(addr) ? addr : null;
  } catch {
    return null;
  }
}

function toV2Quote(option: SwapKitV2QuoteOption, rail: BtcRail): V2BtcToStableQuote {
  const depositBtc = Number(option.depositAmount);
  return {
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    from: rail,
    to: option.to,
    sats: Math.round(depositBtc * 100_000_000),
    settleAmount: Number(option.settleAmount),
    requiredCapabilities: option.requiredCapabilities ?? [],
    ...(option.expectedSettlement?.p50Seconds
      ? { etaSeconds: Number(option.expectedSettlement.p50Seconds) }
      : {}),
    limits: option.limits ?? null,
    provider: option.optionId.split(":")[0] || null,
    expectedUsdc: deriveExpectedUsdc(option),
  };
}

// The intermediate USDC leg amount, when the option exposes one. Only a real
// USDC_BASE leg figure is a valid approval cap — the settle amount is the final
// stable and must never be reused as a USDC bound.
function deriveExpectedUsdc(option: SwapKitV2QuoteOption): number | null {
  const legs = (option as { legs?: Array<Record<string, unknown>> }).legs ?? [];
  for (const leg of legs) {
    const to = String(leg.to ?? leg.asset ?? "").toUpperCase();
    const amount = Number(leg.settleAmount ?? leg.amount);
    if (to === "USDC_BASE" && Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

/**
 * Quote ONE rail → ONE stable. The rail is passed explicitly and never
 * inferred; the caller quotes each rail it wants and presents them side by
 * side. The server prices only options this wallet's capabilities can finish.
 */
/**
 * Who signs this order's actions. The Arkade rail funds from Arkade, so it
 * declares the Arkade signer next to the EVM one that settles; the on-chain
 * rail stays EVM-only. Quote and commit send the SAME value.
 */
export function btcToStableSignerClass(rail: BtcRail): SwapKitV2SignerClass {
  return rail === "BTC_ARKADE" ? { evm: "eoa", arkade: "arkade-vhtlc" } : { evm: "eoa" };
}

export async function quoteV2BtcToStable(args: {
  rail: BtcRail;
  toStable: BaseStableAssetId;
  sats: number;
  owner: string;
  settleTarget: string;
  refundAddress: string;
}): Promise<{ options: V2BtcToStableQuote[]; unavailable: V2BtcToStableUnavailable[] }> {
  const owner = args.owner.trim();
  if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
  const settleTarget = args.settleTarget.trim();
  if (!settleTarget) throw new Error("Settle destination is missing.");
  const to = baseStableToken(args.toStable).asset;
  const amountBtc = args.sats / 100_000_000;
  const response: SwapKitV2QuoteResponse = await quoteSwapKitV2({
    from: args.rail,
    to,
    amount: String(amountBtc),
    side: "deposit",
    owner,
    settleTarget,
    refundAddress: args.refundAddress,
    capabilities: BTC_TO_STABLE_CAPABILITIES,
    signerClass: btcToStableSignerClass(args.rail),
  });
  return {
    options: (response.options ?? []).map((option) => toV2Quote(option, args.rail)),
    unavailable: (response.unavailable ?? []).map((entry) => ({
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
  };
}

export type ExecuteV2BtcToStableArgs = {
  rail: BtcRail;
  toStable: BaseStableAssetId;
  sats: number;
  /** The amount the quote was requested for; the commit repeats it verbatim. */
  requestedSats?: number;
  /** The exact option the user accepted. */
  optionId: string;
  /** Server quoteId of the accepted option; sent back verbatim on commit. */
  quoteId?: string;
  /** The stable figure the accepted quote stated, in the stable's own unit. */
  quotedReceiveStable: number;
  /** The hub-USDC bound the accepted option carried — the approval cap for a
   * wallet-signed EVM settle leg. Null for options with no such leg (pure
   * send_asset offboard, or pay_lightning_invoice): those have no EVM approval
   * to cap. Never a presence requirement — every server-priced option is run. */
  expectedUsdc?: number | null;
  owner: string;
  settleTarget: string;
  destination: BtcToStableDestination;
  /** BTC rail only: which local wallet pays the on-chain deposit. */
  sendSource?: BtcSendSource;
  onStatus?: (text: string) => void;
  onOrderId?: (orderId: string) => void;
};

/**
 * Commit the accepted option and drive its action loop. The BTC rail adds a
 * bounded send_asset funder (validates the bound deposit address + exact sats
 * before moving); the arkade rail funds its VHTLC through the standard
 * arkade_send. The USDC→stable settle leg's approval is capped at the accepted
 * hub-USDC amount.
 */
export async function executeV2BtcToStable(
  args: ExecuteV2BtcToStableArgs,
): Promise<{ orderId: string }> {
  const op = newOp("SwapKitV2BtcToStable", "executeV2BtcToStable", LOG_EMOJI.bitcoin);
  try {
    const owner = args.owner.trim();
    if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
    const settleTarget = args.settleTarget.trim();
    if (!settleTarget) throw new Error("Settle destination is missing.");
    if (!args.optionId) throw new Error("The accepted option is missing.");
    if (!Number.isFinite(args.quotedReceiveStable) || args.quotedReceiveStable <= 0) {
      throw new Error("The accepted quote is missing.");
    }
    if (!Number.isSafeInteger(args.sats) || args.sats <= 0) {
      throw new Error("Enter a positive Bitcoin amount.");
    }
    const stable = baseStableToken(args.toStable);
    const to = stable.asset;
    const amountBtc = args.sats / 100_000_000;

    // Refund goes to THIS wallet's own rail, never a server-named address:
    // the arkade rail refunds to our Ark address; the on-chain BTC rail to our
    // own Bitcoin receive address.
    // Same resolution the quote used, so quote and commit bind one address.
    const refundAddress = await btcRailRefundAddress(args.rail, args.sendSource ?? "arkade");
    if (args.rail === BTC_ONCHAIN_ASSET && !refundAddress) {
      throw new Error(
        args.sendSource === "onchain"
          ? "On-chain wallet is not ready yet — try again in a moment."
          : "Bitcoin refund address is missing or invalid.",
      );
    }

    args.onStatus?.(t("swap.status.exchanging"));

    const { orderId } = await commitAndTrackV2Order({
      flow: "btc_to_stable",
      signerClass: btcToStableSignerClass(args.rail),
      owner,
      from: args.rail,
      to,
      // The request the quote was made for, never the option's deposit: the
      // server only commits a quote for the same request it priced.
      amount: String((args.requestedSats ?? args.sats) / 100_000_000),
      side: "deposit",
      settleTarget,
      refundAddress,
      acceptedDeposit: String(args.sats),
      // Immutable consent bounds: the user accepted sending `sats` (as decimal
      // BTC) to receive at least `quotedReceiveStable`. The server binds these
      // and never overwrites them with a later execution value.
      acceptedDepositAmount: String(amountBtc),
      minimumSettleAmount: String(args.quotedReceiveStable),
      capabilities: BTC_TO_STABLE_CAPABILITIES,
      optionId: args.optionId,
      ...(args.quoteId ? { quoteId: args.quoteId } : {}),
      destination: args.destination,
      executorSpec: {
        flow: "btc_to_stable",
        rail: args.rail,
        sats: args.sats,
        expectedUsdc: args.expectedUsdc ?? null,
        sendSource: args.sendSource ?? null,
      },
      loopOptions: { executors: buildExecutors(args, stable) },
      onOrderId: args.onOrderId,
      // The BTC SOURCE rail (arkade/onchain) has no transfer store, so give the
      // move store the sats it spends to render the outgoing leg.
      moveAmounts: { sendAmount: args.sats, receiveAmount: args.quotedReceiveStable },
      // A card-destination swap settles to the Wirex account, and the pocket it
      // credits is its own screen — not the wallet of the same currency.
      own: { evm: owner, card: args.destination === "card" ? settleTarget : null },
      ...(args.destination === "card"
        ? { cardPocket: stableFiatCode(stable) === "USD" ? ("USD" as const) : ("EUR" as const) }
        : {}),
      // Card top-ups settle to the Wirex account, so only wallet-settled moves
      // add a wallet destination row.
      pendingRow: (id) =>
        args.destination === "wallet"
          ? {
              event: "wallet:pendingTransfer",
              payload: {
                amountFiat: args.quotedReceiveStable,
                fiat: stableFiatCode(stable),
                txHash: null,
                orderId: id,
                source: "swapkit_topup",
                createdAt: new Date().toISOString(),
              },
            }
          : null,
    });

    op.log("v2 btc→stable committed", { orderId: `${orderId}`, rail: args.rail, to });
    op.end("Executed");
    return { orderId };
  } catch (e) {
    op.error("execute failed", e instanceof Error ? e.message : String(e));
    op.end("ERR");
    throw e;
  }
}

/** The executor set for this rail: the arkade rail uses the standard set (its
 * VHTLC funds through arkade_send, or a Lightning invoice via
 * pay_lightning_invoice); the on-chain BTC rail adds a bounded send_asset
 * funder. The USDC→stable approval cap applies ONLY when the accepted option
 * carried a hub-USDC leg — a pure send_asset offboard or a Lightning route has
 * no wallet-signed EVM leg to cap, so no ceiling is imposed there. */
function buildExecutors(
  args: ExecuteV2BtcToStableArgs,
  stable: ReturnType<typeof baseStableToken>,
) {
  void stable;
  return buildBtcToStableExecutorsFromSpec({
    rail: args.rail,
    sats: args.sats,
    expectedUsdc: args.expectedUsdc ?? null,
    sendSource: args.sendSource ?? null,
  });
}

/** Spec-driven executor build shared by the live call and the resume path. Both
 * derive the SAME bounded funder + approval ceiling from the persisted inputs,
 * so a resumed on-chain-BTC order keeps its send_asset funder instead of
 * falling back to the standard set (P1: resume rebuild). */
export function buildBtcToStableExecutorsFromSpec(spec: {
  rail: string;
  sats?: number | null;
  expectedUsdc?: number | null;
  sendSource?: "arkade" | "onchain" | null;
}): SwapKitV2Executors {
  // No EVM authority: nothing here can bind a raw call to an exact route, so
  // the set carries none (see BTC_TO_STABLE_CAPABILITIES). `expectedUsdc`
  // stays in the persisted spec for older rows; it no longer arms anything.
  void spec.expectedUsdc;
  const executors = makeStandardV2Executors({});
  if (spec.rail === BTC_ONCHAIN_ASSET) {
    // An on-chain deposit is paid by the on-chain wallet, never by moving
    // Arkade sats on-chain first. An order that names Arkade here was made by
    // a build that still offered that detour: it gets no funder, so a ready
    // funding action fails closed instead of moving money that way.
    if (spec.sendSource !== "onchain") return executors;
    const boundSats = Number(spec.sats);
    if (!Number.isFinite(boundSats) || boundSats <= 0) {
      // Without a bound sats ceiling the funder cannot be safely reconstructed;
      // leave send_asset unset so a still-ready funding action fails closed
      // rather than moving an unbounded amount.
      return executors;
    }
    executors.send_asset = makeV2SendAsset({
      expectedAsset: BTC_ONCHAIN_ASSET,
      boundSats,
      validateDestination: (address) => isValidBitcoinAddressMainnet(address),
      // The MuSig2 wallet pays the exact sats. STARTED is marked at its own
      // broadcast point: after the passkey approval, immediately before funds
      // leave. Marking earlier stranded a cancelled approval; not marking at
      // all let a crash after broadcast fund the deposit twice on resume.
      fund: async (address, sats, onBeforeBroadcast) => {
        // Awaited by the send service before it broadcasts: the STARTED
        // marker is durable before the transaction can be on the wire. (The
        // display-only onStatus callback was fired-and-forgotten, leaving a
        // crash window between broadcast and the marker write.)
        const payment = await sendBitcoinOnchainFromMusig2({
          toAddress: address,
          amountSats: sats,
          onBeforeBroadcast,
        });
        return String(payment.txid || "");
      },
    });
  }
  return executors;
}

// ── Card destination ─────────────────────────────────────────────────
//
// The card is the SAME v2 corridor as the wallet-settled move, differing only
// in settleTarget: the Wirex smart account (AA), signer stays the EOA. The move
// sheet prices and executes it through SwapContract's btc-to-stable engine,
// which resolves the account here once and binds it into quote and commit.

/** The two Base stables the Wirex account can settle into (EURC → its euros,
 * USDC → its dollars). Funding it with anything else settles a token it cannot
 * spend, so the pairing is refused rather than silently sent. */
const CARD_STABLE_ASSETS = new Set<BaseStableAssetId>(["EURC_BASE", "USDC_BASE"]);

export async function resolveCardSettleTarget(
  destination: "card" | "wallet",
  owner: string,
  toStable: BaseStableAssetId,
): Promise<string> {
  if (destination === "wallet") return owner;
  if (!CARD_STABLE_ASSETS.has(toStable)) {
    throw new Error(`The card cannot be topped up in ${baseStableToken(toStable).symbol}.`);
  }
  const wallet = await wirexService.getWallet(owner);
  const settleTarget = String(wallet.walletAddress || "").trim();
  if (!settleTarget) throw new Error("Card account is not ready yet.");
  return settleTarget;
}
