import { formatUnits } from "viem";
import { getBaseRpcUrl } from "../../../lib/rpc/baseRpc";

export type AssetTransfer = {
  blockNumber: bigint;
  transactionHash: string;
  address: string;
  from: string;
  to: string;
  value: number;
};

type AlchemyTransferRaw = {
  hash?: string;
  blockNum?: string;
  from?: string;
  to?: string;
  value?: number | null;
  rawContract?: { address?: string; value?: string; decimal?: string };
};

type AlchemyTransfersParams = {
  fromBlock?: string;
  toBlock: string;
  toAddress?: string;
  fromAddress?: string;
  category: string[];
  excludeZeroValue: boolean;
  order: "asc" | "desc";
  contractAddresses?: string[];
  pageKey?: string;
};

async function fetchPageFor(
  url: string,
  direction: "to" | "from",
  address: string,
  fromBlockHex: string | undefined,
  toBlockHex: string,
  contractAddresses: string[] | undefined,
): Promise<AssetTransfer[]> {
  const out: AssetTransfer[] = [];
  let pageKey: string | undefined;
  while (true) {
    const params: AlchemyTransfersParams = {
      toBlock: toBlockHex,
      category: ["erc20"],
      excludeZeroValue: true,
      order: "desc",
    };
    if (fromBlockHex) params.fromBlock = fromBlockHex;
    if (direction === "to") params.toAddress = address;
    else params.fromAddress = address;
    if (contractAddresses && contractAddresses.length > 0) {
      params.contractAddresses = contractAddresses;
    }
    if (pageKey) params.pageKey = pageKey;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params],
      }),
    });
    if (!res.ok) {
      throw new Error(`alchemy_getAssetTransfers HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body?.error) {
      const msg = body.error?.message || "alchemy_getAssetTransfers RPC error";
      throw new Error(msg);
    }
    const transfers: AlchemyTransferRaw[] = Array.isArray(body?.result?.transfers)
      ? body.result.transfers
      : [];
    for (const t of transfers) {
      let value = typeof t.value === "number" ? t.value : Number.NaN;
      if (!Number.isFinite(value)) {
        const rawHex = t.rawContract?.value;
        const rawDec = t.rawContract?.decimal;
        if (rawHex && rawDec) {
          try {
            value = Number(formatUnits(BigInt(rawHex), Number(rawDec)));
          } catch {
            value = 0;
          }
        } else {
          value = 0;
        }
      }
      out.push({
        blockNumber: BigInt(t.blockNum ?? "0x0"),
        transactionHash: String(t.hash ?? ""),
        address: String(t.rawContract?.address || "").toLowerCase(),
        from: String(t.from || "").toLowerCase(),
        to: String(t.to || "").toLowerCase(),
        value,
      });
    }
    const nextPageKey = body?.result?.pageKey;
    if (typeof nextPageKey === "string" && nextPageKey.length > 0) {
      pageKey = nextPageKey;
    } else {
      break;
    }
  }
  return out;
}

export async function fetchAssetTransfers(opts: {
  direction: "to" | "from";
  address: string | string[];
  fromBlock?: bigint;
  toBlock?: bigint;
  contractAddresses?: string[];
  rpcUrl?: string;
}): Promise<AssetTransfer[]> {
  const url = opts.rpcUrl ?? getBaseRpcUrl();
  const addresses = Array.isArray(opts.address) ? opts.address : [opts.address];
  const fromBlockHex = opts.fromBlock != null ? `0x${opts.fromBlock.toString(16)}` : undefined;
  const toBlockHex = opts.toBlock != null ? `0x${opts.toBlock.toString(16)}` : "latest";
  try {
    const results = await Promise.all(
      addresses.map((addr) =>
        fetchPageFor(url, opts.direction, addr, fromBlockHex, toBlockHex, opts.contractAddresses),
      ),
    );
    return results.flat();
  } catch (e) {
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    console.log("[AlchemyTransfers] error", { message });
    throw e;
  }
}

export async function getAlchemyBaseBlockNumber(rpcUrl?: string): Promise<bigint> {
  const url = rpcUrl ?? getBaseRpcUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!res.ok) throw new Error(`eth_blockNumber HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(body.error?.message || "eth_blockNumber RPC error");
  return BigInt(body?.result ?? "0x0");
}
