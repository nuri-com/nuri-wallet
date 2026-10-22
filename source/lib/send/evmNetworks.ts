// lib/send/evmNetworks.ts
// The EVM networks a send can name in front of an address (`arb1:0x...`,
// #1783). Base is paid directly; every other one is reached by swapping Euro or
// Dollar into that network's stable on the way (SwapKit), so Bitcoin cannot pay
// them. Keys are ERC-3770 short names plus the spellings people type.

/** Network a Destination names -> the stable a send settles there (null = Base, paid directly). */
export const SEND_EVM_NETWORK_ASSET: Readonly<Record<string, string | null>> = {
  base: null,
  ethereum: "USDC_ETH",
  arbitrum: "USDC_ARBITRUM",
  polygon: "USDC_POLYGON",
  optimism: "USDC_OPTIMISM",
  gnosis: "EURE_GNOSIS",
};

const PREFIX_NETWORK: Readonly<Record<string, string>> = {
  base: "base",
  eth: "ethereum",
  mainnet: "ethereum",
  arb1: "arbitrum",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  pol: "polygon",
  matic: "polygon",
  polygon: "polygon",
  oeth: "optimism",
  op: "optimism",
  optimism: "optimism",
  gno: "gnosis",
  gnosis: "gnosis",
  xdai: "gnosis",
};

const CHAIN_NETWORK: Readonly<Record<number, string>> = {
  1: "ethereum",
  10: "optimism",
  100: "gnosis",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
};

/** A destination whose EVM network was named (`base:0x...`, a Base token,
 * `arb1:0x...`): paid exactly there, never swapped for a contact's other
 * addresses. */
export const namesEvmNetwork = (destination: {
  type: string;
  network?: string;
}): boolean =>
  destination.type === "crypto" &&
  destination.network !== undefined &&
  Object.prototype.hasOwnProperty.call(SEND_EVM_NETWORK_ASSET, destination.network);

/** The network a typed prefix names, or null. */
// Own keys only: a typed or saved "constructor" must not reach Object's prototype.
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | null =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;

export const networkOfPrefix = (prefix: string): string | null =>
  own(PREFIX_NETWORK, prefix.trim().toLowerCase());

/** The network an EVM chain id names, or null. */
export const networkOfChainId = (chainId: number): string | null =>
  own(CHAIN_NETWORK, String(chainId));

/** The stable a send to this (non-Base) network settles in, or null. */
export const settleAssetOfNetwork = (network: string): string | null =>
  own(SEND_EVM_NETWORK_ASSET, network);
