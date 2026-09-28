import { createPublicClient, createWalletClient, encodeFunctionData, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKey, getEthereumAddress } from "../../lib/secureKeyStorage";
import {
  validateSwapKitRecoveryQuote,
  type SwapKitRecoveryQuote,
} from "../swapkit/SwapKitRecoveryQuote";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { dripBaseGas } from "../../lib/faucet/FaucetService";
import {
  FAUCET_BALANCE_CONFIRM_TIMEOUT_MS,
  FAUCET_BALANCE_POLL_INTERVAL_MS,
} from "../../config/constants";
import { log } from "../logging/LoggerService";
import {
  BASE_EURC,
  BASE_FAUCET_ELIGIBLE_TOKENS,
  BASE_USDC,
  IS_MAINNET,
} from "../../config/network";
import { BASE_VIEM_CHAIN, getBaseRpcUrl, getBaseViemTransport } from "../../lib/rpc/baseRpc";
import {
  assertMinedTxMatchesSigned,
  type ParsedSwapTypedDataAction,
} from "../swapkit/SwapKitService";

const COW_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";
const COW_VAULT_RELAYER = "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110";
const COW_ORDER_FIELDS = [
  ["sellToken", "address"],
  ["buyToken", "address"],
  ["receiver", "address"],
  ["sellAmount", "uint256"],
  ["buyAmount", "uint256"],
  ["validTo", "uint32"],
  ["appData", "bytes32"],
  ["feeAmount", "uint256"],
  ["kind", "string"],
  ["partiallyFillable", "bool"],
  ["sellTokenBalance", "string"],
  ["buyTokenBalance", "string"],
] as const;

const shortAddr = (value?: string | null) => {
  if (!value) return "";
  const str = String(value);
  if (str.length <= 10) return str;
  return `${str.slice(0, 6)}...${str.slice(-4)}`;
};

const maskRpcUrl = (value?: string | null) => {
  if (!value) return "";
  const str = String(value);
  const match = str.match(/^https?:\/\/[^/]+/i);
  return match ? match[0] : str;
};

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

// Load the EOA signer from secure storage; key bytes are zeroized after use.
async function loadBaseAccount(): Promise<ReturnType<typeof privateKeyToAccount>> {
  const keyBytes = await getPrivateKey("ethereum");
  try {
    const pkHex = `0x${bytesToHex(keyBytes)}` as `0x${string}`;
    return privateKeyToAccount(pkHex);
  } finally {
    zeroize(keyBytes);
  }
}

/** Explicit price consent; no allowance, gas request, or broadcast. */
export async function signSwapKitRecoveryQuote(
  input: SwapKitRecoveryQuote,
  expected: { txId: string; owner: string; recipient: string },
): Promise<`0x${string}`> {
  const quote: SwapKitRecoveryQuote = JSON.parse(JSON.stringify(input));
  validateSwapKitRecoveryQuote(quote, expected);
  const account = await loadBaseAccount();
  validateSwapKitRecoveryQuote(quote, { ...expected, owner: account.address });
  if (
    (await getEthereumAddress())?.toLowerCase() !== expected.owner.toLowerCase() ||
    account.address.toLowerCase() !== expected.owner.toLowerCase()
  ) {
    throw new Error("Recovery wallet changed.");
  }
  validateSwapKitRecoveryQuote(quote, expected);
  return account.signTypedData(quote.typedData as Parameters<typeof account.signTypedData>[0]);
}

// Gas floor every assisted-swap signer needs (approve + tx, worst case).
// Shared with the swap flows so gate, drip request, and signing agree.
export const ASSISTED_GAS_FLOOR_WEI = 5_000_000_000_000n;

type BaseApproval = { token: `0x${string}`; spender: `0x${string}`; amount: bigint };

