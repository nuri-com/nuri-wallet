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
import {
  decodeAbiParameters,
  decodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import { swapKitStableToken } from "./SwapKitStableAssets";

/** LI.FI Diamond: both the approval spender and the swap/bridge-call target. */
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as const;
/** CoW Protocol Vault Relayer: approval spender only; the order is a signature. */
const COW_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;
const APPROVAL_SPENDERS = [LIFI_DIAMOND, COW_VAULT_RELAYER] as const;

/**
 * LI.FI Permit2Proxy per chain: the target of the EIP-2612 permit option
 * (callDiamondWithEIP2612Signature) and the spender its permit names. Taken
 * from GET https://li.quest/v1/chains, field `permit2Proxy`, for every chain
 * this wallet signs EVM calls on (the sweep chains, which include every pay
 * link chain). A chain missing here has no permit option.
 */
const LIFI_PERMIT2_PROXY: Readonly<Record<number, `0x${string}`>> = {
  1: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  10: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  56: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  100: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  137: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  8453: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  42161: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
  43114: "0x89c6340B1a1f4b25D36cd8B063D49045caF3f818",
};

const LIFI_PERMIT2_PROXY_ABI = parseAbi([
  "function callDiamondWithEIP2612Signature(address tokenAddress,uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s,bytes diamondCalldata) payable returns (bytes)",
]);

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
 *   call to the LI.FI            → only callDiamondWithEIP2612Signature, on
 *   Permit2Proxy                   the source token, at most the accepted
 *                                  deposit, wrapping a Diamond call that
 *                                  passes the Diamond rule above
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

  const proxy = LIFI_PERMIT2_PROXY[binding.chainId];
  if (proxy && same(call.to, proxy)) {
    assertLifiPermitCallBound(call.data, binding, acceptedDepositUnits, wallet);
    return;
  }

  throw new Error(`EVM call targets ${call.to}, which is not a contract of the accepted route.`);
}

/**
 * The LI.FI permit option: one transaction to the Permit2Proxy, which uses the
 * signed EIP-2612 permit to pull `amount` of `tokenAddress` and then calls the
 * Diamond with `diamondCalldata`. Only that one function is accepted (any
 * other, e.g. callDiamondWithPermit2, is refused); it must pull this order's
 * source token, at most the accepted deposit, and the inner Diamond call must
 * pass exactly the same check a direct Diamond call does.
 */
function assertLifiPermitCallBound(
  data: string,
  binding: SwapKitV2EvmRouteBinding,
  ceiling: bigint,
  wallet: `0x${string}`,
): void {
  let args: readonly [
    `0x${string}`,
    bigint,
    bigint,
    number,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
  ];
  try {
    const decoded = decodeFunctionData({
      abi: LIFI_PERMIT2_PROXY_ABI,
      data: data as `0x${string}`,
    });
    args = decoded.args;
  } catch {
    throw new Error(
      "Only callDiamondWithEIP2612Signature may be called on the LI.FI Permit2Proxy; refusing this calldata.",
    );
  }
  const [tokenAddress, amount, , , , , diamondCalldata] = args;
  if (!same(tokenAddress, binding.sourceToken)) {
    throw new Error(`LI.FI permit call pulls ${tokenAddress}, not this order's source token.`);
  }
  if (amount > ceiling) {
    throw new Error(
      `LI.FI permit call pulls more than the accepted deposit: ${amount} > ${ceiling}`,
    );
  }
  // Permit2Proxy pulls `amount` into itself and hands the Diamond only what the inner call spends;
  // it does not refund the rest. The two must be equal, or the difference is stranded.
  const innerSpend = assertLifiCallBound(diamondCalldata, binding, ceiling, wallet);
  if (innerSpend !== amount) {
    throw new Error(
      `LI.FI permit call pulls ${amount} but its swap spends ${innerSpend}; refusing a call that strands the difference.`,
    );
  }
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
): bigint {
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
  return total;
}

function assertLifiCallBound(
  data: string,
  binding: SwapKitV2EvmRouteBinding,
  ceiling: bigint,
  _wallet: `0x${string}`,
): bigint {
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
    const spent = assertLifiSpendBound(steps, null, binding.sourceToken, ceiling);
    const last = steps[steps.length - 1];
    if (!last || !same(last.receivingAssetId, settle.token)) {
      throw new Error("LI.FI swap buys a token other than the committed settlement token.");
    }
    return spent;
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
    return assertLifiSpendBound(steps, bridge, binding.sourceToken, ceiling);
  }
  if (Number(bridge.destinationChainId) !== settle.chainId) {
    throw new Error(
      `LI.FI bridge pays out on chain ${bridge.destinationChainId}, not the committed one.`,
    );
  }
  if (!same(bridge.receiver, settle.receiver)) {
    throw new Error(`LI.FI bridge pays ${bridge.receiver}, not the committed recipient.`);
  }
  return assertLifiSpendBound(steps, bridge, binding.sourceToken, ceiling);
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
 *
 * The second is an EIP-2612 `Permit` on the source token (the permit options:
 * LI.FI through its Permit2Proxy, CoW through a pre-hook in the order's
 * appData). It replaces the approve transaction, so it is held to the approve
 * rules — see assertPermitBound.
 */
