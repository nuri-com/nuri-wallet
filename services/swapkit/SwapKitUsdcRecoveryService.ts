import { BASE_USDC } from "../../config/network";
import {
  formatDirectSwapProgress,
  readDirectSwapBalance,
  runDirectEvmSwap,
  type DirectSwapProgress,
} from "./SwapKitDirectEvmSwapService";
import {
  EURC_BASE_TOKEN,
  USDC_ARBITRUM_TOKEN,
  USDC_BASE_TOKEN,
  type SwapKitStableToken,
} from "./SwapKitStableAssets";

// Where the stranded USDC can sit. The payout is always EURC on Base — that is
// the currency the app settles in, whatever chain the USDC came from.
type RecoverySource = SwapKitStableToken;

const RECOVERY_SOURCES: RecoverySource[] = [USDC_BASE_TOKEN, USDC_ARBITRUM_TOKEN];

export const DEFAULT_RECOVERY_CHAIN_ID = BASE_USDC.chainId;

const EURC_TARGET = { asset: EURC_BASE_TOKEN.asset, symbol: EURC_BASE_TOKEN.symbol };

const sourceFor = (chainId?: number): RecoverySource => {
  const source = RECOVERY_SOURCES.find(
    (entry) => entry.chainId === (chainId ?? DEFAULT_RECOVERY_CHAIN_ID),
  );
  if (!source) throw new Error(`USDC recovery has no route from chain ${chainId}.`);
  return source;
};

/** The recoverable USDC balance on one source chain. */
export async function getRecoverableUsdcBalance(chainId: number, address: string): Promise<number> {
  return readDirectSwapBalance(sourceFor(chainId), address);
}

/** The recoverable USDC deployments, for callers that offer a choice. */
export const recoverySources = (): readonly RecoverySource[] => RECOVERY_SOURCES;

// Below one base unit of USDC there is nothing meaningful to swap; SwapKit would
// reject a dust amount anyway. "Nothing to recover" is a normal outcome.
const MIN_RECOVERABLE_USDC = 1 / 10 ** BASE_USDC.decimals;

/** Progress of a recovery run. Structurally the shared direct-swap trace. */
export type RecoveryProgress = DirectSwapProgress;

/** One line per progress step, for callers that render the run. */
export const formatRecoveryProgress = formatDirectSwapProgress;

/**
 * USDC→EURC recovery for a dead card-topup swap. When a BTC→EURC topup dies
 * after the hub delivered USDC to the EOA, the USDC is stranded. This swaps it
 * forward to EURC at the original settle target.
 *
 * `usdcAmount` is mandatory and is the exact amount to swap: the USDC that the
 * dead order delivered, which the caller derives from the order's pre-payment
 * balance baseline. There is deliberately no "swap whatever is there" mode — a
 * user may hold USDC of their own, and a failed topup must never touch it.
 *
 * Every guard, bound and durability property lives in runDirectEvmSwap, which
 * the reverse (EURC→USDC) leg shares — this function only names the pair.
 */
export async function recoverStrandedUsdc(params: {
  settleTarget: string;
  usdcAmount: number;
  minEurc: number;
  /** Which USDC deployment to swap FROM. Defaults to Base. */
  chainId?: number;
  onProgress?: (progress: RecoveryProgress) => void;
}): Promise<{ txId: string | null; swappedUsdc: number }> {
  const { txId, swappedAmount } = await runDirectEvmSwap({
    source: sourceFor(params.chainId),
    target: EURC_TARGET,
    settleTarget: params.settleTarget,
    amount: params.usdcAmount,
    minReceive: params.minEurc,
    dust: MIN_RECOVERABLE_USDC,
    op: { scope: "SwapKitUsdcRecovery", action: "recoverStrandedUsdc" },
    onProgress: params.onProgress,
  });
  return { txId, swappedUsdc: swappedAmount };
}

// ── Auto-convert (make it work first: no UI, runs on hydrate) ────────────────

// Below this there is nothing worth a swap; above it, loose USDC on the EOA is
// converted to EURC automatically.