async function ensureBaseErc20Allowance(
  account: ReturnType<typeof privateKeyToAccount>,
  approval: BaseApproval,
  receiptTimeoutMs = 60_000,
): Promise<void> {
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 2, timeout: 10_000 }),
    pollingInterval: 2_000,
  });
  const walletClient = createWalletClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport(),
    account,
  });
  const sendApprove = async (amount: bigint): Promise<void> => {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [approval.spender, amount],
    });
    const approveGas = await publicClient.estimateGas({
      account,
      to: approval.token,
      data: approveData,
      gas: 100_000n,
    });
    const approveHash = await walletClient.sendTransaction({
      account,
      chain: BASE_VIEM_CHAIN,
      to: approval.token,
      data: approveData,
      gas: approveGas,
    } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveHash,
      pollingInterval: 2_000,
      timeout: receiptTimeoutMs,
    });
    if (approveReceipt.status !== "success") {
      throw new Error(`ERC20 approve reverted onchain: ${approveHash}`);
    }
    log("[BaseTokenTransfer] ERC20 approval confirmed", {
      token: shortAddr(approval.token),
      spender: shortAddr(approval.spender),
      amount: amount.toString(),
      txHash: approveHash,
    });
  };

  const allowanceCall = await publicClient.call({
    to: approval.token,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, approval.spender],
    }),
  });
  const allowance = allowanceCall.data ? BigInt(allowanceCall.data) : 0n;
  // Exact, not "at least". An allowance ABOVE this approval is not a saved
  // transaction — the caller bounded `amount` to what the user accepted, but the
  // tx that follows carries server-built calldata whose token amount is never
  // decoded, so any leftover headroom (an abandoned larger swap, an external
  // approve) is spendable past that bound. Reuse only an exact match; rewrite
  // anything else, down as well as up.
  if (allowance === approval.amount) return;
  // Tokens that reject a non-zero→non-zero approve (USDT-style) need the
  // allowance zeroed first. The common first-approval path (0 → amount) stays a
  // single transaction.
  if (allowance !== 0n) await sendApprove(0n);
  await sendApprove(approval.amount);
}

const lower = (value: unknown) => String(value || "").toLowerCase();

export type CowOrderExpectation = {
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  receiver: `0x${string}`;
  maxSellAmount: bigint;
  minBuyAmount?: bigint;
};

/** Independent wallet guardian for the exact CoW order the EOA is asked to sign. */
export function validateCowBaseOrder(
  action: ParsedSwapTypedDataAction,
  expected: CowOrderExpectation,
): void {
  if (!IS_MAINNET || action.chainId !== 8453) {
    throw new Error("CoW signing is restricted to Base mainnet.");
  }
  const { domain, types, primaryType, message } = action.typedData;
  if (
    domain.name !== "Gnosis Protocol" ||
    domain.version !== "v2" ||
    Number(domain.chainId) !== 8453 ||
    lower(domain.verifyingContract) !== COW_SETTLEMENT ||
    primaryType !== "Order"
  ) {
    throw new Error("CoW typed-data domain is not the approved Base settlement contract.");
  }
  const orderFields = types.Order;
  if (
    !Array.isArray(orderFields) ||
    orderFields.length !== COW_ORDER_FIELDS.length ||
    orderFields.some(
      (field, index) =>
        field.name !== COW_ORDER_FIELDS[index][0] || field.type !== COW_ORDER_FIELDS[index][1],
    )
  ) {
    throw new Error("CoW typed-data Order schema is not approved.");
  }

  const sellToken = lower(message.sellToken);
  const buyToken = lower(message.buyToken);
  const eurc = lower(BASE_EURC.address);
  const usdc = lower(BASE_USDC.address);
  if (!((sellToken === eurc && buyToken === usdc) || (sellToken === usdc && buyToken === eurc))) {
    throw new Error("CoW order is not the approved EURC/USDC Base pair.");
  }
  if (!/^0x[0-9a-f]{40}$/.test(lower(message.receiver))) {
    throw new Error("CoW order receiver is invalid.");
  }
  if (
    sellToken !== lower(expected.sellToken) ||
    buyToken !== lower(expected.buyToken) ||
    lower(message.receiver) !== lower(expected.receiver)
  ) {
    throw new Error("CoW order does not match the accepted token direction and receiver.");
  }
  let sellAmount: bigint;
  let buyAmount: bigint;
  let feeAmount: bigint;
  try {
    sellAmount = BigInt(String(message.sellAmount ?? ""));
    buyAmount = BigInt(String(message.buyAmount ?? ""));
    feeAmount = BigInt(String(message.feeAmount ?? ""));
  } catch {
    throw new Error("CoW order contains invalid amounts.");
  }
  const validTo = Number(message.validTo);
  if (sellAmount <= 0n || buyAmount <= 0n || feeAmount < 0n) {
    throw new Error("CoW order contains invalid amounts.");
  }
  if (sellAmount > expected.maxSellAmount) {
    throw new Error("CoW order exceeds the amount accepted by the user.");
  }
  if (expected.minBuyAmount != null && buyAmount < expected.minBuyAmount) {
    throw new Error("CoW order settles less than the amount accepted by the user.");
  }
  if (!Number.isInteger(validTo) || validTo * 1_000 <= Date.now()) {
    throw new Error("CoW order expired before signing.");
  }
  if (
    !/^0x[0-9a-f]{64}$/.test(lower(message.appData)) ||
    !["sell", "buy"].includes(String(message.kind)) ||
    message.partiallyFillable !== false ||
    message.sellTokenBalance !== "erc20" ||
    message.buyTokenBalance !== "erc20"
  ) {
    throw new Error("CoW order contains unsupported execution settings.");
  }
  if (
    !action.approval ||
    lower(action.approval.token) !== sellToken ||
    lower(action.approval.spender) !== COW_VAULT_RELAYER ||
    action.approval.amount !== sellAmount
  ) {
    throw new Error("CoW approval does not exactly match the signed sell amount and relayer.");
  }
}

