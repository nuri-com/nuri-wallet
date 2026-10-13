// Add money from another wallet, carried like every other move: accepting the
// quote closes the sheet, the status pill says Preparing while the other
// wallet still has to sign, then Processing until the money lands, then
// Completed or failed. The balance it lands on shows it as incoming meanwhile.
// A payment refused before anything left the wallet brings the sheet back with
// the reason instead.
import { withFallback } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { EventBus } from "../events/AppEventBusService";
import { startIncomingInFlight } from "../money/announce";
import { MoneyInFlightStore, type MoneyRail } from "../money/MoneyInFlightStore";
import {
  asSwapKitV2OrderId,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
} from "../swapkit/SwapKitV2Service";
import { startMovePill } from "../wallet/CardTransferPill";
import type { PayWalletProgress, PayWalletRecord } from "./PayWalletSwapService";

/** Refusals that happen before the wallet paid anything. */
const NOTHING_SENT = new Set(["rejected", "quote_expired", "error"]);

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

/**
 * Run an accepted top-up under the pill. `pay` drives the payment and reports
 * its progress, or resolves null when it never started; `recordKey` is its pay
 * record. Resolves "reopen" when nothing left the wallet (the sheet comes back
 * with the reason), "close" otherwise. A resumed payment keeps the incoming
 * row it already has.
 */
export async function runWalletTopUp(args: {
  recordKey: string;
  /** The balance it lands on, and what arrives there (sats for bitcoin). */
  rail: MoneyRail;
  amount: number;
  resume?: boolean;
  pay: (onProgress: (progress: PayWalletProgress) => void) => Promise<PayWalletProgress | null>;
}): Promise<"reopen" | "close"> {
  const pill = startMovePill();
  await MoneyInFlightStore.hydrate().catch(() => {});
  const existing = args.resume
    ? MoneyInFlightStore.list().find(
        (row) => row.kind === "wallet_topup" && row.id.split("#")[0] === args.recordKey,
      )
    : undefined;
  const id = existing?.id ?? `${args.recordKey}#${Date.now()}`;
  // The row appears once the payment really starts, never for a no-op.
  let shown = !!existing;
  let paid = false;
  const result = await args.pay((progress) => {
    if (!shown) {
      shown = true;
      void startIncomingInFlight({
        id,
        rail: args.rail,
        amount: args.amount,
        kind: "wallet_topup",
      }).catch(() => {});
    }
    if (progress.state !== "paid") return;
    // Processing from the moment the wallet paid its part: the rest needs no app.
    paid = true;
    pill.settleByRows(id);
  });
  if (!result) {
    // Never started (no wallet, or already being paid elsewhere): nothing to report.
    pill.drop();
    return "reopen";
  }
  const ended = (outcome: "completed" | "failed") => {
    pill.settleByRows(id);
    try {
      EventBus.emit(MoneyInFlightStore.OUTCOME, { id, outcome });
    } catch {}
    void MoneyInFlightStore.finish(id).catch(() => {});
    return "close" as const;
  };
  if (result.state === "settled") return ended("completed");
  if (result.state !== "failed") {
    // Still on its way: the row settles it.
    pill.settleByRows(id);
    return "close";
  }
  const record = await getCacheValue<PayWalletRecord>(args.recordKey).catch((): null => null);
  if (!paid && NOTHING_SENT.has(result.reason) && !mayHaveSent(record)) {
    pill.drop();
    void MoneyInFlightStore.finish(id).catch(() => {});
    return "reopen";
  }
  // The wallet may have sent it and nobody can tell yet: the row stays until
  // the order (or the transfer's receipt) says how it ended.
  if (record) {
    pill.settleByRows(id);
    return "close";
  }
  return ended("failed");
}
