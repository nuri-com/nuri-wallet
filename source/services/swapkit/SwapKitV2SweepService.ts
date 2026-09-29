// "Bring everything back to my wallet" over SwapKit v2 (#277 companion
// workflow): the server scans off-Base balances and refundable HTLC locks with
// the SAME shared v1 scanner modules, prices each balance as an ordinary v2
// quote, and on confirm creates ordinary bound v2 orders (gas sponsored). The
// wallet's job shrinks to: drive each returned order's action stream.
//
// The v1 fundSweepConvert path is NEVER called for v2 orders — the deposit
// arrives as a bound send_asset action and is executed by the sweep-bounded
// executor set below (exact token, exact amount, ceilinged by the scan).

import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { startSwapInFlight } from "../money/announce";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { sendTokenOnBase } from "../base/BaseTokenTransferService";
import { BASE_CHAIN_ID } from "../../config/network";
import { EURC_BASE_TOKEN, USDC_BASE_TOKEN } from "./SwapKitStableAssets";
import { SWAPKIT_SWEEP_CHAIN_IDS } from "./SwapKitEvmSigner";
import { isSignableChain, resolveCanonicalToken, type RegistryToken } from "./SwapKitTokenRegistry";
import { sendErc20OnChain as sendSweepErc20OnChain } from "./SwapKitSweepService";
import {
  isTrustedSatoraCoordinator,
  parseRefundableLocks,
  executeSatoraRefund,
  type SatoraRefundableLock,
} from "./SatoraHtlcRefundService";
import {
  type SwapKitV2OrderView,
  asSwapKitV2OrderId,
  isSwapKitV2Terminal,
  sweepSwapKitV2,
} from "./SwapKitV2Service";
import type { SwapKitV2ActionContext, SwapKitV2Executors } from "./SwapKitV2ActionService";
import { makeStandardV2Executors } from "./SwapKitV2Executors";
import { formatUnits } from "viem";
import { decimalUnits } from "./SwapKitV2ApprovalBounds";
import { settleBindingForOrder, type SwapKitV2SettleBinding } from "./SwapKitV2EvmRouteBinding";
import { emitV2SwapRefresh, startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";
import { noteV2MoveCommitted } from "./SwapKitV2MoveStatus";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";

declare const __DEV__: boolean | undefined;

const BASE_CURRENCY_KEY = "swapkit:base-currency:v1";
const LAST_CHECK_KEY = "swapkit:sweep-last-check:v1";
const CHECK_INTERVAL_MS =
  typeof __DEV__ !== "undefined" && __DEV__ === true ? 60 * 1000 : 15 * 60 * 1000;
const MIN_USD = 1;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const CLAIMABLE_SWEEP_CHAIN_IDS = SWAPKIT_SWEEP_CHAIN_IDS.filter(isSignableChain);

/** The v2 kinds a sweep flow can fulfil — send_asset IS included here (unlike
 * normal flows): the sweep's deposit is the wallet moving its OWN detected
 * balance to the order's bound address, bounded below. */
// The sweep offers every kind its providers use: deposit routes (1Click,
// bitcoinvn, FixedFloat) via send_asset, LI.FI via execute_evm_call.
const SWEEP_CAPABILITIES = ["send_asset", "execute_evm_call", "sign_typed_data"] as const;

export type SwapKitBaseCurrency = "EURC_BASE" | "USDC_BASE";

export async function getSwapKitBaseCurrency(): Promise<SwapKitBaseCurrency> {
  try {
    const stored = await getCacheValue<string>(BASE_CURRENCY_KEY);
    if (stored === "USDC_BASE") return "USDC_BASE";
  } catch {}
  return "EURC_BASE";
}

// ── v2 sweep item shape (engine/sweep.mjs) ──────────────────────────

export type SwapKitV2SweepItem = {
  asset?: string;
  chainId?: number;
  address?: string;
  /** Display decimal. Never a money bound — see `amountRaw`. */
  amount?: number | string;
  /** The exact on-chain balance the server scanned (src/amounts.mjs tokenAmount). */
  amountRaw?: { asset?: string; decimals?: number; units?: string };
  usd?: number | string;
  symbol?: string;
  source?: Record<string, unknown>;
  signable?: boolean;
  quote?: unknown;
  gas?: { ready?: boolean; [key: string]: unknown };
  reservations?: unknown[];
  readyToConfirm?: boolean;
  /** confirm:true — the ordinary v2 order created for this balance. */
  order?: SwapKitV2OrderView;
  gasSponsorship?: unknown[];
  error?: string;
  [key: string]: unknown;
};

export type SwapKitV2SweepResult = {
  mode?: string;
  fromAddress?: string;
  confirmed?: boolean;
  found?: number;
  sweepable?: number;
  totalUsd?: number | string;
  items?: SwapKitV2SweepItem[];
  refundable?: unknown;
  refundableReady?: number;
  userMessage?: string;
  [key: string]: unknown;
};

export type SwapKitClaimOutcome = {
  /** Conversions handed to the v2 tracker — order created and loop armed. */
  started: number;
  /** Balances this app refused on a verdict that will not change by itself. */
  refusedLocally: number;
  /** Balances that neither started nor were refused (server error, ambiguity). */
  unresolved: number;
  /** Refundable stuck HTLC locks recovered (confirmed receipts). */
  refunded: number;
};

// ── Scan ────────────────────────────────────────────────────────────

/** The unthrottled read-only scan — diagnostics use it directly. */
export async function scanSwapKitSweep(): Promise<SwapKitV2SweepResult> {
  const wallet = await getEthereumAddress();
  if (!wallet) throw new Error("Ethereum wallet address is missing.");
  return sweepSwapKitV2({
    wallet,
    baseCurrency: await getSwapKitBaseCurrency(),
    confirm: false,
    minUsd: MIN_USD,
    signableChains: CLAIMABLE_SWEEP_CHAIN_IDS,
    capabilities: SWEEP_CAPABILITIES,
    signerClass: { evm: "eoa" },
  }) as Promise<SwapKitV2SweepResult>;
}

/** Why this app cannot carry a scanned balance home, or null when it can.
 * v2 already gates server-side (signable chains, live balance, reservations,
 * gas); what remains local is token identity — the scanned contract must BE
 * the canonical token whose decimals bound the approval ceiling. */
/** The two Base balances the wallet holds itself and the board already states.
 * Everything else on Base is route residue: money stranded mid-swap that the
 * user has no other way to reach, so it must be claimable. */
function isOwnBaseStable(item: SwapKitV2SweepItem): boolean {
  const address = String(item.address || "").toLowerCase();
  return (
    address === EURC_BASE_TOKEN.token.toLowerCase() ||
    address === USDC_BASE_TOKEN.token.toLowerCase()
  );
}

export async function scanClaimBlocker(item: SwapKitV2SweepItem): Promise<string | null> {
  if (item.error) return String(item.error);
  if (item.signable === false) return "chain is not signable by this app";
  const chainId = Number(item.chainId);
  if (!Number.isFinite(chainId) || !CLAIMABLE_SWEEP_CHAIN_IDS.includes(chainId)) {
    return `chain ${item.chainId ?? "?"} is not claimable`;
  }
  // Base holds the wallet's OWN balances (EURC/USDC), which the board already
  // states — they are not a find. Every OTHER Base token is route residue the
  // user cannot otherwise reach, so rejecting the whole chain hid it. Judge the
  // contract, not the chain.
  if (chainId === BASE_CHAIN_ID && isOwnBaseStable(item)) {
    return "on Base — a held balance, not a find";
  }
  const token = await canonicalSweepToken(item);
  if (!token) {
    return `no local transfer path for ${assetLabel(item)} (${String(item.address || "no contract")})`;
  }
  if (sweepItemUnits(item, token) === null) return "scan reported no exact detected balance";
  if (item.readyToConfirm === false) {
    return item.gas?.ready === false ? "gas sponsorship is not ready" : "balance is reserved";
  }
  return null;
}

/** Read-only detection for the claim screen (throttled; force skips it). */
export async function checkSwapKitSweep(options?: {
  force?: boolean;
}): Promise<SwapKitV2SweepResult | null> {
  try {
    if (!options?.force) {
      const last = Number((await getCacheValue<number>(LAST_CHECK_KEY)) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return null;
    }
    const wallet = await getEthereumAddress();
    if (!wallet) return null;
    const result = await scanSwapKitSweep();
    await setCacheValue(LAST_CHECK_KEY, Date.now());

    const verdicts = await Promise.all(
      (result.items ?? []).map(async (item) => ({ item, blocker: await scanClaimBlocker(item) })),
    );
    for (const { item, blocker } of verdicts) {
      if (blocker) console.log(`[SwapKitV2Sweep] not announcing ${assetLabel(item)}: ${blocker}`);
    }
    const claimable = verdicts.filter((v) => !v.blocker).map((v) => v.item);
    const totalUsd = claimable.reduce((sum, item) => {
      const usd = Number(item.usd);
      return sum + (Number.isFinite(usd) ? usd : 0);
    }, 0);
    const refundableReady = parseRefundableLocks(result.refundable).filter((r) => {
      if (!r.refundable) return false;
      if (!isTrustedSatoraCoordinator(r.chainId, r.coordinatorAddress)) {
        console.log(
          `[SwapKitV2Sweep] not announcing refundable lock ${r.preimageHash.slice(0, 12)}…: coordinator ${r.coordinatorAddress} on chain ${r.chainId} is not an allowlisted Satora deployment`,
        );
        return false;
      }
      return true;
    });
    console.log(
      `[SwapKitV2Sweep] wallet=${wallet} found=${result?.found ?? 0} sweepable=${result?.sweepable ?? 0} claimable=${claimable.length} refundableReady=${refundableReady.length} usd=${totalUsd.toFixed(2)}`,
    );
    if (claimable.length === 0 && refundableReady.length === 0) return null;
    return {
      ...result,
      items: claimable,
      sweepable: claimable.length,
      totalUsd,
      refundable: refundableReady,
      refundableReady: refundableReady.length,
    };
  } catch (e) {
    console.log(`[SwapKitV2Sweep] detection failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Token identity + bounded send_asset executor ────────────────────

/** Chain id for a canonical asset-id suffix (server src/assets.mjs). */
const ASSET_CHAIN_SUFFIX_IDS: Readonly<Record<string, number>> = {
  ETH: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  POLYGON: 137,
  GNOSIS: 100,
  BSC: 56,
  AVALANCHE: 43114,
};

/**
 * Does a server-named canonical asset id ("USDC_ARBITRUM") denote exactly this
 * token — same symbol, same chain? Both halves are required: a symbol match on
 * another chain, or an unknown chain suffix, is not the scanned balance.
 */
function assetIdMatchesToken(assetId: string, token: RegistryToken): boolean {
  const separator = assetId.lastIndexOf("_");
  if (separator <= 0) return false;
  const symbol = assetId.slice(0, separator).toUpperCase();
  const chainId = ASSET_CHAIN_SUFFIX_IDS[assetId.slice(separator + 1).toUpperCase()];
  return chainId === token.chainId && symbol === token.symbol.toUpperCase();
}

const assetLabel = (item: SwapKitV2SweepItem): string =>
  `${String(item.chainId ?? "?")}:${String(item.symbol || item.asset || "?")}`;

async function canonicalSweepToken(item: SwapKitV2SweepItem): Promise<RegistryToken | null> {
  const address = String(item.address || "").toLowerCase();
  const chainId = Number(item.chainId);
  if (!EVM_ADDRESS.test(address) || !isSignableChain(chainId)) return null;
  const candidates = [
    String(item.symbol || "").toUpperCase(),
    String(item.asset || "")
      .split("_")[0]
      .toUpperCase(),
  ].filter((symbol, index, all) => symbol && all.indexOf(symbol) === index);
  for (const symbol of candidates) {
    const token = await resolveCanonicalToken(chainId, symbol);
    if (token && token.address.toLowerCase() === address) return token;
  }
  return null;
}

/** The sweep-bounded executor set for one item's order: send_asset moves ONLY
 * the exact scanned token, capped at the detected balance, to the server's
 * bound address; EVM calls are allowed on the item's own chain with the
 * approval ceiling derived from the scan. */
export async function makeSweepV2Executors(
  item: SwapKitV2SweepItem,
): Promise<SwapKitV2Executors | null> {
  const token = await canonicalSweepToken(item);
  if (!token) return null;
  const wallet = await getEthereumAddress();
  const settle = wallet
    ? settleBindingForOrder({ to: await getSwapKitBaseCurrency(), settleTarget: wallet })
    : null;
  const detected = sweepItemUnits(item, token);
  return detected === null ? null : makeSweepV2ExecutorsFor(token, detected, settle);
}

/**
 * The detected balance in the token's smallest unit, exactly. The server's
 * `amountRaw.units` is the on-chain integer and wins; the decimal `amount` is
 * a display figure (an 18-decimal balance does not survive `Number`) and is
 * used only when no raw units are present, parsed as text, never as a float.
 * Null when neither can be read exactly or the raw units are for another
 * token.
 */
export function sweepItemUnits(item: SwapKitV2SweepItem, token: RegistryToken): bigint | null {
  const raw = item.amountRaw as { units?: unknown; decimals?: unknown } | undefined;
  if (raw && raw.units != null) {
    if (Number(raw.decimals) !== token.decimals) return null;
    const units = String(raw.units);
    if (!/^\d+$/.test(units)) return null;
    const value = BigInt(units);
    return value > 0n ? value : null;
  }
  return decimalUnits(item.amount, token.decimals);
}

/** Spec-driven core: build the sweep executor set from an already-resolved
 * token + the detected balance in exact base units. Shared by the live claim
 * path and the resume path (which reads the units back from the persisted
 * executorSpec, with NO live sweep required). */
export function makeSweepV2ExecutorsFor(
  token: RegistryToken,
  detected: bigint,
  settle: SwapKitV2SettleBinding | null,
): SwapKitV2Executors | null {
  if (typeof detected !== "bigint" || detected <= 0n) return null;

  const sendAsset = async (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ): Promise<{ txHash: string }> => {
    const to = String(request.to || "").trim();
    if (!EVM_ADDRESS.test(to)) throw new Error("sweep deposit address is not an EVM address");
    // Identity bind. The server's send_asset request names the canonical
    // asset id ("USDC_ARBITRUM"), not a contract: the live engine does not
    // emit tokenContract/chainId (contract schema: both optional). The asset
    // id must be exactly the scanned item's, which pins symbol AND chain; the
    // transfer below always moves the canonical token THIS executor was built
    // for, never one the request names. If a request does carry
    // tokenContract/chainId, they must agree too.
    const boundAsset = String(request.asset || "").trim();
    if (!boundAsset) throw new Error("sweep send_asset is missing its bound asset");
    if (!assetIdMatchesToken(boundAsset, token)) {
      throw new Error(`sweep send_asset asset ${boundAsset} is not the scanned balance`);
    }
    const boundContract = String(request.tokenContract || "")
      .trim()
      .toLowerCase();
    if (boundContract && boundContract !== token.address.toLowerCase()) {
      throw new Error("sweep send_asset token is not the scanned contract");
    }
    if (request.chainId != null && String(request.chainId).trim() !== "") {
      const boundChain = Number(request.chainId);
      if (!Number.isFinite(boundChain) || boundChain !== token.chainId) {
        throw new Error("sweep send_asset chain does not match the scanned balance");
      }
    }
    const amount = String(request.amount || "").trim();
    const units = decimalUnits(amount, token.decimals);
    if (units === null) throw new Error("sweep amount is missing or not exact");
    // The detected balance is the ONLY ceiling on what leaves the wallet,
    // compared in exact base units.
    if (units > detected) {
      throw new Error("sweep fund amount exceeds the detected balance");
    }
    // STARTED is recorded at the broadcast boundary of whichever chain sends,
    // so a crash after the transfer leaves the wire is never replayed as a
    // second funding, and a refusal before it stays retryable.
    const onBeforeBroadcast = async () => {
      await ctx.markStarted?.();
    };
    const hash =
      token.chainId === BASE_CHAIN_ID
        ? (
            await sendTokenOnBase({
              toAddress: to as `0x${string}`,
              amount,
              tokenAddress: token.address as `0x${string}`,
              tokenDecimals: token.decimals,
              awaitReceipt: false,
              onBeforeBroadcast,
            })
          ).hash
        : await sendSweepErc20OnChain(token, to as `0x${string}`, amount, onBeforeBroadcast);
    return { txHash: hash };
  };

  // EVM calls are bound like any EVM-source order: approve only a route
  // provider on the swept token (at most the detected balance), and a LI.FI
  // call must pay this wallet on Base in the chosen base currency.
  const standard = makeStandardV2Executors({
    allowedEvmChains: [token.chainId, BASE_CHAIN_ID],
    allowedApprovalTokens: [token.address.toLowerCase()],
    maxApprovalUnits: detected,
    route: { chainId: token.chainId, sourceToken: token.address, settle },
  });
  return { ...standard, send_asset: sendAsset };
}

// ── Claim ───────────────────────────────────────────────────────────

let claimInFlight: Promise<SwapKitClaimOutcome> | null = null;

/** Fires the first time a sweep order is adopted and tracked — the moment the
 * user's part is over and the claim screen may close. */
export type SwapKitClaimHandoff = () => void;

/** One claim at a time, app-wide (a second tap observes the same outcome). */
export function claimSwapKitSweep(onHandoff?: SwapKitClaimHandoff): Promise<SwapKitClaimOutcome> {
  if (!claimInFlight) {
    claimInFlight = runClaimSwapKitSweep(onHandoff).finally(() => {
      claimInFlight = null;
    });
    return claimInFlight;
  }
  // A second tap rides the in-flight claim. It still gets the handoff, so the
  // screen it is showing closes with the first one.
  return claimInFlight.then((outcome) => {
    if (outcome.started > 0) onHandoff?.();
    return outcome;
  });
}

async function runClaimSwapKitSweep(onHandoff?: SwapKitClaimHandoff): Promise<SwapKitClaimOutcome> {
  const wallet = await getEthereumAddress();
  if (!wallet) throw new Error("Ethereum wallet address is missing.");
  const armed = (await sweepSwapKitV2({
    wallet,
    baseCurrency: await getSwapKitBaseCurrency(),
    confirm: true,
    minUsd: MIN_USD,
    signableChains: CLAIMABLE_SWEEP_CHAIN_IDS,
    capabilities: SWEEP_CAPABILITIES,
    signerClass: { evm: "eoa" },
  })) as SwapKitV2SweepResult;

  // The sweep endpoint creates the orders server-side; the wallet re-adopts and
  // drives them via status/submit carrying its recoveryKey. Derive it once and
  // persist it on each sweep row so a restart reuses the exact value (never a
  // live re-derivation that could flip EOA↔credId — see #4).
  const sweepRecoveryKey = await getSwapKitV2RecoveryKey().catch(
    () => undefined as string | undefined,
  );

  let started = 0;
  let refusedLocally = 0;
  let unresolved = 0;

  // Refunds are independent of every ordinary item — but they BROADCAST and wait
  // for receipts, so awaiting them here would hold the claim screen open for
  // minutes over work the user has no part in. Started now, collected at the
  // end, so the items below can be armed and handed off meanwhile.
  const refundsPromise = executeReadyRefunds(armed.refundable);

  for (const item of armed.items ?? []) {
    const view = item.order;
    if (!view?.orderId) {
      console.log(
        `[SwapKitV2Sweep] no order for ${assetLabel(item)} — ${String(item.error || "server returned no order")}`,
      );
      unresolved++;
      continue;
    }
    if (isSwapKitV2Terminal(view)) {
      // Replayed idempotent commit that already finished — nothing to drive.
      continue;
    }
    const executors = await makeSweepV2Executors(item);
    if (!executors) {
      console.log(
        `[SwapKitV2Sweep] refusing unbindable order=${view.orderId} (${assetLabel(item)})`,
      );
      refusedLocally++;
      continue;
    }
    const orderId = asSwapKitV2OrderId(view.orderId);
    const sweepToken = await canonicalSweepToken(item);
    const detectedUnits = sweepToken ? sweepItemUnits(item, sweepToken) : null;
    await SwapKitV2OrderStore.upsert({
      orderId,
      owner: wallet,
      from: String(item.asset || ""),
      to: await getSwapKitBaseCurrency(),
      amount: String(item.amount ?? ""),
      side: "deposit",
      settleTarget: wallet,
      refundAddress: wallet,
      acceptedDeposit:
        sweepToken && detectedUnits !== null
          ? formatUnits(detectedUnits, sweepToken.decimals)
          : String(item.amount ?? ""),
      recoveryKey: sweepRecoveryKey,
      idempotencyKey: "",
      status: view.status,
      flow: "sweep",
      // Persist the exact inputs makeSweepV2Executors needs so a restart rebuilds
      // the bounded funder + approval ceiling instead of the standard set.
      executorSpec: sweepToken
        ? {
            flow: "sweep",
            chainId: sweepToken.chainId,
            tokenAddress: sweepToken.address,
            tokenDecimals: sweepToken.decimals,
            tokenSymbol: sweepToken.symbol,
            detectedAmount: String(item.amount ?? ""),
            // Exact on-chain units: resume rebuilds the ceiling from these,
            // never from the display decimal.
            ...(detectedUnits !== null ? { detectedUnits: detectedUnits.toString() } : {}),
          }
        : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    {
      const baseCurrency = await getSwapKitBaseCurrency();
      const arriving = Number(
        (view as { execution?: { settleAmount?: string } }).execution?.settleAmount ??
          (view as { accepted?: { minimumSettleAmount?: string } }).accepted?.minimumSettleAmount ??
          item.usd ??
          0,
      );
      void startSwapInFlight({
        orderId,
        from: String(item.asset || ""),
        to: baseCurrency,
        sendAmount: 0,
        receiveAmount: Number.isFinite(arriving) ? arriving : 0,
        settleTarget: wallet,
        own: { evm: wallet },
      }).catch(() => {});
    }
    startSwapKitV2Tracking(orderId, view, {
      executors,
      allowedEvmChains: [Number(item.chainId), BASE_CHAIN_ID].filter(Number.isFinite),
    });
    started += 1;
    // The user's part is over at the FIRST adopted order: the rest of this loop
    // arms more orders without them, and the pill and pending rows carry every
    // one. Holding the "we found money" screen until the loop ends is a wait
    // with nothing in it.
    if (started === 1) {
      noteV2MoveCommitted({
        orderId,
        from: String(item.asset || ""),
        to: await getSwapKitBaseCurrency(),
      });
      try {
        onHandoff?.();
      } catch {}
    }
  }
  if (started > 0) emitV2SwapRefresh();

  const refundOutcome = await refundsPromise;
  const refunded = refundOutcome.confirmed;
  unresolved += refundOutcome.pending;
  if (refunded > 0) emitV2SwapRefresh();
  // A run that armed nothing but refunded something is also finished business:
  // the screen closes on that too, rather than re-offering the same balance.
  if (started === 0 && refunded > 0) {
    try {
      onHandoff?.();
    } catch {}
  }
  return { started, refusedLocally, unresolved, refunded };
}

/** Broadcast refundTo for every trusted, currently-refundable HTLC lock. */
async function executeReadyRefunds(raw: unknown): Promise<{ confirmed: number; pending: number }> {
  const locks = parseRefundableLocks(raw).filter((lock: SatoraRefundableLock) => {
    if (!lock.refundable) return false;
    if (!isTrustedSatoraCoordinator(lock.chainId, lock.coordinatorAddress)) {
      console.log(
        `[SwapKitV2Refund] skipped ${lock.preimageHash.slice(0, 12)}…: coordinator ${lock.coordinatorAddress} on chain ${lock.chainId} is not an allowlisted Satora deployment`,
      );
      return false;
    }
    return true;
  });
  if (locks.length === 0) return { confirmed: 0, pending: 0 };
  let confirmed = 0;
  let pending = 0;
  for (const lock of locks) {
    try {
      const result = await executeSatoraRefund(lock, (step) =>
        console.log(`[SwapKitV2Refund] ${lock.preimageHash.slice(0, 12)}… ${step}`),
      );
      if (result.status === "confirmed") {
        console.log(
          `[SwapKitV2Refund] recovered ${lock.preimageHash.slice(0, 12)}… on chain ${lock.chainId}: ${result.txHash}`,
        );
        confirmed += 1;
      } else {
        console.log(
          `[SwapKitV2Refund] pending ${lock.preimageHash.slice(0, 12)}… on chain ${lock.chainId}: ${result.txHash}`,
        );
        pending += 1;
      }
    } catch (e) {
      console.log(
        `[SwapKitV2Refund] skipped ${lock.preimageHash.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { confirmed, pending };
}