/** Approve the exact sell amount when needed, then sign the guarded CoW EIP-712 order. */
export async function signCowOrderOnBase(
  action: ParsedSwapTypedDataAction,
  expected: CowOrderExpectation,
  recoveryOwner?: string,
): Promise<{ signature: `0x${string}` }> {
  validateCowBaseOrder(action, expected);
  if (!action.approval) throw new Error("CoW order is missing its guarded approval.");
  const account = await loadBaseAccount();
  const assertRecoveryOwner = async () => {
    if (
      recoveryOwner &&
      (account.address.toLowerCase() !== recoveryOwner.toLowerCase() ||
        (await getEthereumAddress())?.toLowerCase() !== recoveryOwner.toLowerCase())
    ) {
      throw new Error("Recovery wallet changed.");
    }
  };
  await assertRecoveryOwner();
  await ensureBaseMainnetGas(account.address, {
    awaitConfirmation: true,
    minWei: ASSISTED_GAS_FLOOR_WEI,
  });
  await assertRecoveryOwner();
  await ensureBaseErc20Allowance(account, action.approval);
  await assertRecoveryOwner();
  const signature = await account.signTypedData(
    action.typedData as Parameters<typeof account.signTypedData>[0],
  );
  log("[BaseTokenTransfer] CoW order signed", {
    from: shortAddr(account.address),
    sellToken: shortAddr(String(action.typedData.message.sellToken)),
    buyToken: shortAddr(String(action.typedData.message.buyToken)),
    actionId: action.actionId,
  });
  return { signature };
}

/**
 * Outcome of a gas top-up attempt. "unknown" means this check reached no
 * verdict — the RPC was down, the drip fired without being awaited, or the
 * wallet stayed under this gate's deliberately conservative floor while still
 * holding ETH. Callers must treat it as "proceed", never as a failure.
 * "insufficient" is reserved for a wallet that holds nothing at all.
 */
export type BaseGasReadiness = "sufficient" | "insufficient" | "unknown";

// Relay refusals that mean "this wallet does not need a drip", not "this wallet
// cannot pay". The faucet README requires clients to continue on both.
const PROCEEDABLE_REFUSALS = new Set(["already_claimed", "has_gas"]);

// The drip tx can be mined a beat before the balance reads back; poll instead
// of trusting a single post-receipt read. Returns the last balance seen, not a
// verdict — callers need the value, because a wallet that stayed under this
// gate's floor may still cover what the transfer actually costs.
async function waitForGasBalance(
  publicClient: { getBalance: (args: { address: `0x${string}` }) => Promise<bigint> },
  address: `0x${string}`,
  minWei: bigint,
): Promise<bigint> {
  const deadline = Date.now() + FAUCET_BALANCE_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const balance = await publicClient.getBalance({ address });
    if (balance >= minWei || Date.now() >= deadline) return balance;
    await new Promise<void>((resolve) => setTimeout(resolve, FAUCET_BALANCE_POLL_INTERVAL_MS));
  }
}

