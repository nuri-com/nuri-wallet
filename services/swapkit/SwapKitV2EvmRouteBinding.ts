// Binds a raw server-built `execute_evm_call` to the order the user accepted.
//
// The server builds EVM calls as opaque { chainId, to, data }. The wallet does
// not second-guess the server's numbers — every amount it checks against is a
// value the server itself returned (the accepted deposit, the committed
// recipient). It only refuses calls that could move money somewhere the user
// did not agree to: an approval to a stranger, a transfer out of the wallet, a
// router call paying someone other than the committed recipient.
//
// Spender/target addresses are the providers' own published contracts, the
// same ones the server uses (nuri-mcp-bitcoin-swapkit src/providers/lifi.mjs,
// src/providers/cow.mjs). The LI.FI Diamond and the CoW Vault Relayer are
// deployed at the same address on every EVM chain.
import { decodeAbiParameters, decodeFunctionData, isAddressEqual, parseAbi } from "viem";
import { swapKitStableToken } from "./SwapKitStableAssets";

/** LI.FI Diamond: both the approval spender and the swap/bridge-call target. */
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as const;
/** CoW Protocol Vault Relayer: approval spender only; the order is a signature. */
const COW_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;
const APPROVAL_SPENDERS = [LIFI_DIAMOND, COW_VAULT_RELAYER] as const;

const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export type SwapKitV2EvmRouteBinding = {
  chainId: number;
  /** The ONE token this order spends — the accepted deposit's contract. */
  sourceToken: `0x${string}`;
  /** Where the accepted route must deliver, and at least how much. Without it
   * no router call or typed-data order can be bound, so both are refused. */
  settle: SwapKitV2SettleBinding | null;
};

/** The committed settle side of an order, as the wallet recorded it. */
export type SwapKitV2SettleBinding =
  | { kind: "evm"; chainId: number; token: `0x${string}`; receiver: `0x${string}` }
  | { kind: "btc"; address: string };

/**
 * The committed recipient and asset, from the order the user accepted — the
 * same fields on the live path and on resume. Amounts are deliberately not
 * part of it: the settle amount is the server's to enforce (it rejects a quote
 * below the accepted minimum at commit), and a price that moves afterwards
 * expires the order for a fresh quote rather than being judged here.
 */
export function settleBindingForOrder(order: {
  to: string;
  settleTarget: string;
}): SwapKitV2SettleBinding | null {
  const target = String(order.settleTarget || "").trim();
  if (order.to === "BTC") {
    return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,90}$/.test(target)
      ? { kind: "btc", address: target }
      : null;
  }
  let token: ReturnType<typeof swapKitStableToken>;
  try {
    token = swapKitStableToken(order.to);
  } catch {
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return null;
  return {
    kind: "evm",
    chainId: token.chainId,
    token: token.token,
    receiver: target as `0x${string}`,
  };
}

function same(a: string, b: string): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/.test(a) &&
    /^0x[0-9a-fA-F]{40}$/.test(b) &&
    isAddressEqual(a as `0x${string}`, b as `0x${string}`)
  );
}

/**
 * Refuse any call that could move money somewhere the user did not agree to.
 *
 *   approve on the SOURCE token  → spender is a route provider, amount is at
 *                                  most the accepted deposit
 *   call to the LI.FI Diamond    → pays the committed recipient (decoded)
 *   anything else                → refused (raw transfers, calls on other
 *                                  tokens, unknown contracts)
 */
export function assertEvmCallBoundToRoute(
  call: { chainId: number; to: string; data: string },
  binding: SwapKitV2EvmRouteBinding,
  acceptedDepositUnits: bigint,
  wallet: `0x${string}`,
): void {
  if (call.chainId !== binding.chainId) {
    throw new Error(
      `EVM call targets chain ${call.chainId}; this order is bound to ${binding.chainId}.`,
    );
  }

  if (same(call.to, binding.sourceToken)) {
    let decoded: ReturnType<typeof decodeFunctionData<typeof ERC20_APPROVE_ABI>>;
    try {
      decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data as `0x${string}` });
    } catch {
      throw new Error(
        "Only an approve() may be called on the source token; refusing this calldata.",
      );
    }
    const [spender, amount] = decoded.args;
    if (!APPROVAL_SPENDERS.some((known) => same(known, spender))) {
      throw new Error(
        `Approval names spender ${spender}, which is not a contract of the accepted route.`,
      );
    }
    if (amount > acceptedDepositUnits) {
      throw new Error(`Approval exceeds the accepted deposit: ${amount} > ${acceptedDepositUnits}`);
    }
    return;
  }

  if (same(call.to, LIFI_DIAMOND)) {
    assertLifiCallBound(call.data, binding, acceptedDepositUnits, wallet);
    return;
  }

  throw new Error(`EVM call targets ${call.to}, which is not a contract of the accepted route.`);
}