export function assertTypedDataBoundToRoute(
  request: {
    domain?: unknown;
    types?: unknown;
    primaryType?: unknown;
    message?: unknown;
    appData?: unknown;
  },
  bounds: {
    chainId?: number | null;
    sourceToken?: `0x${string}` | null;
    ceiling?: bigint | null;
    settle: SwapKitV2SettleBinding | null;
    wallet?: `0x${string}` | null;
  },
): "cow_order" | "permit" {
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
  if (request.primaryType === "Permit") {
    assertPermitBound(request, bounds);
    return "permit";
  }
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
  assertCowAppDataBound(request.appData, message, {
    chainId: Number(bounds.chainId ?? 8453),
    sourceToken: bounds.sourceToken,
    ceiling: bounds.ceiling,
    wallet: bounds.wallet ?? null,
    spend,
  });
  return "cow_order";
}

const ZERO_APP_DATA = `0x${"00".repeat(32)}`;
const PERMIT_CALL_ABI = parseAbi([
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
]);

/**
 * A CoW order commits to its appData only by hash. The zero hash (the approve
 * route) carries nothing. Any other hash must come with the canonical JSON it
 * hashes, and that JSON may hold exactly one thing: a pre-hook that calls
 * permit() on the source token for this wallet, to the Vault Relayer, covering
 * the order and not outliving the deadline rules. Anything else in it (post
 * hooks, partner fees, other metadata) is refused, because the wallet cannot
 * see what it would do.
 */
function assertCowAppDataBound(
  appDataJson: unknown,
  message: Record<string, unknown>,
  bounds: {
    chainId: number;
    sourceToken: `0x${string}`;
    ceiling: bigint;
    wallet: `0x${string}` | null;
    spend: bigint;
  },
): void {
  // No appData field commits to nothing (an Order without it cannot even be
  // EIP-712 encoded); the zero hash is the approve route's empty document.
  if (message.appData == null) return;
  const hash = String(message.appData).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("CoW order carries an unreadable appData.");
  if (hash === ZERO_APP_DATA) return;
  if (typeof appDataJson !== "string" || appDataJson.length === 0) {
    throw new Error("CoW order commits to appData the server did not show; refusing to sign it.");
  }
  if (keccak256(toHex(appDataJson)).toLowerCase() !== hash) {
    throw new Error("CoW order appData does not hash to the JSON the server sent.");
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(appDataJson) as Record<string, unknown>;
  } catch {
    throw new Error("CoW order appData is not readable JSON.");
  }
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => key !== "hooks")) {
    throw new Error("CoW order appData carries metadata other than the permit hook.");
  }
  const hooks = (metadata.hooks ?? {}) as Record<string, unknown>;
  if (Object.keys(hooks).some((key) => key !== "version" && key !== "pre" && key !== "post")) {
    throw new Error("CoW order appData carries an unknown hooks field.");
  }
  if (Array.isArray(hooks.post) ? hooks.post.length > 0 : hooks.post != null) {
    throw new Error("CoW order appData carries a post-hook; refusing it.");
  }
  const pre = hooks.pre;
  if (!Array.isArray(pre) || pre.length !== 1) {
    throw new Error("CoW order appData must carry exactly one pre-hook (the permit).");
  }
  const hook = (pre[0] ?? {}) as Record<string, unknown>;
  if (!same(String(hook.target || ""), bounds.sourceToken)) {
    throw new Error("CoW pre-hook does not call this order's source token.");
  }
  let args: readonly [
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint,
    number,
    `0x${string}`,
    `0x${string}`,
  ];
  try {
    args = decodeFunctionData({
      abi: PERMIT_CALL_ABI,
      data: String(hook.callData || "") as `0x${string}`,
    }).args;
  } catch {
    throw new Error("CoW pre-hook is not a permit() call; refusing it.");
  }
  const [owner, spender, value, deadline] = args;
  if (!bounds.wallet || !same(owner, bounds.wallet)) {
    throw new Error("CoW permit hook is not for this wallet.");
  }
  if (!same(spender, COW_VAULT_RELAYER)) {
    throw new Error(`CoW permit hook names spender ${spender}, not the CoW Vault Relayer.`);
  }
  if (value > bounds.ceiling) {
    throw new Error(
      `CoW permit hook value ${value} is above the accepted deposit ${bounds.ceiling}.`,
    );
  }
  if (value < bounds.spend) {
    throw new Error(`CoW permit hook value ${value} does not cover the order's ${bounds.spend}.`);
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) throw new Error("CoW permit hook deadline has already passed.");
  if (deadline > now + BigInt(PERMIT_MAX_LIFETIME_SECONDS + PERMIT_CLOCK_SKEW_SECONDS)) {
    throw new Error("CoW permit hook deadline is more than an hour away.");
  }
  const validTo = typedUint(message.validTo, "validTo");
  if (validTo > deadline) {
    throw new Error("CoW order outlives its permit hook; refusing it.");
  }
}