// The floor above is worst-case (200k gas × 2× price); a real ERC20 transfer
// burns a fraction of it. So falling short of the floor is not proof the wallet
// cannot pay — only an empty wallet is. Everything else goes to the exact
// estimateGas/send, which is the one honest verdict on whether it can.
const shortfallVerdict = (balance: bigint): BaseGasReadiness =>
  balance > 0n ? "unknown" : "insufficient";

/**
 * Top up the EOA with gas via the wirex faucet when its ETH cannot cover a
 * worst-case ERC20 transfer. Never throws — every refusal (has_gas,
 * already_claimed, faucet_empty, ...), RPC error, or timeout is logged and
 * reported through the return value so callers keep control of their path.
 *
 * awaitConfirmation=true blocks until the drip is mined AND the balance covers
 * the requirement (send path); false fires the drip and returns "unknown"
 * (background top-up on balance fetch).
 */
export async function ensureBaseMainnetGas(
  address: `0x${string}`,
  { awaitConfirmation = false, minWei = 0n }: { awaitConfirmation?: boolean; minWei?: bigint } = {},
): Promise<BaseGasReadiness> {
  try {
    const publicClient = createPublicClient({
      chain: BASE_VIEM_CHAIN,
      transport: getBaseViemTransport({ retryCount: 2, timeout: 10_000 }),
      pollingInterval: 7_000,
    });
    const [nativeBalance, gasPrice] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.getGasPrice(),
    ]);
    // Worst-case fee the RPC's estimateGas safety check demands:
    // maxFeePerGas (~2× gas price) × the 200k gas cap used in sendTokenOnBase.
    // Callers that gate on their own floor (assisted swaps) pass it as minWei —
    // otherwise a balance in between would skip the drip yet still fail their gate.
    const dynamicMinWei = 200_000n * gasPrice * 2n;
    const minGasWei = dynamicMinWei > minWei ? dynamicMinWei : minWei;
    if (nativeBalance >= minGasWei) return "sufficient";
    // The faucet's Sybil gate funds only a wallet already holding one of its
    // eligible tokens and answers `no_eure` to every other request. Asking
    // anyway cannot produce gas, so check here — at the one chokepoint every
    // caller goes through — rather than trusting each call site to know whether
    // its tokens have landed yet. The verdict is the same one a chosen refusal
    // would have produced, so callers see no change: an empty wallet is
    // "insufficient", a partially funded one still gets to try its real send.
    if (!(await hasFaucetEligibleBaseToken(address))) {
      log("[BaseTokenTransfer] No faucet-eligible token — drip not requested", {
        address: shortAddr(address),
        balance: nativeBalance.toString(),
      });
      return shortfallVerdict(nativeBalance);
    }
    log("[BaseTokenTransfer] Low ETH for gas — requesting faucet drip", {
      address: shortAddr(address),
      balance: nativeBalance.toString(),
      needed: minGasWei.toString(),
    });
    const drip = await dripBaseGas(address);
    if (!drip.sent || !drip.txHash) {
      log("[BaseTokenTransfer] Faucet drip not sent", { reason: drip.reason });
      // `nativeBalance` above is stale the moment the relay answers, and two
      // kinds of non-sent response are not proof the wallet cannot pay:
      //   - has_gas / already_claimed: the relay says the wallet is covered. A
      //     retried request makes this concrete — attempt one can submit the
      //     drip and time out, so attempt two sees already_claimed for a wallet
      //     that was just funded.
      //   - transient: the relay never reached a verdict (down, timing out,
      //     5xx). An outage must not fail a send the wallet could pay for out
      //     of the ETH it already holds — this gate's floor is 200k × 2× price,
      //     far above what an ERC20 transfer actually costs.
      // Re-read before refusing.
      const proceedable = drip.transient === true || PROCEEDABLE_REFUSALS.has(drip.reason ?? "");
      // Poll only for already_claimed — that is the one case with a drip
      // plausibly still in flight. Nothing else has anything to wait for.
      const balance =
        drip.reason === "already_claimed"
          ? await waitForGasBalance(publicClient, address, minGasWei)
          : await publicClient.getBalance({ address });
      if (balance >= minGasWei) return "sufficient";
      // Still short: the faucet is out of our hands, but the wallet may cover
      // the real (much smaller) gas cost, so let the send try. Only a chosen,
      // definitive refusal over an empty wallet is a dead end.
      return proceedable ? "unknown" : shortfallVerdict(balance);
    }
    if (!awaitConfirmation) {
      log("[BaseTokenTransfer] Faucet drip submitted (not awaiting)", { txHash: drip.txHash });
      return "unknown";
    }
    try {
      await publicClient.waitForTransactionReceipt({
        hash: drip.txHash as `0x${string}`,
        pollingInterval: 2_000,
        timeout: 20_000,
      });
    } catch (e) {
      // A missing receipt is not a verdict — the balance below is. Swallow so a
      // drip that lands late still counts.
      log("[BaseTokenTransfer] Faucet drip receipt unavailable — checking balance", String(e));
    }
    const balance = await waitForGasBalance(publicClient, address, minGasWei);
    const funded = balance >= minGasWei;
    log(
      funded ? "[BaseTokenTransfer] Faucet drip confirmed" : "[BaseTokenTransfer] Drip too small",
      {
        txHash: drip.txHash,
      },
    );
    return funded ? "sufficient" : shortfallVerdict(balance);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("[BaseTokenTransfer] Faucet drip check failed — proceeding", msg);
    return "unknown";
  }
}

