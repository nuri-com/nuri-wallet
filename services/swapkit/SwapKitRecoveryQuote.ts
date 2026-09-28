import { ARBITRUM_TBTC, BASE_EURC, IS_MAINNET } from "../../config/network";

export const RECOVERY_FIELDS = [
  ["txId", "string"],
  ["quoteId", "string"],
  ["owner", "address"],
  ["recipient", "address"],
  ["sourceChainId", "uint256"],
  ["sourceToken", "address"],
  ["sourceAmountUnits", "uint256"],
  ["expectedUsdcUnits", "uint256"],
  ["minimumUsdcUnits", "uint256"],
  ["maximumSellUsdcUnits", "uint256"],
  ["receiveChainId", "uint256"],
  ["receiveToken", "address"],
  ["expectedReceiveUnits", "uint256"],
  ["minimumReceiveUnits", "uint256"],
  ["expiresAt", "uint256"],
] as const;

export type SwapKitRecoveryQuote = {
  txId: string;
  quoteId: string;
  expiresAt: string;
  owner: string;
  recipient: string;
  sourceChainId: number;
  sourceToken: string;
  sourceAmountUnits: string;
  expectedUsdcUnits: string;
  minimumUsdcUnits: string;
  maximumSellUsdcUnits: string;
  expectedReceiveUnits: string;
  minimumReceiveUnits: string;
  receiveAsset: "EURC_BASE";
  typedData: {
    domain: { name: string; version: string; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
  };
};

export type SwapKitRecoveryAcceptance = {
  txId: string;
  quoteId: string;
  status: "ACCEPTED";
  clientBounds: Pick<
    SwapKitRecoveryQuote,
    | "owner"
    | "recipient"
    | "expectedUsdcUnits"
    | "maximumSellUsdcUnits"
    | "minimumReceiveUnits"
    | "receiveAsset"
  >;
};

export type SwapKitRecoveryConsent = {
  quote: SwapKitRecoveryQuote;
  signature: `0x${string}`;
  accepted?: SwapKitRecoveryAcceptance;
};

const address = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const keys = (value: object, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

/** Dedicated consent only. Never pass this payload to the generic/CoW signer. */
export function validateSwapKitRecoveryQuote(
  quote: SwapKitRecoveryQuote,
  expected: { txId: string; owner: string; recipient: string },
  allowExpired = false,
): void {
  const fail = () => {
    throw new Error("Invalid or expired recovery quote.");
  };
  if (!IS_MAINNET || !quote || !address(expected.owner) || !address(expected.recipient)) fail();
  const data = quote.typedData;
  if (!data || !data.domain || !data.types || !data.message) fail();
  if (
    !keys(data, ["domain", "types", "primaryType", "message"]) ||
    !keys(data.domain, ["name", "version", "chainId"]) ||
    data.domain.name !== "SwapKit Recovery" ||
    data.domain.version !== "1" ||
    data.domain.chainId !== 42161 ||
    data.primaryType !== "SwapRecovery" ||
    !keys(data.types, ["SwapRecovery"]) ||
    !keys(
      data.message,
      RECOVERY_FIELDS.map(([name]) => name),
    )
  )
    fail();
  const fields = data.types.SwapRecovery;
  if (
    !Array.isArray(fields) ||
    fields.length !== RECOVERY_FIELDS.length ||
    fields.some(
      (f, i) =>
        !keys(f, ["name", "type"]) ||
        f.name !== RECOVERY_FIELDS[i][0] ||
        f.type !== RECOVERY_FIELDS[i][1],
    )
  )
    fail();
  for (const [name, type] of RECOVERY_FIELDS) {
    const value = data.message[name];
    if (typeof value !== "string") fail();
    if (
      type === "uint256" &&
      (!/^[1-9][0-9]*$/.test(value) || value.length > 78 || BigInt(value) >= 2n ** 256n)
    )
      fail();
    if (type === "address" && !address(value)) fail();
  }
  if (
    quote.txId !== expected.txId ||
    !quote.txId ||
    !quote.quoteId ||
    !address(quote.owner) ||
    !same(quote.owner, expected.owner) ||
    !address(quote.recipient) ||
    !same(quote.recipient, expected.recipient) ||
    quote.sourceChainId !== 42161 ||
    !address(quote.sourceToken) ||
    !same(quote.sourceToken, ARBITRUM_TBTC.address) ||
    quote.receiveAsset !== "EURC_BASE" ||
    data.message.receiveChainId !== "8453" ||
    !same(data.message.receiveToken, BASE_EURC.address)
  )
    fail();
  for (const name of [
    "txId",
    "quoteId",
    "owner",
    "recipient",
    "sourceToken",
    "sourceAmountUnits",
    "expectedUsdcUnits",
    "minimumUsdcUnits",
    "maximumSellUsdcUnits",
    "expectedReceiveUnits",
    "minimumReceiveUnits",
  ] as const) {
    if (quote[name] !== data.message[name]) fail();
  }
  if (data.message.sourceChainId !== String(quote.sourceChainId)) fail();
  const expiry = Date.parse(quote.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== quote.expiresAt ||
    expiry % 1000 !== 0 ||
    BigInt(expiry / 1000) !== BigInt(data.message.expiresAt) ||
    (!allowExpired && expiry <= Date.now())
  )
    fail();
  if (
    BigInt(quote.minimumUsdcUnits) > BigInt(quote.expectedUsdcUnits) ||
    BigInt(quote.expectedUsdcUnits) > BigInt(quote.maximumSellUsdcUnits) ||
    BigInt(quote.minimumReceiveUnits) > BigInt(quote.expectedReceiveUnits)
  )
    fail();
}

export function validateRecoveryAcceptance(
  quote: SwapKitRecoveryQuote,
  result: SwapKitRecoveryAcceptance,
): void {
  if (
    !result ||
    result.txId !== quote.txId ||
    result.quoteId !== quote.quoteId ||
    result.status !== "ACCEPTED" ||
    !result.clientBounds ||
    !(
      [
        "owner",
        "recipient",
        "expectedUsdcUnits",
        "maximumSellUsdcUnits",
        "minimumReceiveUnits",
        "receiveAsset",
      ] as const
    ).every((key) => result.clientBounds[key] === quote[key])
  ) {
    throw new Error("Recovery acceptance does not match the displayed quote.");
  }
}
