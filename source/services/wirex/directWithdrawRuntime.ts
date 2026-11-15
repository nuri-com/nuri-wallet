// The device side of a direct card withdrawal (#1956): the Base RPC, the
// wallet key and the gas dripper, wired into services/wirex/directWithdraw.ts.
// Kept apart so the flow itself stays testable without any of them.

import { createPublicClient, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_CHAIN_ID, WIREX_CONTRACT_REGISTRY } from "../../config/network";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { BASE_VIEM_CHAIN, getBaseViemTransport } from "../../lib/rpc/baseRpc";
import { getPrivateKey } from "../../lib/secureKeyStorage";
import type { DirectWithdrawRecord } from "../../lib/wirex/directWithdraw";
import { ensureBaseMainnetGas } from "../base/BaseTokenTransferService";
import type { DirectWithdrawDeps } from "./directWithdraw";

async function loadWalletAccount(): Promise<LocalAccount> {
  const keyBytes = await getPrivateKey("ethereum");
  try {
    return privateKeyToAccount(`0x${bytesToHex(keyBytes)}`);
  } finally {
    zeroize(keyBytes);
  }
}

export function directWithdrawDeps({
  writeRecord,
  clearRecord,
  unconfirmed,
  trace,
}: {
  writeRecord: (record: DirectWithdrawRecord) => Promise<void>;
  clearRecord: () => Promise<void>;
  unconfirmed: () => Error;
  trace?: (label: string, data?: unknown) => void;
}): DirectWithdrawDeps {
  // Alchemy first, the public Base node after it. Failing over mid-run is safe
  // here: every send is one already-signed transaction, resent as is.
  const publicClient = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ retryCount: 2, timeout: 15_000 }),
  });
  return {
    publicClient,
    chainId: BASE_CHAIN_ID,
    registry: WIREX_CONTRACT_REGISTRY,
    loadAccount: loadWalletAccount,
    ensureGas: (address: Address, minWei: bigint) =>
      ensureBaseMainnetGas(address, { awaitConfirmation: true, minWei }),
    writeRecord,
    clearRecord,
    unconfirmed,
    trace,
  };
}
