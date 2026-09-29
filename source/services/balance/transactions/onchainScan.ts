import { createPublicClient, zeroAddress } from "viem";
import { BASE_CHAIN_ID, BASE_EURC, BASE_USDC } from "../../../config/network";
import { BASE_VIEM_CHAIN, getBaseRpcUrl, getBaseViemTransport } from "../../../lib/rpc/baseRpc";
import { findCurrencyByAddress } from "../../../lib/tokens";
import type { WalletTransactionRow } from "../../../types/wallet";
import { getCacheValue, setCacheValue } from "../TransactionCacheService";
import { fetchAssetTransfers, getAlchemyBaseBlockNumber } from "./alchemyTransfers";

type OnchainScanCache = {
  lastScannedBlock: string;
  rows: WalletTransactionRow[];
};

/**
 * The token whose transfers make up a rail's history. The wallet holds euro AND
 * dollar on the same address, so the token — not the address — is what separates
 * the two lists; scanning one and labelling it with the other's currency is how
 * the Dollar rail came to show euro rows.
 */
export type OnchainScanToken = {
  address: `0x${string}`;
  /** Fiat code for the rows this token produces, e.g. "EUR", "USD". */
  fiatCode: string;
};

// The Base EURC the wallet actually holds/sends (Circle on mainnet, Wirex
// settlement token on testnet).
export const EURC_SCAN_TOKEN: OnchainScanToken = {
  address: BASE_EURC.address,
  fiatCode: "EUR",
};

// The Base USDC the wallet and the card both hold. Named here rather than at
// each caller so the dollar history and the card's dollar deposits scan the
// same contract.
export const USDC_SCAN_TOKEN: OnchainScanToken = {
  address: BASE_USDC.address,
  fiatCode: "USD",
};

// Namespaced by the active Base chain id AND the token, so mainnet/testnet and
// euro/dollar never share a cursor or rows — one cursor for two token scans
// would let the first to run mark the second's blocks as already seen.
const getOnchainScanCacheKey = (walletAddrs: string[], token: OnchainScanToken) => {
  if (walletAddrs.length === 0) return "";
  const sorted = [...walletAddrs].sort();
  return `onchain:wallet:v5:base:${BASE_CHAIN_ID}:${token.address.toLowerCase()}:${sorted.join("|")}`;
};