/** An EIP-712 uint as an exact bigint (decimal or 0x hex), never via a float. */
function typedUint(value: unknown, field: string): bigint {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(text)) {
    throw new Error(`Typed data carries an unreadable ${field}.`);
  }
  return BigInt(text);
}

/** The EIP-2612 Permit struct, field for field. */
const EIP2612_PERMIT_FIELDS = [
  ["owner", "address"],
  ["spender", "address"],
  ["value", "uint256"],
  ["nonce", "uint256"],
  ["deadline", "uint256"],
] as const;

/** A permit is signed for a few minutes' use; one valid for longer than this
 * (plus a little clock skew) is an allowance nobody asked for. */
const PERMIT_MAX_LIFETIME_SECONDS = 60 * 60;
const PERMIT_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * An EIP-2612 permit, bound like the approve it replaces:
 *   - the struct is exactly EIP-2612 `Permit` (no extra types)
 *   - domain.verifyingContract is this order's source token
 *   - domain.chainId is this order's chain
 *   - owner is this wallet
 *   - spender is the LI.FI Permit2Proxy of this chain or the CoW Vault Relayer
 *   - value is at most the accepted deposit
 *   - the deadline is in the future and at most about an hour away
 */
function assertPermitBound(
  request: { domain?: unknown; types?: unknown; message?: unknown },
  bounds: {
    chainId?: number | null;
    sourceToken?: `0x${string}` | null;
    ceiling?: bigint | null;
    wallet?: `0x${string}` | null;
  },
): void {
  const domain = (request.domain ?? {}) as Record<string, unknown>;
  const types = (request.types ?? {}) as Record<string, unknown>;
  const message = (request.message ?? {}) as Record<string, unknown>;

  const fields = types.Permit;
  const structOk =
    Array.isArray(fields) &&
    fields.length === EIP2612_PERMIT_FIELDS.length &&
    EIP2612_PERMIT_FIELDS.every(([name, type], i) => {
      const field = (fields[i] ?? {}) as Record<string, unknown>;
      return field.name === name && field.type === type;
    }) &&
    Object.keys(types).every((key) => key === "Permit" || key === "EIP712Domain");
  if (!structOk) throw new Error("Typed-data Permit is not the EIP-2612 permit struct.");

  if (bounds.chainId == null || !bounds.sourceToken || bounds.ceiling == null) {
    throw new Error(
      "A permit needs the order's chain, source token and accepted deposit to bind it.",
    );
  }
  if (!same(String(domain.verifyingContract || ""), bounds.sourceToken)) {
    throw new Error("Permit is not on this order's source token.");
  }
  if (Number(domain.chainId) !== bounds.chainId) {
    throw new Error(`Permit is for chain ${String(domain.chainId)}, not this order's chain.`);
  }
  if (!bounds.wallet || !same(String(message.owner || ""), bounds.wallet)) {
    throw new Error("Permit owner is not this wallet.");
  }
  const spender = String(message.spender || "");
  const proxy = LIFI_PERMIT2_PROXY[bounds.chainId];
  if (!(proxy && same(spender, proxy)) && !same(spender, COW_VAULT_RELAYER)) {
    throw new Error(
      `Permit names spender ${spender}, which is not a contract of the accepted route.`,
    );
  }
  const value = typedUint(message.value, "value");
  if (value > bounds.ceiling) {
    throw new Error(`Permit value ${value} is above the accepted deposit ${bounds.ceiling}.`);
  }
  typedUint(message.nonce, "nonce");
  const deadline = typedUint(message.deadline, "deadline");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) throw new Error("Permit deadline has already passed.");
  if (deadline > now + BigInt(PERMIT_MAX_LIFETIME_SECONDS + PERMIT_CLOCK_SKEW_SECONDS)) {
    throw new Error("Permit deadline is more than an hour away; refusing a long-lived allowance.");
  }
}