// ── LI.FI Diamond calldata ──────────────────────────────────────────
//
// Shapes verified against live li.quest /v1/quote responses and
// lifinance/contracts:
//   same-chain swap         swapTokens{Generic,SingleV3…,MultipleV3…}ERC20ToERC20
//   stable → on-chain BTC   {swapAnd,}startBridgeTokensViaLayerSwap
//   any other bridge        …ViaX(ILiFi.BridgeData, …) — read generically

const SWAP_DATA_COMPONENTS = [
  { name: "callTo", type: "address" },
  { name: "approveTo", type: "address" },
  { name: "sendingAssetId", type: "address" },
  { name: "receivingAssetId", type: "address" },
  { name: "fromAmount", type: "uint256" },
  { name: "callData", type: "bytes" },
  { name: "requiresDeposit", type: "bool" },
] as const;
const BRIDGE_DATA = {
  name: "bridgeData",
  type: "tuple",
  components: [
    { name: "transactionId", type: "bytes32" },
    { name: "bridge", type: "string" },
    { name: "integrator", type: "string" },
    { name: "referrer", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receiver", type: "address" },
    { name: "minAmount", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "hasSourceSwaps", type: "bool" },
    { name: "hasDestinationCall", type: "bool" },
  ],
} as const;
const LAYERSWAP_DATA = {
  name: "layerSwapData",
  type: "tuple",
  components: [
    { name: "requestId", type: "bytes32" },
    { name: "depositoryReceiver", type: "address" },
    { name: "refundRecipient", type: "address" },
    { name: "nonEVMReceiver", type: "bytes32" },
    { name: "signature", type: "bytes" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const SWAP_HEAD = [
  { name: "transactionId", type: "bytes32" },
  { name: "integrator", type: "string" },
  { name: "referrer", type: "string" },
  { name: "receiver", type: "address" },
  { name: "minAmountOut", type: "uint256" },
] as const;
const fn = <N extends string, I extends readonly unknown[]>(name: N, inputs: I) =>
  ({ type: "function", name, stateMutability: "payable", inputs, outputs: [] }) as const;
const LIFI_ABI = [
  fn("swapTokensGeneric", [
    ...SWAP_HEAD,
    { name: "swapData", type: "tuple[]", components: SWAP_DATA_COMPONENTS },
  ]),
  fn("swapTokensMultipleV3ERC20ToERC20", [
    ...SWAP_HEAD,
    { name: "swapData", type: "tuple[]", components: SWAP_DATA_COMPONENTS },
  ]),
  fn("swapTokensSingleV3ERC20ToERC20", [
    ...SWAP_HEAD,
    { name: "swapData", type: "tuple", components: SWAP_DATA_COMPONENTS },
  ]),
  fn("startBridgeTokensViaLayerSwap", [BRIDGE_DATA, LAYERSWAP_DATA]),
  fn("swapAndStartBridgeTokensViaLayerSwap", [
    BRIDGE_DATA,
    { name: "swapData", type: "tuple[]", components: SWAP_DATA_COMPONENTS },
    LAYERSWAP_DATA,
  ]),
] as const;

type LifiBridgeData = {
  sendingAssetId: `0x${string}`;
  receiver: `0x${string}`;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
};
type LifiSwapStep = {
  sendingAssetId: `0x${string}`;
  receivingAssetId: `0x${string}`;
  fromAmount: bigint;
  requiresDeposit: boolean;
};

/**
 * Every LI.FI bridge entry point (startBridgeTokensViaX, swapAndStartBridgeTokensViaX)
 * takes ILiFi.BridgeData as its first argument, and the swapAnd… variants take
 * LibSwap.SwapData[] second, so what it spends and where it pays are readable
 * without knowing the facet.
 */
function decodeLifiBridge(data: string): { bridge: LifiBridgeData; steps: LifiSwapStep[] } | null {
  const args = `0x${data.slice(10)}` as `0x${string}`;
  try {
    const [bridge] = decodeAbiParameters([BRIDGE_DATA], args);
    const typed = bridge as unknown as LifiBridgeData;
    if (!typed.hasSourceSwaps) return { bridge: typed, steps: [] };
    const [, steps] = decodeAbiParameters(
      [BRIDGE_DATA, { name: "swapData", type: "tuple[]", components: SWAP_DATA_COMPONENTS }],
      args,
    );
    return { bridge: typed, steps: steps as unknown as LifiSwapStep[] };
  } catch {
    return null;
  }
}

/**
 * What a LI.FI call takes from the wallet. The Diamond pulls `fromAmount` of
 * `sendingAssetId` for every swap step marked `requiresDeposit`, or, for a
 * bridge with no source swap, `minAmount` of `BridgeData.sendingAssetId`. Every
 * pulled asset must be this order's source token, and the total at most the
 * accepted deposit (the sweep: the detected balance) — so an allowance left on
 * another token, or a larger one on this token, can never be spent by it.
 */
function assertLifiSpendBound(
  steps: readonly LifiSwapStep[],
  bridge: LifiBridgeData | null,
  sourceToken: `0x${string}`,
  ceiling: bigint,
): void {
  const pulls: { asset: string; amount: bigint }[] =
    steps.length > 0
      ? steps
          .filter((step) => step.requiresDeposit)
          .map((step) => ({ asset: step.sendingAssetId, amount: step.fromAmount }))
      : bridge
        ? [{ asset: bridge.sendingAssetId, amount: bridge.minAmount }]
        : [];
  if (pulls.length === 0) throw new Error("LI.FI call spends nothing readable; refusing it.");
  let total = 0n;
  for (const pull of pulls) {
    if (!same(pull.asset, sourceToken)) {
      throw new Error(`LI.FI call spends ${pull.asset}, not this order's source token.`);
    }
    total += pull.amount;
  }
  if (total > ceiling) {
    throw new Error(`LI.FI call spends more than the accepted deposit: ${total} > ${ceiling}`);
  }
}

function assertLifiCallBound(
  data: string,
  binding: SwapKitV2EvmRouteBinding,
  ceiling: bigint,
  _wallet: `0x${string}`,
): void {
  const settle = binding.settle;
  if (!settle) throw new Error("This order has no committed recipient to bind a LI.FI call to.");

  // Same-chain swaps name their receiver directly.
  let decoded: { functionName: string; args: readonly unknown[] } | null = null;
  try {
    decoded = decodeFunctionData({ abi: LIFI_ABI, data: data as `0x${string}` }) as never;
  } catch {}
  if (decoded && decoded.functionName.startsWith("swapTokens")) {
    if (settle.kind !== "evm" || settle.chainId !== binding.chainId) {
      throw new Error("LI.FI same-chain swap does not match this order's settlement.");
    }
    const receiver = decoded.args[3] as `0x${string}`;
    if (!same(receiver, settle.receiver)) {
      throw new Error(`LI.FI swap pays ${receiver}, not the committed recipient.`);
    }
    const raw = decoded.args[5] as LifiSwapStep | readonly LifiSwapStep[];
    const steps = Array.isArray(raw) ? (raw as readonly LifiSwapStep[]) : [raw as LifiSwapStep];
    assertLifiSpendBound(steps, null, binding.sourceToken, ceiling);
    const last = steps[steps.length - 1];
    if (!last || !same(last.receivingAssetId, settle.token)) {
      throw new Error("LI.FI swap buys a token other than the committed settlement token.");
    }
    return;
  }

  // Every other LI.FI entry point is a bridge: ILiFi.BridgeData first, optional
  // source swaps second. That shape is shared by every facet, so no bridge is
  // named here — LI.FI adds and drops bridges freely.
  const decodedBridge = decodeLifiBridge(data);
  if (!decodedBridge) throw new Error("LI.FI call carries no readable destination; refusing it.");
  const { bridge, steps } = decodedBridge;
  if (bridge.hasDestinationCall) {
    throw new Error("LI.FI bridge carries a destination call; refusing it.");
  }
  if (settle.kind === "btc") {
    // A Bitcoin payout address is not carried in a uniform place (some
    // bridges keep it off-chain entirely), so the destination is bound by the
    // chain; the recipient is the server's order, as for every provider route.
    if (BigInt(bridge.destinationChainId) !== LIFI_BITCOIN_CHAIN_ID) {
      throw new Error(`LI.FI bridge pays out on chain ${bridge.destinationChainId}, not Bitcoin.`);
    }
    assertLifiSpendBound(steps, bridge, binding.sourceToken, ceiling);
    return;
  }
  if (Number(bridge.destinationChainId) !== settle.chainId) {
    throw new Error(
      `LI.FI bridge pays out on chain ${bridge.destinationChainId}, not the committed one.`,
    );
  }
  if (!same(bridge.receiver, settle.receiver)) {
    throw new Error(`LI.FI bridge pays ${bridge.receiver}, not the committed recipient.`);
  }
  assertLifiSpendBound(steps, bridge, binding.sourceToken, ceiling);
}

/** LI.FI's chain id for Bitcoin mainnet (its non-EVM chain registry). */
const LIFI_BITCOIN_CHAIN_ID = 20000000000001n;

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * LI.FI's bytes32 encoding of a Bitcoin receiver, reproduced from its own
 * output (golden vectors in the tests): bech32 → the witness-program 5-bit
 * words, base58 → the decoded payload; the last 32 bytes, left-padded.
 */
export function lifiNonEvmReceiverFor(address: string): string {
  let bytes: number[];
  const lower = address.toLowerCase();
  if (lower.startsWith("bc1")) {
    const data = lower.slice(3);
    const words = [...data].map((c) => {
      const v = BECH32_CHARSET.indexOf(c);
      if (v < 0) throw new Error("Invalid bech32 Bitcoin address.");
      return v;
    });
    // Drop the witness version (first word) and the 6-word checksum.
    bytes = words.slice(1, words.length - 6);
  } else {
    let n = 0n;
    for (const c of address) {
      const v = BASE58_ALPHABET.indexOf(c);
      if (v < 0) throw new Error("Invalid base58 Bitcoin address.");
      n = n * 58n + BigInt(v);
    }
    bytes = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    for (const c of address) {
      if (c !== "1") break;
      bytes.unshift(0);
    }
  }
  const tail = bytes.slice(-32);
  return `0x${tail
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .padStart(64, "0")}`;
}

// ── EIP-712 typed data ──────────────────────────────────────────────

const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

/**
 * Bind a server-requested EIP-712 signature to the committed route.
 *
 * The only signature a v2 route legitimately asks this wallet for is the CoW
 * `Order` (Gnosis Protocol v2 on Base) that sells the accepted deposit
 * (nuri-mcp-bitcoin-swapkit src/providers/cow.mjs). It is a spend
 * authorisation, so it must sell the accepted deposit (at most its amount),
 * buy the accepted token and pay the committed recipient (zero address = the
 * signer itself). The buy amount is the server's quote, not re-judged here.
 */
export function assertTypedDataBoundToRoute(
  request: { domain?: unknown; primaryType?: unknown; message?: unknown },
  bounds: {
    chainId?: number | null;
    sourceToken?: `0x${string}` | null;
    ceiling?: bigint | null;
    settle: SwapKitV2SettleBinding | null;
    wallet?: `0x${string}` | null;
  },
): "cow_order" {
  const domain = (request.domain ?? {}) as Record<string, unknown>;
  const message = (request.message ?? {}) as Record<string, unknown>;
  const settle = bounds.settle;
  const big = (value: unknown, field: string): bigint => {
    try {
      return BigInt(String(value));
    } catch {
      throw new Error(`Typed data carries an unreadable ${field}.`);
    }
  };
  if (request.primaryType !== "Order") {
    throw new Error(
      `Typed data ${String(request.primaryType || "(none)")} is not an order this route may sign.`,
    );
  }
  if (
    Number(domain.chainId) !== Number(bounds.chainId ?? 8453) ||
    domain.name !== "Gnosis Protocol" ||
    domain.version !== "v2" ||
    !same(String(domain.verifyingContract || ""), COW_SETTLEMENT)
  ) {
    throw new Error("Typed-data Order is not a CoW order on this order's chain.");
  }
  if (!settle || settle.kind !== "evm" || !bounds.sourceToken || bounds.ceiling == null) {
    throw new Error("A CoW order needs the accepted deposit and settlement to bind it.");
  }
  if (!same(String(message.sellToken || ""), bounds.sourceToken)) {
    throw new Error("CoW order sells a token other than the accepted deposit.");
  }
  const spend = big(message.sellAmount, "sellAmount") + big(message.feeAmount ?? 0, "feeAmount");
  if (spend > bounds.ceiling) {
    throw new Error(`CoW order sells ${spend}, above the accepted deposit ${bounds.ceiling}.`);
  }
  if (!same(String(message.buyToken || ""), settle.token)) {
    throw new Error("CoW order buys a token other than the accepted one.");
  }
  const rawReceiver = String(message.receiver || "");
  const receiver = /^0x0{40}$/i.test(rawReceiver) ? String(bounds.wallet || "") : rawReceiver;
  if (!same(receiver, settle.receiver)) {
    throw new Error("CoW order pays a receiver other than the committed recipient.");
  }
  return "cow_order";
}