export async function fetchOnchainWalletTransfers(args: {
  walletAddrs: string[];
  selfFilterAddrs: string[];
  /** Defaults to euro — every caller that predates the Dollar rail means EURC. */
  token?: OnchainScanToken;
  /**
   * Throw when the scan fails instead of answering with the cached rows. The
   * history sheets want the cache (something beats nothing); the export must
   * not pass off rows that may be missing the latest blocks as the full history.
   */
  strict?: boolean;
}): Promise<WalletTransactionRow[]> {
  const { walletAddrs, selfFilterAddrs } = args;
  const token = args.token ?? EURC_SCAN_TOKEN;
  if (walletAddrs.length === 0) return [];

  // Load cache up front (outside the outer try) so an RPC failure during the
  // scan returns the previously-known rows instead of wiping the cache via
  // the empty-merge path.
  const cacheKey = getOnchainScanCacheKey(walletAddrs, token);
  let cachedRows: WalletTransactionRow[] = [];
  let sinceBlock: bigint | null = null;
  if (cacheKey) {
    try {
      const cached = await getCacheValue<OnchainScanCache>(cacheKey);
      if (cached) {
        if (Array.isArray(cached.rows)) cachedRows = cached.rows;
        if (typeof cached.lastScannedBlock === "string" && cached.lastScannedBlock) {
          try {
            sinceBlock = BigInt(cached.lastScannedBlock);
          } catch {}
        }
      }
    } catch {}
  }

  try {
    const alchemyRpcUrl = getBaseRpcUrl();
    const publicClient = createPublicClient({
      chain: BASE_VIEM_CHAIN,
      transport: getBaseViemTransport({ batch: true }),
    });
    const latest = await getAlchemyBaseBlockNumber(alchemyRpcUrl);
    const fromBlock = sinceBlock != null ? sinceBlock + 1n : undefined;

    if (fromBlock != null && fromBlock > latest) {
      return cachedRows;
    }

    const [incomingLogs, outgoingLogs] = await Promise.all([
      fetchAssetTransfers({
        direction: "to",
        address: walletAddrs,
        fromBlock,
        toBlock: latest,
        contractAddresses: [token.address],
        rpcUrl: alchemyRpcUrl,
      }),
      fetchAssetTransfers({
        direction: "from",
        address: walletAddrs,
        fromBlock,
        toBlock: latest,
        contractAddresses: [token.address],
        rpcUrl: alchemyRpcUrl,
      }),
    ]);

    const blockNums = new Set<bigint>();
    incomingLogs.forEach((l) => blockNums.add(l.blockNumber));
    outgoingLogs.forEach((l) => blockNums.add(l.blockNumber));
    const blocks = await Promise.all(
      Array.from(blockNums).map((bn) => publicClient.getBlock({ blockNumber: bn })),
    );
    const tsMap = new Map<bigint, number>();
    blocks.forEach((b) => tsMap.set(b.number, Number(b.timestamp) * 1000));

    const newRows: WalletTransactionRow[] = [];
    const seenHashes = new Set<string>();

    for (const l of incomingLogs) {
      const amt = l.value;
      const ts = tsMap.get(l.blockNumber) ?? 0;
      const fromAddr = l.from;
      if (fromAddr === zeroAddress) continue;
      const toAddr = l.to;
      if (selfFilterAddrs.includes(fromAddr)) continue;
      const txHash = l.transactionHash;
      const txHashLower = txHash.toLowerCase();

      const logCurrency = findCurrencyByAddress(l.address);
      newRows.push({
        id: `chain:${l.transactionHash}:wallet_transfer_in`,
        kind: "wallet_transfer_in",
        state: "processed",
        // The token being scanned IS the currency. The registry only knows the
        // tokens with a deployment entry, and the home currency is unrelated to
        // what this row is denominated in.
        currency: (logCurrency?.fiatCode ?? token.fiatCode).toLowerCase(),
        amount: String(amt),
        counterpart: { identifier: { address: l.from } },
        meta: {
          placedAt: new Date(ts).toISOString(),
          txHash: l.transactionHash,
          source: "onchain_wallet",
          from: fromAddr,
          to: toAddr,
        },
      });
      if (txHashLower) {
        seenHashes.add(txHashLower);
      }
    }

    for (const l of outgoingLogs) {
      const fromAddr = l.from;
      const toAddr = l.to;
      if (toAddr === zeroAddress) continue;
      if (!fromAddr) continue;
      const txHash = l.transactionHash.toLowerCase();
      if (txHash && seenHashes.has(txHash)) continue;

      if (selfFilterAddrs.includes(toAddr)) continue;

      const logCurrency = findCurrencyByAddress(l.address);
      const amt = l.value;
      const ts = tsMap.get(l.blockNumber) ?? 0;

      newRows.push({
        id: `chain:${l.transactionHash}:wallet_transfer_out`,
        kind: "wallet_transfer_out",
        state: "processed",
        // The token being scanned IS the currency. The registry only knows the
        // tokens with a deployment entry, and the home currency is unrelated to
        // what this row is denominated in.
        currency: (logCurrency?.fiatCode ?? token.fiatCode).toLowerCase(),
        amount: String(amt),
        counterpart: { identifier: { address: l.to } },
        meta: {
          placedAt: new Date(ts).toISOString(),
          txHash: l.transactionHash,
          source: "onchain_wallet",
          from: fromAddr,
          to: toAddr,
        },
      });
      if (txHash) seenHashes.add(txHash);
    }

    // Merge new rows with cached rows, dedupe by id
    const byId = new Map<string, WalletTransactionRow>();
    for (const row of cachedRows) {
      const id = row?.id;
      if (id) byId.set(id, row);
    }
    for (const row of newRows) {
      const id = row?.id;
      if (id) byId.set(id, row);
    }
    const mergedRows = Array.from(byId.values());

    if (cacheKey) {
      try {
        await setCacheValue<OnchainScanCache>(cacheKey, {
          lastScannedBlock: latest.toString(),
          rows: mergedRows,
        });
      } catch {}
    }

    return mergedRows;
  } catch (e) {
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    console.log("[OnchainScan] fetchOnchainWalletTransfers error", { message });
    if (args.strict) throw e instanceof Error ? e : new Error(message);
    return cachedRows;
  }
}
