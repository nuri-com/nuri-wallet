import { BASE_EURC, BASE_USDC } from "../../config/network";

// The wallet-action shapes and fail-closed parsers the SwapKit v2 executors
// sign with. There is no v1 transport left: every swap, sweep and recovery
// runs on SwapKit v2 (SwapKitV2Service).

export { claimSwapLoop, releaseSwapLoop } from "./SwapKitLoopRegistry";

export type SwapKitActionApproval = {
  token?: string;
  spender?: string;
  amount?: string;
  [key: string]: unknown;
};

export type SwapKitActionTx = {
  to?: string;
  data?: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
  chainId?: number;
  from?: string;
  [key: string]: unknown;
};

export type SwapKitTypedData = {
  domain?: {
    name?: string;
    version?: string;
    chainId?: number | string;
    verifyingContract?: string;
    [key: string]: unknown;
  };
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

// One typed step of a wallet-assisted route. The server prepares payloads;
// only the wallet's signature or payment moves funds. Create-time actions are
// a PREVIEW — the signable action arrives freshly rebuilt via swap_track.
export type SwapKitAction = {
  type?: string;
  // pay_lightning_invoice
  invoice?: string;
  amountBtc?: number | string;
  deadline?: number | string;
  // sign_and_broadcast_evm_tx
  chainId?: number;
  tx?: SwapKitActionTx;
  approval?: SwapKitActionApproval;
  // sign_typed_data
  actionId?: string;
  typedData?: SwapKitTypedData;
  expiresAt?: string;
  rebuiltAt?: string;
  provider?: string;
  operation?: string;
  externalId?: string;
  request?: Record<string, unknown>;
  note?: string;
  after?: { leg?: number; status?: string; [key: string]: unknown };
  [key: string]: unknown;
};

function hexOrDecToBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  const str = String(value ?? "").trim();
  if (!str) throw new Error(`SwapKit action tx is missing ${field}`);
  try {
    return BigInt(str);
  } catch {
    throw new Error(`SwapKit action tx has an invalid ${field}: ${str}`);
  }
}

export type ParsedSwapActionTx = {
  // Chain the guard validated the action against — the signer dispatch keys
  // off this, never off the raw action.
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasLimit?: bigint;
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  // Signer the server bound the action to; the broadcaster must refuse to
  // sign it from any other account.
  from?: `0x${string}`;
};

export const BASE_MAINNET_CHAIN_ID = 8453;
const DEFAULT_APPROVAL_TOKENS: Record<number, readonly string[]> = {
  [BASE_MAINNET_CHAIN_ID]: [BASE_USDC.address.toLowerCase(), BASE_EURC.address.toLowerCase()],
};
const COW_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";

export type ParsedSwapTypedDataAction = {
  actionId: string;
  chainId: 8453;
  typedData: Required<Pick<SwapKitTypedData, "domain" | "types" | "primaryType" | "message">>;
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  expiresAt?: string;
};

function parseActionApproval(
  raw: SwapKitActionApproval | undefined,
): ParsedSwapActionTx["approval"] {
  if (!raw) return undefined;
  const token = String(raw.token || "");
  const spender = String(raw.spender || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
    throw new Error("SwapKit action approval has an invalid token or spender.");
  }
  return {
    token: token as `0x${string}`,
    spender: spender as `0x${string}`,
    amount: hexOrDecToBigInt(raw.amount, "approval amount"),
  };
}

/** Fail-closed guardian for CoW's Base-mainnet EIP-712 order. */
export function parseSwapTypedDataAction(action: SwapKitAction): ParsedSwapTypedDataAction {
  const actionId = String(action.actionId || "").trim();
  if (!actionId) throw new Error("SwapKit typed-data action is missing actionId.");
  const typedData = action.typedData;
  const domain = typedData?.domain;
  const chainId = Number(action.chainId ?? domain?.chainId);
  if (
    chainId !== BASE_MAINNET_CHAIN_ID ||
    Number(domain?.chainId) !== BASE_MAINNET_CHAIN_ID ||
    String(domain?.name) !== "Gnosis Protocol" ||
    String(domain?.version) !== "v2" ||
    String(domain?.verifyingContract || "").toLowerCase() !== COW_SETTLEMENT
  ) {
    throw new Error("SwapKit typed-data action is not a CoW order on Base mainnet.");
  }
  if (typedData?.primaryType !== "Order" || !typedData.types?.Order || !typedData.message) {
    throw new Error("SwapKit typed-data action has an invalid CoW Order payload.");
  }
  for (const field of ["sellToken", "buyToken", "receiver"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(typedData.message[field] || ""))) {
      throw new Error(`SwapKit CoW order has an invalid ${field}.`);
    }
  }
  for (const field of ["sellAmount", "buyAmount"] as const) {
    if (hexOrDecToBigInt(typedData.message[field], field) <= 0n) {
      throw new Error(`SwapKit CoW order has a non-positive ${field}.`);
    }
  }
  const expiresAt = action.expiresAt;
  if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
    throw new Error("SwapKit typed-data action expired before signing.");
  }
  return {
    actionId,
    chainId: BASE_MAINNET_CHAIN_ID,
    typedData: {
      domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    },
    approval: parseActionApproval(action.approval),
    expiresAt,
  };
}