// Once per app session, but only once the wallet is a wallet the faucet would
// even consider. A poll that runs before the EOA's tokens have landed reaches no
// verdict, so it must not consume the session's single attempt — the next poll
// tries again. `autoDripInFlight` keeps two overlapping polls from both getting
// past the check before either latches.
let autoDripChecked = false;
let autoDripInFlight = false;

/**
 * Where a broadcast Base transaction stands, without waiting for it.
 *
 * "pending" covers both a tx the chain has not mined yet and an RPC that could
 * not answer — neither is a verdict, so a caller polling this simply asks
 * again. Only a receipt decides "success" / "reverted".
 */
export async function getBaseTransactionOutcome(
  hash: `0x${string}`,
): Promise<"pending" | "success" | "reverted"> {
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 1, timeout: 10_000 }),
  });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    return "pending";
  }
}

/** Current native ETH balance of an address on Base mainnet (wei). */
export async function getBaseMainnetNativeBalance(address: `0x${string}`): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 2, timeout: 10_000 }),
  });
  return publicClient.getBalance({ address });
}

/** Current ERC-20 balance of an address on Base mainnet, in the token's base units. */
export async function getBaseMainnetErc20Balance(
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 2, timeout: 10_000 }),
  });
  const result = await publicClient.call({
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
  });
  return result.data ? BigInt(result.data) : 0n;
}

/**
 * Does this EOA hold anything the gas faucet will drip against?
 *
 * The dripper's Sybil gate funds only wallets already holding one of its
 * eligible tokens and answers `no_eure` to everything else, so a caller that
 * asks without checking spends a request on a certain refusal. A read failure
 * yields `false` for that token only — a partially readable wallet still
 * qualifies on whichever token did read.
 */
export async function hasFaucetEligibleBaseToken(address: `0x${string}`): Promise<boolean> {
  const balances = await Promise.all(
    BASE_FAUCET_ELIGIBLE_TOKENS.map((token) =>
      getBaseMainnetErc20Balance(token, address).catch(() => 0n),
    ),
  );
  return balances.some((balance) => balance > 0n);
}

/** Background gas top-up when the wallet shows Base tokens. Safe to call on every poll. */
export function autoDripBaseGasOnce(address: string): void {
  if (autoDripChecked || autoDripInFlight) return;
  autoDripInFlight = true;
  void (async () => {
    try {
      const addr = address as `0x${string}`;
      // Latch on eligibility, not on having called: a token-less EOA is one the
      // relay cannot answer for, and burning the session's one attempt on it is
      // exactly how a wallet ends a session with no gas. Holding a token means
      // the relay reaches a real decision, so that attempt counts.
      if (!(await hasFaucetEligibleBaseToken(addr))) return;
      autoDripChecked = true;
      await ensureBaseMainnetGas(addr, { awaitConfirmation: false });
    } catch {
      // Fire-and-forget: a read failure just leaves the flag unset for the next poll.
    } finally {
      autoDripInFlight = false;
    }
  })();
}

