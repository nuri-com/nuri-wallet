import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bytesToHex, zeroize } from "../../lib/crypto";
import { getEthereumAddress, getPrivateKey } from "../../lib/secureKeyStorage";
import { BASE_CHAIN_ID, BASE_EURC, BASE_USDC } from "../../config/network";
import { sendTokenOnBase } from "../base/BaseTokenTransferService";
import { getChainRpcUrl } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { EventBus } from "../events/AppEventBusService";
import {
  SWEEP_FUNDING_STATUS,
  SwapKitOrderStore,
  type SwapKitOrder,
  type SwapKitRecoveryMetadata,
} from "./SwapKitOrderStore";
import { emitSwapRefresh, startSwapKitOrderTracking } from "./SwapKitPendingTracker";
import {
  getSweepChainIdByLabel,
  getSweepViemChain,
  SWAPKIT_SWEEP_CHAIN_IDS,
} from "./SwapKitEvmSigner";
import { isSignableChain, resolveCanonicalToken, type RegistryToken } from "./SwapKitTokenRegistry";
import {
  sweepSwapKit,
  trackSwapKitSwap,
  type SwapKitSweepItem,
  type SwapKitSweepResponse,
} from "./SwapKitService";
import {
  executeSatoraRefund,
  isTrustedSatoraCoordinator,
  parseRefundableLocks,
  type SatoraRefundableLock,
} from "./SatoraHtlcRefundService";

/**
 * "Bring everything back to my wallet" (swap_sweep, server v0.6.42): detect
 * balances on other chains that are not the user's Base currency and convert
 * them back — same EOA in and out, refund pinned, gas sponsored. Detection is
 * read-only (confirm:false); claiming arms one normal tracked swap per
 * balance, which then runs through the EXISTING swap flow (order store +
 * pending tracker) like any other swap.
 */

declare const __DEV__: boolean | undefined;

const BASE_CURRENCY_KEY = "swapkit:base-currency:v1";
const LAST_CHECK_KEY = "swapkit:sweep-last-check:v1";
// Detection is a multi-chain scan on the server — once per app-foreground
// session is plenty. ponytail: fixed 15-min throttle, no config.
//
// A dev build drops it to a minute: 15 minutes between attempts makes the claim
// path untestable. Declared locally rather than imported from lib/debug, which
// require()s the debug tree — prod code must not reach into it. A release build
// keeps the shipped throttle.
const CHECK_INTERVAL_MS =
  typeof __DEV__ !== "undefined" && __DEV__ === true ? 60 * 1000 : 15 * 60 * 1000;
// Ignore dust the conversion fees would eat anyway.
const MIN_USD = 1;
// Router approvals sit marginally above the swap amount; the same 1% headroom
// every other approval bound in the app uses.
// The server builds LI.FI approvals at depositAmount * 1.02 (its
// providers/lifi.mjs); a client ceiling below that refuses every rebuilt action
// forever — "Sweep approval exceeds the detected balance" — with nothing the
// user can do about it. Match the server exactly.
const APPROVAL_TOLERANCE = 1.02;

export type SwapKitBaseCurrency = "EURC_BASE" | "USDC_BASE";

/** What one claim run actually did. See `claimSwapKitSweep`. */
export type SwapKitClaimOutcome = {
  /** Conversions handed to the swap machinery — funding submitted or order armed. */
  started: number;
  /** Balances this app refused on a verdict that will not change by itself. */
  refusedLocally: number;
  /**
   * Balances that neither started nor were refused: the server could not arm
   * them, or a funding transfer was journaled and its outcome is unknown. These
   * can succeed on a later attempt, so a run containing any of them is not a
   * settled "this app said no" — even when it also refused something.
   */
  unresolved: number;
  /** Refundable stuck HTLC locks the wallet broadcast a refundTo for (funds recovered). */
  refunded: number;
};

/** The user's Base currency preference — what sweeps convert INTO. */
export async function getSwapKitBaseCurrency(): Promise<SwapKitBaseCurrency> {
  try {
    const stored = await getCacheValue<string>(BASE_CURRENCY_KEY);
    if (stored === "USDC_BASE") return "USDC_BASE";
  } catch {}
  return "EURC_BASE";
}