/** Validate + convert a sign_and_broadcast_evm_tx action into broadcastable fields. */
export function parseSwapActionTx(
  action: SwapKitAction,
  // Guardian default stays Base-only — a missing or foreign chainId must
  // never reach the wallet key. Only the sweep/discovered runner widens this
  // to Arbitrum (its converts execute on the source chain).
  allowedChains: readonly number[] = [BASE_MAINNET_CHAIN_ID],
  allowedApprovalTokens?: readonly string[],
): ParsedSwapActionTx {
  const tx = action.tx;
  const chainId = Number(action.chainId ?? tx?.chainId);
  if (!allowedChains.includes(chainId)) {
    throw new Error(
      `SwapKit action targets chain ${action.chainId ?? tx?.chainId ?? "unknown"}; allowed here: ${allowedChains.join(", ")}.`,
    );
  }
  const to = String(tx?.to || "");
  const data = String(tx?.data || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("SwapKit action tx has an invalid `to`.");
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 4) {
    throw new Error("SwapKit action tx has invalid calldata.");
  }
  const value = tx?.value == null ? 0n : hexOrDecToBigInt(tx.value, "value");
  // Stablecoin legs never send ETH; a non-zero value can only drain gas funds.
  if (value !== 0n) throw new Error("SwapKit action tx carries a non-zero value.");
  const from = tx?.from == null ? undefined : String(tx.from);
  if (from != null && !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    throw new Error("SwapKit action tx has an invalid `from`.");
  }
  const gasLimit = tx?.gasLimit == null ? undefined : hexOrDecToBigInt(tx.gasLimit, "gasLimit");
  const approval = parseActionApproval(action.approval);
  if (approval) {
    // The spender must be the called contract, and the token must be bound by
    // the local flow: canonical wallet assets for normal Base actions, or the
    // exact contract persisted from the read-only sweep balance scan.
    if (approval.spender.toLowerCase() !== to.toLowerCase()) {
      throw new Error("SwapKit approval spender is not the transaction target.");
    }
    const allowedTokens = (allowedApprovalTokens ?? DEFAULT_APPROVAL_TOKENS[chainId] ?? []).map(
      (token) => token.toLowerCase(),
    );
    if (!allowedTokens.includes(approval.token.toLowerCase())) {
      throw new Error("SwapKit approval token is not bound to the swept asset.");
    }
  }
  return {
    chainId,
    to: to as `0x${string}`,
    data: data as `0x${string}`,
    value,
    gasLimit,
    approval,
    from: from as `0x${string}` | undefined,
  };
}

/**
 * Post-mining integrity check used by the Base signer: the transaction the
 * chain reports for our hash must equal what the wallet signed.
 */
export function assertMinedTxMatchesSigned(
  signed: { to: `0x${string}`; data: `0x${string}`; value: bigint; from: `0x${string}` },
  mined: {
    to?: string | null;
    input?: string;
    value?: bigint;
    from?: string;
    chainId?: number;
  },
): void {
  const mismatch =
    String(mined.to || "").toLowerCase() !== signed.to.toLowerCase() ||
    String(mined.from || "").toLowerCase() !== signed.from.toLowerCase() ||
    String(mined.input || "").toLowerCase() !== signed.data.toLowerCase() ||
    (mined.value ?? -1n) !== signed.value ||
    (mined.chainId != null && Number(mined.chainId) !== BASE_MAINNET_CHAIN_ID);
  if (mismatch) {
    throw new Error("Mined transaction does not match the signed payload.");
  }
}