export type SignAndBroadcastBaseTxParams = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  /**
   * Gas limit the server published for this route (the provider's own
   * simulation). Used as the estimate's upper bound AND broadcast verbatim:
   * src/providers/lifi.mjs requires the wallet to send with this limit rather
   * than re-estimate, because an estimate is a snapshot of one block's state.
   */
  gasLimit?: bigint;
  /** ERC20 approval required before the tx; sent only when allowance is short. */
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  /** Signer the action is bound to; refused when it is not this wallet's EOA. */
  from?: `0x${string}`;
  /** User-accepted upper bound for the approval amount (token base units). */
  maxApprovalUnits?: bigint;
  /** Called immediately after the network assigns the swap hash, before receipt polling. */
  onBroadcast?: (hash: `0x${string}`) => void | Promise<void>;
  /** Durable guard written after preflight/gas checks and immediately before the swap send. */
  onBeforeBroadcast?: () => void | Promise<void>;
  receiptTimeoutMs?: number;
};

/**
 * Sign and broadcast a server-prepared Base mainnet tx from the user's EOA
 * (SwapKit wallet-assisted routes: the LI.FI leg). Nothing moves until this
 * signature — the key never leaves the wallet. Server gasPrice is ignored as
 * stale; viem fills fresh fees. Resolves after the tx is confirmed onchain.
 */
