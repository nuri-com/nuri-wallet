// A Bitcoin deposit the wallet signed and recorded, whose broadcast outcome is unknown.
//
// The card top-up writes the order together with its exact signed deposit transaction BEFORE it
// broadcasts it (the row carries the funding status). A broadcast can be accepted by the network and
// still fail to answer, and the app can die right after sending it. Either way the order sits in the
// funding state with the transaction that may already be on the network.
//
// This module settles that row without ever paying twice. It asks the chain about THAT transaction,
// and if the chain does not know it, broadcasts THAT transaction again. A transaction carries its own
// inputs, so re-sending it can only confirm the one payment. It can never make a second one. Once the
// chain knows it, the row becomes the funded order it describes and the normal tracker takes over.
// When neither step can prove anything, the row stays in the funding state for the next start.

import type { SwapKitOrder } from "./SwapKitOrderStore";

export type SignedDepositDeps = {
  /** Resolves when the chain knows the transaction (mempool or block), rejects otherwise. */
  getTransactionStatus: (txid: string) => Promise<unknown>;
  /** Broadcasts a raw transaction and resolves with its txid. */
  broadcastTransaction: (rawHex: string) => Promise<string>;
  saveOrder: (order: SwapKitOrder) => Promise<void>;
  log: (message: string) => void;
};

/** A funding-state order whose signed deposit is on record. */
export function hasRecordedSignedDeposit(order: SwapKitOrder): boolean {
  const recovery = order.recovery;
  return Boolean(
    recovery?.status === "FUNDING" &&
      typeof recovery.depositRawTx === "string" &&
      recovery.depositRawTx.length > 0 &&
      typeof recovery.depositTxHash === "string" &&
      recovery.depositTxHash.length > 0,
  );
}

/** "Already known" answers mean the transaction is out there, which is all this needs to know. */
function isAlreadyKnown(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    text.includes("already confirmed") ||
    text.includes("already in block chain") ||
    text.includes("txn-already-known") ||
    text.includes("txn-already-in-mempool")
  );
}

/**
 * Settle one recorded deposit. Returns the funded order when the chain has (or now has) the
 * transaction, or null when its outcome is still unknown and the row must stay as it is.
 */
export async function settleRecordedDeposit(
  order: SwapKitOrder,
  deps: SignedDepositDeps,
): Promise<SwapKitOrder | null> {
  if (!hasRecordedSignedDeposit(order)) return null;
  const recovery = order.recovery ?? {};
  const txid = String(recovery.depositTxHash);
  let onChain = false;
  try {
    await deps.getTransactionStatus(txid);
    onChain = true;
  } catch {
    // Unknown to the chain, or the lookup failed: either way the recorded transaction is the only
    // one that may be sent, so it is sent again below.
  }
  if (!onChain) {
    try {
      const sent = await deps.broadcastTransaction(String(recovery.depositRawTx));
      if (String(sent).trim().toLowerCase() !== txid.toLowerCase()) {
        deps.log(`rebroadcast answered another txid order=${order.txId}`);
        return null;
      }
      onChain = true;
    } catch (error) {
      if (!isAlreadyKnown(error)) {
        deps.log(
          `deposit outcome still unknown, row kept order=${order.txId} err=${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
      onChain = true;
    }
  }
  const { status: _funding, depositRawTx: _raw, ...rest } = recovery;
  const funded: SwapKitOrder = { ...order, recovery: rest };
  await deps.saveOrder(funded);
  deps.log(`recorded deposit is on chain, order resumes order=${order.txId}`);
  return funded;
}
