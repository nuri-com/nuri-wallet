// Top-ups from another wallet that earlier versions started. The app no longer
// starts them (the wallet connection lives only on the public pay page now), but
// a payment already sent still lands, so its incoming row is still settled from
// its own pay record: the order's status, or the transfer's receipt.
import { withFallback } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import {
  asSwapKitV2OrderId,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
} from "../swapkit/SwapKitV2Service";
import type { PayWalletRecord } from "./PayWalletSwapService";

/**
 * Where a top-up stands, read from its own pay record: null when it cannot be
 * told right now, "gone" when the record is cleared (its drive finished it).
 * An outcome read here is authoritative, so the record goes with it: a
 * payment that ended while the app was closed must not hold the next one.
 */
export async function walletTopUpState(
  key: string,
): Promise<"pending" | "completed" | "failed" | "gone" | null> {
  let record: PayWalletRecord | null;
  try {
    record = await getCacheValue<PayWalletRecord>(key);
  } catch {
    return null;
  }
  if (!record) return "gone";
  // Nothing can drive it any more (the app no longer resumes a top-up), so a
  // payment that cannot have sent anything is over: nothing will arrive.
  if (!record.orderId && !mayHaveSent(record)) {
    await retireRecord(key, record.idempotencyKey);
    return "gone";
  }
  let outcome: "pending" | "completed" | "failed";
  try {
    outcome = await readOutcome(record);
  } catch {
    return null;
  }
  if (outcome !== "pending") await retireRecord(key, record.idempotencyKey);
  return outcome;
}

async function readOutcome(record: PayWalletRecord): Promise<"pending" | "completed" | "failed"> {
  if (record.orderId) {
    const view = await getSwapKitV2Status(asSwapKitV2OrderId(record.orderId), {
      recoveryKey: record.recoveryKey,
    });
    if (!isSwapKitV2Terminal(view)) return "pending";
    return String(view.status).toUpperCase() === "COMPLETED" ? "completed" : "failed";
  }
  // A same-asset transfer has no order: its receipt is the answer.
  const hash = sentHash(record);
  if (!hash) return "pending";
  const status = await withFallback(
    record.accepted.request.token.chainId as ChainId,
    async (client): Promise<string> => (await client.getTransactionReceipt({ hash })).status,
  ).catch((): null => null);
  if (!status) return "pending";
  return status === "success" ? "completed" : "failed";
}

function sentHash(record: PayWalletRecord): `0x${string}` | null {
  for (const item of Object.values(record.evidence)) {
    if ("txHash" in item) return item.txHash as `0x${string}`;
  }
  return null;
}

/** Clears the record only if it is still this payment, never a newer one. */
async function retireRecord(key: string, idempotencyKey: string): Promise<void> {
  const current = await getCacheValue<PayWalletRecord>(key).catch((): null => null);
  if (current?.idempotencyKey === idempotencyKey) await setCacheValue(key, null);
}

/**
 * Whether the payment may run without the app: a paying call the wallet was
 * asked to send, or an order signature the server may hold even if its reply
 * was lost. An approval or a permit alone pays nothing. A same-asset transfer
 * has no order: asked or sent is enough.
 */
function mayHaveSent(record: PayWalletRecord | null): boolean {
  if (!record) return false;
  if ((record.funding?.length ?? 0) > 0) return true;
  return record.orderId === null && (!!sentHash(record) || record.started.length > 0);
}