export async function signAndBroadcastBaseMainnetTx({
  to,
  data,
  value = 0n,
  gasLimit,
  approval,
  from,
  maxApprovalUnits,
  onBroadcast,
  onBeforeBroadcast,
  receiptTimeoutMs,
}: SignAndBroadcastBaseTxParams): Promise<{ hash: `0x${string}`; gas: bigint }> {
  const account = await loadBaseAccount();
  // Both checks fail closed BEFORE anything touches the chain: an action bound
  // to a foreign signer or approving more than the user accepted never signs.
  if (from && from.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Action is bound to signer ${shortAddr(from)}, not this wallet.`);
  }
  if (approval && maxApprovalUnits != null && approval.amount > maxApprovalUnits) {
    throw new Error("SwapKit approval exceeds the user-accepted amount bound.");
  }
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 2, timeout: 10_000 }),
    pollingInterval: 2_000,
  });
  const walletClient = createWalletClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport(),
    account,
  });
  log("[BaseTokenTransfer] === Signed tx Begin ===", {
    from: shortAddr(account.address),
    to: shortAddr(to),
    hasApproval: Boolean(approval),
  });

  // The approve + swap both need gas; drip before estimating. By now the hub
  // has delivered tokens to the EOA, so even a fresh wallet passes the
  // faucet's holds-a-token gate here.
  await ensureBaseMainnetGas(account.address, {
    awaitConfirmation: true,
    minWei: ASSISTED_GAS_FLOOR_WEI,
  });

  if (approval) await ensureBaseErc20Allowance(account, approval, receiptTimeoutMs);

  // Simulate the exact transaction immediately before broadcasting it, after
  // the allowance is in place so the call sees real balance AND allowance. This
  // is the server's own contract for `sign_and_broadcast_evm_tx`
  // (`preflight { required: true, method: "eth_call" }`): do not broadcast on
  // revert. Same step SwapKitEvmSigner already runs on the sweep chains.
  await publicClient.call({
    account: account.address,
    to,
    data,
    value,
  });

  // Fail closed. A failing estimateGas means the call reverts in simulation, and
  // both callers of this function are SwapKit action signers: broadcasting anyway
  // burns gas and strands the swap's hub funds mid-route. Throwing here leaves
  // the chain untouched and lets the swap loop re-poll for a rebuilt action.
  const estimatedGas = await publicClient.estimateGas({
    account,
    to,
    data,
    value,
    ...(gasLimit ? { gas: gasLimit } : {}),
  });

  // Broadcasting the BARE estimate is what stranded sk_38670dfb (EURC->USDC,
  // 2026-09-21): estimateGas returned 967,818 against a 965,038 requirement,
  // the tx broadcast with 972,594, landed at index 235 of its block behind two
  // other EURC transfers, and the aggregator path then needed more than those
  // ~7.5k of headroom — reverting with "out of gas: not enough gas for
  // reentrancy sentry" and leaving the order stuck AWAITING_SIGNATURE.
  //
  // The server's gasLimit is the provider's own simulation of THIS route
  // (2,574,900 for that order). src/providers/lifi.mjs states outright that the
  // wallet must broadcast with it and not re-estimate, citing an earlier
  // incident with the same signature. Honour it whenever it is present: an
  // estimate is a snapshot of one block's state, while an aggregator route's
  // real cost depends on the branch taken at inclusion. Unused gas is refunded.
  //
  // With no advisory there is nothing authoritative to broadcast, so the bare
  // estimate stands — inventing a multiplier here would be a guess, not a bound.
  const gas = gasLimit ?? estimatedGas;

  // viem refuses to send when balance < maxFeePerGas × gas, so the larger limit
  // must be funded before it is used. The earlier drip only guarantees the
  // faucet floor; top up again against the limit actually being broadcast.
  const gasPriceNow = await publicClient.getGasPrice();
  await ensureBaseMainnetGas(account.address, {
    awaitConfirmation: true,
    minWei: gas * gasPriceNow * 2n,
  });

  await onBeforeBroadcast?.();
  const hash = await walletClient.sendTransaction({
    account,
    chain: BASE_VIEM_CHAIN,
    to,
    data,
    value,
    gas,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);
  log("[BaseTokenTransfer] Signed tx submitted", { hash });
  await onBroadcast?.(hash);

  // Broadcast succeeded — the hash must survive a receipt-poll timeout / RPC
  // error so the swap loop can record & report depositTxHash and resume, rather
  // than re-signing and asking the wallet to sign again. Only a CONFIRMED
  // onchain revert is fatal (mirrors sendTokenOnBase's unconfirmed return).
  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      pollingInterval: 2_000,
      timeout: receiptTimeoutMs ?? 60_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("[BaseTokenTransfer] Signed tx receipt unavailable — returning unconfirmed hash", msg);
    return { hash, gas };
  }
  if (receipt.status !== "success") {
    const err = new Error(`Transaction reverted onchain: ${hash}`) as Error & {
      txHash?: string;
      code?: string;
    };
    err.txHash = hash;
    err.code = "TRANSACTION_REVERTED";
    throw err;
  }
  // Mined-tuple verify: the chain's record for our hash must equal what we
  // signed. A read failure is tolerated (receipt already confirmed success);
  // a MISMATCH is not — it means the RPC lied and the result is untrusted.
  let mined: Awaited<ReturnType<typeof publicClient.getTransaction>> | null = null;
  try {
    mined = await publicClient.getTransaction({ hash });
  } catch (e) {
    log("[BaseTokenTransfer] Mined tx readback unavailable", String(e));
  }
  if (mined) assertMinedTxMatchesSigned({ to, data, value, from: account.address }, mined);
  log("[BaseTokenTransfer] === Signed tx End ===", { block: receipt.blockNumber });
  return { hash, gas };
}

export type SendTokenOnBaseParams = {
  /** Fires immediately before the transfer is broadcast — the irreversible
   * boundary. A refusal before it (balance, gas estimate) moved nothing. */
  onBeforeBroadcast?: () => void | Promise<void>;
  toAddress: `0x${string}`;
  amount: string | number; // human amount
  /** ERC-20 contract address on the active Base network (see config/network). */
  tokenAddress: `0x${string}`;
  /** Token decimals. */
  tokenDecimals: number;
  /**
   * Optional: await onchain confirmation before resolving.
   * Defaults to true so callers get a confirmed hash.
   */
  awaitReceipt?: boolean;
  /**
   * Optional: override polling interval for receipt wait (ms). Ignored if awaitReceipt=false.
   */
  receiptPollingMs?: number;
  /**
   * Optional: override timeout for receipt wait (ms). Ignored if awaitReceipt=false.
   */
  receiptTimeoutMs?: number;
};

export async function sendTokenOnBase({
  toAddress,
  amount,
  tokenAddress,
  tokenDecimals,
  awaitReceipt = true,
  receiptPollingMs,
  receiptTimeoutMs,
  onBeforeBroadcast,
}: SendTokenOnBaseParams): Promise<{ hash: `0x${string}`; confirmed: boolean }> {
  const chain = BASE_VIEM_CHAIN;
  const getRpcUrl = getBaseRpcUrl;
  const getTransport = getBaseViemTransport;
  log("[BaseTokenTransfer] === ERC20 Transfer Begin ===", {
    to: shortAddr(toAddress),
    amount,
    token: shortAddr(tokenAddress),
    network: IS_MAINNET ? "mainnet" : "testnet",
    awaitReceipt,
  });

  // 1) Load private key
  const account = await loadBaseAccount();
  log("[BaseTokenTransfer] Sender", {
    address: shortAddr(account.address),
  });

  // 2) Clients
  const rpcUrl = getRpcUrl();
  const publicClient = createPublicClient({
    chain,
    transport: getTransport({
      // Be polite to public RPCs: small retry budget and a sane timeout
      retryCount: 2,
      timeout: 10_000,
    }),
    pollingInterval: 7_000,
  });
  log("[BaseTokenTransfer] RPC", { url: maskRpcUrl(rpcUrl) });
  const walletClient = createWalletClient({
    chain,
    transport: getTransport(),
    account,
  });

  // 3) Build calldata
  const value = parseUnits(String(amount), tokenDecimals);
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [toAddress, value],
  });

  // 4) Gas drip: an EOA holding tokens but no ETH cannot pass estimateGas
  // below, so users would be stuck with unswappable funds. Only mainnet has an
  // in-app faucet. A KNOWN-empty wallet fails here with a typed error instead of
  // falling through to estimateGas, whose raw RPC rejection says nothing a user
  // can act on. "unknown" (RPC unreachable) still proceeds — the send may well
  // succeed, and blocking on a failed check would be worse than trying.
  if (IS_MAINNET) {
    const readiness = await ensureBaseMainnetGas(account.address, { awaitConfirmation: true });
    if (readiness === "insufficient") {
      const err = new Error("Base gas top-up unavailable — retry in a moment.") as Error & {
        code?: string;
      };
      err.code = "GAS_TOPUP_UNAVAILABLE";
      throw err;
    }
  }

  // 5) Estimate gas then send.
  // `gas` upper bound is required: viem fills in maxFeePerGas/PriorityFee
  // when an account is passed, and the RPC's eth_estimateGas then runs a
  // conservative safety check `sender_balance >= maxFeePerGas × gas`.
  // Without an explicit `gas`, it uses the block gas limit, which demands
  // more native ETH than typical EOAs hold. Passing a real-world cap
  // (200k is ~4× a standard ERC20 transfer) bypasses the false-negative
  // without affecting the returned gas value.
  const gas = await publicClient.estimateGas({
    account,
    to: tokenAddress,
    data,
    gas: 200_000n,
  });
  log("[BaseTokenTransfer] Gas estimate", { gas: String(gas) });

  // No faucet on Base Sepolia in-app. If the EOA has no native ETH for gas,
  // sendTransaction below fails naturally and the error surfaces to the caller.
  // The irreversible boundary: everything above (balance, gas estimate) could
  // refuse harmlessly; from here the transfer may be on the wire.
  await onBeforeBroadcast?.();
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: tokenAddress,
    data,
    gas,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);
  log("[BaseTokenTransfer] Submitted tx", { hash });

  // 6) When awaitReceipt is true (the default), verify the tx confirmed.
  // Confirmed revert → throw. Receipt-poll timeout / RPC error → return
  // unconfirmed so callers can show pending UI without applying success
  // semantics. The tx is already broadcast with its nonce, so the form
  // must NOT re-enable (caller decides how to surface the pending state).
  if (awaitReceipt) {
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: receiptPollingMs ?? 2_000,
        timeout: receiptTimeoutMs ?? 20_000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("[BaseTokenTransfer] waitForReceipt unavailable — returning unconfirmed", msg);
      log("[BaseTokenTransfer] === ERC20 Transfer End ===");
      return { hash, confirmed: false };
    }
    log("[BaseTokenTransfer] Receipt", {
      status: receipt.status,
      block: receipt.blockNumber,
    });
    if (receipt.status !== "success") {
      const err = new Error(`Transaction reverted onchain: ${hash}`) as Error & {
        txHash?: string;
        code?: string;
      };
      err.txHash = hash;
      err.code = "TRANSACTION_REVERTED";
      throw err;
    }
    log("[BaseTokenTransfer] === ERC20 Transfer End ===");
    return { hash, confirmed: true };
  }
  log("[BaseTokenTransfer] Skipping waitForReceipt (awaitReceipt=false)");
  log("[BaseTokenTransfer] === ERC20 Transfer End ===");
  return { hash, confirmed: false };
}