/**
 * The read-only scan itself, unthrottled and unswallowed: exactly the call the
 * claim check makes, with nothing filtered out. `checkSwapKitSweep` wraps it for
 * the UI; diagnostics use it directly, because "returned null" there collapses
 * "nothing sweepable" and "the scan threw" into one silent outcome.
 */
export async function scanSwapKitSweep(): Promise<SwapKitSweepResponse> {
  const wallet = await getEthereumAddress();
  if (!wallet) throw new Error("Ethereum wallet address is missing.");
  return sweepSwapKit({
    wallet,
    baseCurrency: await getSwapKitBaseCurrency(),
    confirm: false,
    minUsd: MIN_USD,
    signableChains: CLAIMABLE_SWEEP_CHAIN_IDS,
  });
}

/**
 * Read-only detection for the claim screen. Returns the sweep result when
 * there is something worth claiming, null otherwise (or on any error — a
 * failed scan must never surface to the user). `force` skips the throttle
 * (explicit user pull); the periodic callers leave it off.
 */
export async function checkSwapKitSweep(options?: {
  force?: boolean;
}): Promise<SwapKitSweepResponse | null> {
  try {
    if (!options?.force) {
      const last = Number((await getCacheValue<number>(LAST_CHECK_KEY)) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return null;
    }
    const wallet = await getEthereumAddress();
    if (!wallet) return null;
    const result = await scanSwapKitSweep();
    // Throttle only successful scans — a hung/failed call must not burn the
    // 15-min window (a 466s timeout once hid a positive result for the rest
    // of the session).
    await setCacheValue(LAST_CHECK_KEY, Date.now());

    // Announce only what this app can actually carry home. The server sweeps a
    // list of assets that is wider than SWEEP_TOKENS and grows independently of
    // this repo (SWAPKIT_SWEEP_ASSETS is server config), and `signableChains` is
    // chain-granular, so it legitimately arms a token on an allowed chain that
    // has no transfer path here — USDT or tBTC on Arbitrum today. Counting those
    // is what puts money in the headline that the claim then refuses.
    //
    // Filtering here rather than syncing the two lists by hand: the sheet is
    // derived from this app's own capability, so it cannot drift when the server
    // adds an asset.
    const verdicts = await Promise.all(
      (result.items ?? []).map(async (item) => ({ item, blocker: await scanClaimBlocker(item) })),
    );
    for (const { item, blocker } of verdicts) {
      if (blocker) console.log(`[SwapKitSweep] not announcing ${assetLabel(item)}: ${blocker}`);
    }
    const claimable = verdicts.filter((v) => !v.blocker).map((v) => v.item);
    const totalUsd = claimable.reduce((sum, item) => {
      const usd = Number(item.usd);
      return sum + (Number.isFinite(usd) ? usd : 0);
    }, 0);
    // Chain-sourced stuck HTLC locks that are refundable RIGHT NOW (timelock
    // passed). These are a first-class reason to surface the found-money sheet,
    // independent of any sweepable balance: a wallet with zero loose balances but
    // a recoverable stuck swap must still see it. Parse with the same fail-closed
    // parser the claim path uses, so a malformed entry with a truthy `refundable`
    // flag can never surface a sheet that then recovers nothing and closes as if
    // handled. Apply the coordinator allowlist here too: an untrusted deployment
    // would be refused deterministically at claim time, and surfacing it would
    // trap the sheet in a show → refuse → close → re-offer loop.
    const refundableReady = parseRefundableLocks(result.refundable).filter((r) => {
      if (!r.refundable) return false;
      if (!isTrustedSatoraCoordinator(r.chainId, r.coordinatorAddress)) {
        console.log(
          `[SwapKitSweep] not announcing refundable lock ${r.preimageHash.slice(0, 12)}…: coordinator ${r.coordinatorAddress} on chain ${r.chainId} is not an allowlisted Satora deployment`,
        );
        return false;
      }
      return true;
    });
    console.log(
      `[SwapKitSweep] wallet=${wallet} found=${result?.found ?? 0} sweepable=${result?.sweepable ?? 0} claimable=${claimable.length} refundableReady=${refundableReady.length} usd=${totalUsd.toFixed(2)}`,
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
    console.log(`[SwapKitSweep] detection failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Deposit funding ──────────────────────────────────────────────────────────
// A convert that returns fund.sendToAddress needs the wallet to actually move
// the token to SwapKit's deposit address. Fail-closed allow-list: exactly the
// sweep item's token on a chain we can sign for, exactly the sweep amount, to
// exactly the server's deposit address — anything else is skipped (the row
// stays; the server's provider polling picks it up once funded another way).

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The chain an item is on: its `chainId` when the scan carries one, otherwise the
 * chain LABEL mapped back to an id. Both the scan-time verdict and the claim-time
 * binding go through here — resolving one but not the other would announce a
 * balance and then refuse it. NaN when neither resolves, which every caller
 * treats as unsupported.
 */
const sweepItemChainId = (item: SwapKitSweepItem): number =>
  Number.isFinite(Number(item.chainId))
    ? Number(item.chainId)
    : (getSweepChainIdByLabel(String(item.chain || "")) ?? Number.NaN);

/** `chain:symbol` as the server labelled it — for logs only, never for lookups. */
const assetLabel = (item: SwapKitSweepItem): string =>
  `${String(item.chain || "?")}:${String(item.symbol || item.asset || "?")}`;

// Which balances this app can carry is decided per item, against the same
// registry the server resolves from (see SwapKitTokenRegistry): the scanned
// contract must BE the canonical token for its chain and symbol. A static list
// here would drift the moment the server's SWAPKIT_SWEEP_ASSETS grows, which is
// exactly how a balance gets announced and then refused.

// Everything the signer supports AND this app has an RPC for — the transfer and
// the approval both need one, so advertising a chain without it would have the
// server arm orders that die locally.
const CLAIMABLE_SWEEP_CHAIN_IDS = SWAPKIT_SWEEP_CHAIN_IDS.filter(isSignableChain);

/**
 * The wallet's own currencies on Base: what the sweep settles INTO, and therefore
 * never a find. Only these two — a Base balance that is neither is residue.
 */
const BASE_SETTLEMENT_ADDRESSES = new Set(
  [BASE_EURC.address, BASE_USDC.address].map((address) => String(address).toLowerCase()),
);

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Shared with the v2 sweep service — the bounded off-Base ERC-20 transfer. */
export async function sendErc20OnChain(
  token: RegistryToken,
  toAddress: `0x${string}`,
  amount: string,
  /** Fires immediately before the transfer is broadcast (the irreversible
   * boundary). Optional so every existing caller keeps its behaviour. */
  onBeforeBroadcast?: () => void | Promise<void>,
): Promise<`0x${string}`> {
  const chain = getSweepViemChain(token.chainId);
  if (!chain) throw new Error(`sweep chain ${token.chainId} is not configured`);
  const keyBytes = await getPrivateKey("ethereum");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
  // The RPC comes from lib/rpc/chainRpc, not viem's built-in default: the default
  // is an unkeyed public endpoint with no timeout or retries, and this is the
  // transfer that moves the user's money. Gas on the EOA is sponsored by SwapKit
  // before the action.
  const transport = http(getChainRpcUrl(token.chainId as ChainId), {
    retryCount: 2,
    timeout: 10_000,
  });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [toAddress, parseUnits(amount, token.decimals)],
  });
  const gas = await publicClient.estimateGas({
    account,
    to: token.address,
    data,
    gas: 200_000n,
  });
  // Cast per the same viem workaround used in BaseTokenTransferService and
  // SwapKitHtlcActionService: sendTransaction's request generic mis-infers here
  // and demands the EIP-4844 `kzg` field for a plain transfer that carries no
  // blobs. Account and chain are already bound on walletClient.
  await onBeforeBroadcast?.();
  return walletClient.sendTransaction({ to: token.address, data, gas } as unknown as Parameters<
    typeof walletClient.sendTransaction
  >[0]);
}

/**
 * A convert asks for its deposit in one of two shapes: `convert.fund` (the
 * intent's funding instruction) or a `send_asset` entry in `convert.actions`
 * (the same instruction, action-typed). Both mean "send this asset there" — the
 * app funds either identically. Reading only `fund` made an action-shaped
 * convert look address-less, so funding silently did nothing and the order sat
 * at AWAITING_FUNDING until the server expired it.
 */
const sendAssetActionOf = (item: SwapKitSweepItem): Record<string, unknown> | undefined => {
  const actions = (item.convert as { actions?: unknown[] } | undefined)?.actions;
  if (!Array.isArray(actions)) return undefined;
  return actions.find((action) => (action as { type?: unknown })?.type === "send_asset") as
    | Record<string, unknown>
    | undefined;
};

/** The deposit address of a convert, or "" when it carries none. */
const depositAddressOf = (item: SwapKitSweepItem): string => {
  const fund = (item.convert as { fund?: Record<string, unknown> } | undefined)?.fund;
  const fromFund = String(fund?.sendToAddress || fund?.address || "").trim();
  if (fromFund) return fromFund;
  return String(sendAssetActionOf(item)?.to || "").trim();
};

/**
 * The deposit amount a convert states, from either shape, or "" when it states
 * none. The server's stated amount only ever narrows what leaves the wallet —
 * the scan's detected balance is the ceiling, enforced by every caller.
 */
const depositAmountOf = (item: SwapKitSweepItem): string => {
  const fund = (item.convert as { fund?: Record<string, unknown> } | undefined)?.fund;
  return String(fund?.amount ?? sendAssetActionOf(item)?.amount ?? item.amount ?? "").trim();
};

/**
 * Why the claim could not carry this balance, judged from the SCAN's own fields,
 * or null when nothing knowable at scan time rules it out.
 *
 * Deliberately separate from `unfundableDepositReason`: that one answers "can
 * this armed convert's deposit be moved" and returns null for anything that is
 * not a deposit — including a read-only scan item, which carries no `convert` at
 * all. Asking it about a scan therefore calls every balance fine, unsupported
 * ones included. What a scan CAN decide is identity: the contract, its chain,
 * and whether a ceiling exists for it. Everything past that (the deposit address
 * and stated amount) only exists after confirm:true.
 */
export async function scanClaimBlocker(item: SwapKitSweepItem): Promise<string | null> {
  const token = await canonicalSweepToken(item);
  if (!token) {
    return `no local transfer path for ${assetLabel(item)} (${String(item.address || "no contract")})`;
  }
  if (!CLAIMABLE_SWEEP_CHAIN_IDS.includes(token.chainId)) {
    return `chain ${token.chainId} is not claimable`;
  }
  // Base is where the sweep lands, not where it looks. The scan is told a single
  // `baseCurrency` to leave alone, but the wallet now HOLDS both euro and dollar
  // there — so the one that is not the base currency comes back as a find, and the
  // user is offered their own balance as money we discovered.
  //
  // That reasoning is about the wallet's OWN two currencies, not about every token
  // on Base. Residue a route delivered lives on Base too (an intermediate asset, a
  // bridged token), and refusing it here is what kept a real balance invisible to the
  // rescue: a LI.FI BTC-source route delivered TITN to the wallet and the sweep was
  // never allowed to announce it. Only the settlement currencies are "their own
  // balance"; anything else on Base is found money like any other chain's.
  if (
    token.chainId === BASE_CHAIN_ID &&
    BASE_SETTLEMENT_ADDRESSES.has(String(token.address).toLowerCase())
  ) {
    return "on Base — a held balance, not a find";
  }
  const detected = Number(item.amount);
  if (!Number.isFinite(detected) || detected <= 0) return "scan reported no detected balance";
  // The signer refuses the first approval without a ceiling, so an action-style
  // convert on this balance would be armed and then never execute.
  if (!(await detectedApprovalUnits(item))) return "no approval ceiling can be derived";
  return null;
}

/**
 * Can this app actually move the deposit this convert asks for? SWEEP_TOKENS is
 * narrower than the chains the wallet can SIGN on, so the server can legitimately
 * arm a deposit whose asset has no transfer path here. Checked BEFORE the order
 * is persisted and counted: fundSweepConvert throws asynchronously, so without
 * this the claim reported success and closed the sheet while nothing moved.
 * Returns the reason it cannot be funded, or null when it can.
 */
export async function unfundableDepositReason(item: SwapKitSweepItem): Promise<string | null> {
  const to = depositAddressOf(item);
  if (!to) return null; // signing-rail convert — not a deposit, nothing to fund here
  if (!EVM_ADDRESS.test(to)) return "deposit address is not an EVM address";
  if (!(await canonicalSweepToken(item))) {
    return `no deposit transfer path for ${assetLabel(item)} (${String(item.address || "no contract")})`;
  }
  const amount = Number(depositAmountOf(item));
  if (!Number.isFinite(amount) || amount <= 0) return "deposit amount is missing";
  // The detected balance is the ONLY ceiling on how much leaves the wallet, so
  // it must exist and be a real number — an absent or unparseable scan amount
  // would otherwise let the server's stated amount through unbounded.
  const detected = Number(item.amount);
  if (!Number.isFinite(detected) || detected <= 0) return "scan reported no detected balance";
  // No headroom on funds LEAVING the wallet. APPROVAL_TOLERANCE exists because
  // a router allowance sits marginally above the swap amount; a transfer above
  // the scanned balance simply reverts, or spends tokens that arrived after the
  // scan and were never part of what the user confirmed.
  if (amount > detected) {
    return "deposit amount exceeds the detected balance";
  }
  return null;
}

/**
 * The canonical token this item refers to, or null. The scanned CONTRACT decides:
 * it must be the exact token whose decimals the ceiling is computed from and
 * whose transfer path we would use. Anything else is a same-chain, same-symbol
 * impostor with different decimals.
 *
 * The chain is taken from `chainId` when the scan carries one — it is the same
 * field the approval binding trusts — and only falls back to the `chain` label
 * for scans that omit it.
 */
async function canonicalSweepToken(item: SwapKitSweepItem): Promise<RegistryToken | null> {
  const address = String(item.address || "").toLowerCase();
  const chainId = sweepItemChainId(item);
  if (!EVM_ADDRESS.test(address) || !isSignableChain(chainId)) return null;
  // Two ways the scan names the asset: `symbol` is display text and can carry a
  // variant suffix ("USDC.e"), while `asset` is the canonical SYMBOL_CHAIN id
  // whose head is the registry's own symbol. Try both — the ADDRESS is what
  // decides, and a label that resolves to a different contract simply misses.
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

/**
 * The detected balance as token units, with the same 1% headroom every other
 * approval bound in the app uses (router approvals sit marginally above the swap
 * amount). Returns "" when the scan gave no usable amount or the token is not
 * one this app knows the decimals for — the caller then persists no ceiling and
 * the signer refuses to approve at all.
 */
async function detectedApprovalUnits(item: SwapKitSweepItem): Promise<string> {
  const token = await canonicalSweepToken(item);
  const detected = Number(item.amount);
  if (!token || !Number.isFinite(detected) || detected <= 0) return "";
  return parseUnits(
    (detected * APPROVAL_TOLERANCE).toFixed(token.decimals),
    token.decimals,
  ).toString();
}

/** Fund one armed convert when it asks for a plain deposit; report the hash. */
async function fundSweepConvert(item: SwapKitSweepItem, txId: string): Promise<string> {
  const to = depositAddressOf(item);
  if (!to) throw new Error("sweep convert carries no deposit address to fund");
  if (!EVM_ADDRESS.test(to)) throw new Error("sweep deposit address is not an EVM address");
  const chain = String(item.chain || "").toLowerCase();
  const symbol = String(item.symbol || item.asset || "").toUpperCase();
  // Identity bind re-asserted at the point the transfer is actually built:
  // this function is what moves the money.
  const token = await canonicalSweepToken(item);
  if (!token)
    throw new Error(`sweep funding for ${assetLabel(item)} is not bound to a known token`);
  // Exactly the amount the sweep found — never more (a stated amount, from
  // either shape, must agree; a mismatch is a red flag, not a rounding case).
  const amount = depositAmountOf(item);
  if (!amount || Number(amount) <= 0) throw new Error("sweep amount is missing");
  const detected = Number(item.amount);
  if (!Number.isFinite(detected) || detected <= 0) {
    throw new Error("sweep item carries no detected balance to cap against");
  }
  if (Number(amount) > detected) {
    throw new Error("sweep fund amount exceeds the detected balance");
  }
  // Which chain the transfer goes out on comes from the TOKEN the contract
  // resolved to, never from the server's chain label: a label this app does not
  // recognise must not decide that the user's money leaves on some other chain.
  const hash =
    token.chainId === BASE_CHAIN_ID
      ? (
          await sendTokenOnBase({
            toAddress: to as `0x${string}`,
            amount,
            tokenAddress: token.address as `0x${string}`,
            tokenDecimals: token.decimals,
            awaitReceipt: false,
          })
        ).hash
      : await sendErc20OnChain(token, to as `0x${string}`, amount);
  console.log(`[SwapKitSweep] funded ${chain}:${symbol} order=${txId}`);
  await trackSwapKitSwap(txId, { depositTxHash: hash }).catch(() => {});
  return hash;
}

/**
 * Arm the sweep (confirm:true) and hand every returned conversion to the
 * existing swap machinery: one order-store row + tracker loop per txId, same
 * as any discovered swap. Deposit-style converts are funded here (exact
 * amount, allow-listed token, server deposit address); action-style converts
 * are signed by the tracker loop.
 *
 * `refusedLocally` counts the balances THIS APP turned down — a deterministic
 * verdict that will repeat identically on every future scan. `unresolved` counts
 * the ones whose outcome is not settled: unarmed by the server, or funded with
 * an unknown result. Both are reported apart from `started` because a zero-start
 * claim is otherwise ambiguous, and a run can mix the two — one refused balance
 * next to one that may yet succeed is not a settled refusal.
 */
let claimInFlight: Promise<SwapKitClaimOutcome> | null = null;

export function claimSwapKitSweep(): Promise<SwapKitClaimOutcome> {
  // One claim at a time, app-wide. Every screen routes through here, and a
  // second tap while the first confirm is still open arms a SECOND set of
  // converts for the same balances — three taps produced three sibling orders in
  // production, all unfunded. Sharing the in-flight promise makes the extra taps
  // observe the same outcome instead of starting a rival claim. Guarding in
  // React state cannot do this: the taps land before any state update commits.
  if (!claimInFlight) {
    claimInFlight = runClaimSwapKitSweep().finally(() => {
      claimInFlight = null;
    });
  }
  return claimInFlight;
}

async function runClaimSwapKitSweep(): Promise<SwapKitClaimOutcome> {
  const wallet = await getEthereumAddress();
  if (!wallet) throw new Error("Ethereum wallet address is missing.");
  const armed = await sweepSwapKit({
    wallet,
    baseCurrency: await getSwapKitBaseCurrency(),
    confirm: true,
    minUsd: MIN_USD,
    signableChains: CLAIMABLE_SWEEP_CHAIN_IDS,
  });
  let started = 0;
  let refusedLocally = 0;
  let unresolved = 0;
  // Refunds run FIRST and on their own: recovering a stuck HTLC lock is
  // independent of every ordinary sweep item, so an uncaught rejection later in
  // the item loop (e.g. a SwapKitOrderStore.add failure) must never skip it. The
  // caller catches loop rejections and closes the sheet; doing refunds up front
  // guarantees they are attempted regardless.
  const refundOutcome = await executeReadyRefunds(armed.refundable);
  const refunded = refundOutcome.confirmed;
  unresolved += refundOutcome.pending;
  if (refunded > 0) emitSwapRefresh();
  for (const item of armed.items ?? []) {
    const txId = String(item.convert?.txId || "").trim();
    if (!txId) {
      // The server returns the balance WITH a per-item `error` when arming it
      // failed, instead of a convert. Dropping that silently is why a sweep
      // that scanned clean can do nothing on confirm with no trace at all.
      console.log(
        `[SwapKitSweep] no convert for ${String(item.chain || "?")}:${String(item.symbol || item.asset || "?")} — ${String(item.error || "server returned no txId")}`,
      );
      unresolved++;
      continue;
    }
    // The binding IS the approval guard: parseSwapActionTx only allows an
    // approval whose token is the exact contract the read-only scan observed on
    // this EOA. Without it the guard falls back to DEFAULT_APPROVAL_TOKENS,
    // which covers Base only — so on every other chain an unbound order has an
    // empty allow-list and every approval is refused.
    const chainId = sweepItemChainId(item);
    const approvalToken = String(item.address || "").trim();
    const bound = SWAPKIT_SWEEP_CHAIN_IDS.includes(chainId) && EVM_ADDRESS.test(approvalToken);
    // Only an action-style convert needs the approval binding — that is what
    // the tracker loop signs. A deposit-style convert is funded by
    // fundSweepConvert, which is fail-closed on its own (allow-listed token,
    // exact amount, EVM-checked address), so demanding a binding it never
    // carries would silently strand the sweep.
    if (!bound && !depositAddressOf(item)) {
      console.log(`[SwapKitSweep] refusing unbound action order=${txId}`);
      refusedLocally++;
      continue;
    }
    // Fail closed BEFORE persisting: a convert this app cannot fund must not be
    // counted as started, or the sheet reports success and closes over an order
    // that will only ever sit unfunded.
    const unfundable = await unfundableDepositReason(item);
    if (unfundable) {
      console.log(`[SwapKitSweep] cannot fund order=${txId}: ${unfundable}`);
      refusedLocally++;
      continue;
    }
    // Ceiling for any approval the tracker may later sign for this order, taken
    // from the scan's own detected amount. An action-style convert carries no
    // deposit instruction, so this is the only bound on how much the router can
    // be allowed to spend.
    const approvalMaxUnits = await detectedApprovalUnits(item);
    // signableChains advertises every chain the signer supports, but a ceiling
    // can only be derived for assets whose decimals are known locally
    // (SWEEP_TOKENS). Without one the signer refuses the first approval, so an
    // action order on any other advertised chain would be counted as started and
    // then never execute. Refuse it here instead of reporting a false success.
    if (!depositAddressOf(item) && !approvalMaxUnits) {
      console.log(
        `[SwapKitSweep] cannot bound approval order=${txId}: no local decimals/amount for ${String(item.chain || "?")}:${String(item.symbol || item.asset || "?")}`,
      );
      refusedLocally++;
      continue;
    }
    const depositTo = depositAddressOf(item);
    const createdAt = Date.now();
    const bindings = bound
      ? { chainId, approvalToken, ...(approvalMaxUnits ? { approvalMaxUnits } : {}) }
      : {};
    const rowWith = (recovery: SwapKitRecoveryMetadata): SwapKitOrder => ({
      kind: "discovered",
      txId,
      settleTarget: wallet,
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt,
      attempts: 0,
      recovery: { provider: "sweep", ...bindings, ...recovery },
    });

    if (depositTo) {
      // Journal the funding intent BEFORE the transfer leaves the wallet, with
      // the exact bounded deposit it describes. A kill or a failed durable write
      // between the broadcast and the order row would otherwise move funds this
      // device keeps no record of at all — nothing to resume, reconcile or even
      // show. A FUNDING row is deliberately not a startable order (the tracker
      // refuses it), so writing it first cannot make an unfunded convert look
      // live; it says only that the outcome of this transfer is unknown.
      await SwapKitOrderStore.add(
        rowWith({
          status: SWEEP_FUNDING_STATUS,
          depositTo,
          depositAmount: depositAmountOf(item),
        }),
      );
      let depositTxHash: string;
      try {
        depositTxHash = await fundSweepConvert(item, txId);
      } catch (e) {
        // The intent row stays: a throw is not proof the transfer never went
        // out (a submit can time out after the node accepted it), and that
        // uncertainty is exactly what has to survive a restart. Nothing
        // re-broadcasts from it — the app must not guess.
        console.log(
          `[SwapKitSweep] funding failed order=${txId}: ${e instanceof Error ? e.message : String(e)}`,
        );
        unresolved++;
        continue;
      }
      // Funded: the row becomes a real order, carrying the hash it was funded
      // with. Awaiting the transfer also makes `started` mean what the sheet
      // reports — funding was submitted.
      await SwapKitOrderStore.add(rowWith({ status: "PROCESSING", depositTo, depositTxHash }));
    } else {
      await SwapKitOrderStore.add(rowWith({ status: "PROCESSING" }));
    }
    const order = SwapKitOrderStore.list().find((row) => row.txId === txId);
    if (order) startSwapKitOrderTracking(order);
    // Show the wait. Without a row the sheet just closes and the user stares at
    // an unchanged balance for the minute the conversion takes. The tracker
    // already clears this row (wallet:clearPendingTransfer, keyed by the order
    // id) when the order reaches a terminal state, so the same lifecycle that
    // ends every other swap row ends this one.
    try {
      EventBus.emit("wallet:pendingTransfer", {
        amountFiat: Number(item.usd) || 0,
        txHash: null,
        orderId: txId,
        // NOT "swapkit": that tag marks an OUTGOING EUR→BTC swap — it debits the
        // euro balance optimistically and hands the row to the EUR→BTC tracker
        // on resume. A sweep brings value IN, and its order is already resumed
        // from SwapKitOrderStore by the sweep-bounded tracker.
        source: "swapkit_sweep",
        createdAt: new Date().toISOString(),
      });
    } catch {}
    started += 1;
  }
  if (started > 0) emitSwapRefresh();
  return { started, refusedLocally, unresolved, refunded };
}

/**
 * Broadcast refundTo for every stuck HTLC lock the server flagged refundable and
 * that the coordinator still records as owned by this wallet. Each refund is
 * independent and best-effort: one failure never blocks the others, and a lock
 * whose timelock has not passed simply reverts in simulation and is skipped.
 * Returns confirmed and pending counts separately: only a successful receipt is
 * recovered; an in-flight hash is unresolved and must never be counted as success.
 */
async function executeReadyRefunds(raw: unknown): Promise<{ confirmed: number; pending: number }> {
  const locks = parseRefundableLocks(raw).filter((lock: SatoraRefundableLock) => {
    if (!lock.refundable) return false;
    // Same allowlist the detection gate applies: skip here rather than letting
    // executeSatoraRefund throw-and-swallow, so the log says why.
    if (!isTrustedSatoraCoordinator(lock.chainId, lock.coordinatorAddress)) {
      console.log(
        `[SwapKitRefund] skipped ${lock.preimageHash.slice(0, 12)}…: coordinator ${lock.coordinatorAddress} on chain ${lock.chainId} is not an allowlisted Satora deployment`,
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
        console.log(`[SwapKitRefund] ${lock.preimageHash.slice(0, 12)}… ${step}`),
      );
      if (result.status === "confirmed") {
        console.log(
          `[SwapKitRefund] recovered ${lock.preimageHash.slice(0, 12)}… on chain ${lock.chainId}: ${result.txHash}`,
        );
        confirmed += 1;
      } else {
        console.log(
          `[SwapKitRefund] pending ${lock.preimageHash.slice(0, 12)}… on chain ${lock.chainId}: ${result.txHash}`,
        );
        pending += 1;
      }
    } catch (e) {
      // A refund that reverts (timelock not passed, wrong depositor, no gas) or
      // fails to broadcast must never break the sweep run — the server re-offers
      // it on the next scan once the blocker clears.
      console.log(
        `[SwapKitRefund] skipped ${lock.preimageHash.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { confirmed, pending };
}
