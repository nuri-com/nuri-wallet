import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { createPublicClient, decodeEventLog, erc20Abi, verifyTypedData } from "viem";
import { BASE_EURC } from "../../config/network";
import { BASE_VIEM_CHAIN, getBaseViemTransport } from "../../lib/rpc/baseRpc";
import { signSwapKitRecoveryQuote } from "../base/BaseTokenTransferService";
import { SwapKitOrderStore, type SwapKitOrder } from "./SwapKitOrderStore";
import { acceptSwapKitRecovery, quoteSwapKitRecovery } from "./SwapKitService";
import type { SwapKitTrackResponse } from "./SwapKitService";
import {
  validateRecoveryAcceptance,
  validateSwapKitRecoveryQuote,
  type SwapKitRecoveryQuote,
} from "./SwapKitRecoveryQuote";

const accepting = new Set<string>();

export function isCurrentRateRecoveryRoute(summary: SwapKitTrackResponse | undefined): boolean {
  return (
    summary?.from === "BTC_ARKADE" &&
    summary.to === "EURC_BASE" &&
    (summary.provider === "satora" ||
      summary.legs?.some((leg) => leg.provider === "satora") === true ||
      (summary.route as { providers?: string[] } | undefined)?.providers?.includes("satora") ===
        true)
  );
}

export function hasRecoveryConsent(order: SwapKitOrder): boolean {
  return Boolean(
    (SwapKitOrderStore.list().find((row) => row.txId === order.txId) ?? order).recoveryConsent,
  );
}

/** Retire only after the original order names a mined EURC transfer to its recipient. */
export async function recoveryPayoutProven(
  order: SwapKitOrder,
  status: SwapKitTrackResponse,
): Promise<boolean> {
  // swap_track returns `id`; local callers may also carry `txId`. Every supplied
  // identity must match exactly. Never replace an unrelated server ID with ours.
  const identities = (["id", "txId"] as const).filter((key) => Object.hasOwn(status, key));
  if (
    typeof order.txId !== "string" ||
    !/^\S+$/.test(order.txId) ||
    identities.length === 0 ||
    identities.some((key) => status[key] !== order.txId) ||
    status.status !== "COMPLETED" ||
    status.to !== "EURC_BASE"
  )
    return false;
  const quote = await acceptedRecoveryQuote(order);
  if (!quote) return false;
  const last = status.legs?.at(-1);
  if (!last?.terminal || !last.txids?.length) return false;
  const client = createPublicClient({ chain: BASE_VIEM_CHAIN, transport: getBaseViemTransport() });
  for (const hash of last.txids) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
    try {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      if (receipt.status !== "success") continue;
      let received = 0n;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== BASE_EURC.address.toLowerCase()) continue;
        try {
          const topics = (log as { topics?: [`0x${string}`, ...`0x${string}`[]] }).topics;
          if (!Array.isArray(topics)) continue;
          const event = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics,
            eventName: "Transfer",
          });
          if (event.args.to.toLowerCase() === quote.recipient.toLowerCase())
            received += event.args.value;
          if (event.args.from.toLowerCase() === quote.recipient.toLowerCase())
            received -= event.args.value;
        } catch {}
      }
      if (received >= BigInt(quote.minimumReceiveUnits)) return true;
    } catch {}
  }
  return false;
}

function currentOrder(txId: string): SwapKitOrder {
  const order = SwapKitOrderStore.list().find((row) => row.txId === txId);
  if (!order) throw new Error("Recovery order is no longer available.");
  return order;
}

async function binding(txId: string) {
  const owner = await getEthereumAddress();
  if (!owner) throw new Error("Unlock your wallet to continue.");
  return { txId, owner, recipient: currentOrder(txId).settleTarget };
}

/** Preview only, including an unresolved identical-submit checkpoint. */
export async function previewSwapKitRecovery(
  txId: string,
  reconcile = true,
): Promise<SwapKitRecoveryQuote> {
  if (accepting.has(txId)) throw new Error("Recovery confirmation is already running.");
  accepting.add(txId);
  try {
    await SwapKitOrderStore.hydrate();
    const expected = await binding(txId);
    const assertCurrent = async () => {
      const now = await binding(txId);
      if (now.owner !== expected.owner || now.recipient !== expected.recipient)
        throw new Error("Recovery wallet changed.");
    };
    const pending = currentOrder(txId).recoveryConsent;
    let quote = pending?.quote ?? (await quoteSwapKitRecovery(txId));
    if (pending) validateSwapKitRecoveryQuote(pending.quote, expected, true);
    if (
      reconcile &&
      pending &&
      !pending.accepted &&
      Date.parse(pending.quote.expiresAt) <= Date.now()
    ) {
      const restore = async () => {
        const accepted = await acceptSwapKitRecovery({
          txId,
          quoteId: pending.quote.quoteId,
          signature: pending.signature,
        });
        await assertCurrent();
        validateRecoveryAcceptance(pending.quote, accepted);
        if (currentOrder(txId).recoveryConsent !== pending)
          throw new Error("Recovery checkpoint changed.");
        await SwapKitOrderStore.checkpointRecovery(txId, { ...pending, accepted });
        await assertCurrent();
      };
      const successor = currentOrder(txId).recoveryNextQuote;
      if (successor && Date.parse(successor.expiresAt) > Date.now()) {
        quote = successor;
      } else {
        try {
          await restore();
        } catch (error) {
          // Exact errors from recovery.mjs -> MCP isError -> existing caller.
          // A transport failure, transient payload, or other rejection is not expiry proof.
          const message = error instanceof Error ? error.message : "";
          if (
            ![
              "Error: Recovery quote expired; request a fresh quote (http 200)",
              "Error: Recovery quote expired during verification; request a fresh quote (http 200)",
              ...(successor ? ["Error: Recovery quote does not match this order (http 200)"] : []),
            ].includes(message)
          )
            throw error;
          await assertCurrent();
          try {
            quote = await quoteSwapKitRecovery(txId);
          } catch (quoteError) {
            const reason = quoteError instanceof Error ? quoteError.message : "";
            if (
              reason === "Error: Recovery terms already accepted for this order (http 200)" ||
              reason ===
                "Error: Order changed during recovery quote; request a fresh quote (http 200)"
            ) {
              await restore();
              return JSON.parse(JSON.stringify(pending.quote));
            }
            throw quoteError;
          }
          await assertCurrent();
          validateSwapKitRecoveryQuote(quote, expected);
          if (
            quote.quoteId === pending.quote.quoteId ||
            quote.sourceAmountUnits !== pending.quote.sourceAmountUnits
          ) {
            throw new Error("Recovery replacement quote changed its original input.");
          }
          await SwapKitOrderStore.checkpointRecoveryQuote(txId, pending, quote, assertCurrent);
        }
      }
    }
    const now = await binding(txId);
    if (now.owner !== expected.owner || now.recipient !== expected.recipient)
      throw new Error("Recovery wallet changed.");
    validateSwapKitRecoveryQuote(
      quote,
      expected,
      Boolean(pending && quote.quoteId === pending.quote.quoteId),
    );
    // Detach preview from the store/transport: exactly these values are displayed and signed.
    return JSON.parse(JSON.stringify(quote));
  } finally {
    accepting.delete(txId);
  }
}

/** Called ONLY by Continue on the visible quote. Polling never creates price consent. */
export async function continueSwapKitRecovery(
  displayed: SwapKitRecoveryQuote,
): Promise<SwapKitOrder> {
  const quote: SwapKitRecoveryQuote = JSON.parse(JSON.stringify(displayed));
  if (accepting.has(quote.txId)) throw new Error("Recovery confirmation is already running.");
  accepting.add(quote.txId);
  try {
    const expected = await binding(quote.txId);
    const assertCurrent = async () => {
      const now = await binding(quote.txId);
      if (now.owner !== expected.owner || now.recipient !== expected.recipient)
        throw new Error("Recovery wallet changed.");
    };
    let checkpoint = currentOrder(quote.txId).recoveryConsent;
    if (checkpoint && JSON.stringify(checkpoint.quote) !== JSON.stringify(quote)) {
      if (
        checkpoint.accepted ||
        JSON.stringify(currentOrder(quote.txId).recoveryNextQuote) !== JSON.stringify(quote)
      ) {
        throw new Error("Resolve the previous recovery confirmation first.");
      }
      checkpoint = undefined;
    }
    if (checkpoint?.accepted) {
      await acceptedRecoveryQuote(currentOrder(quote.txId));
      return currentOrder(quote.txId);
    }
    validateSwapKitRecoveryQuote(quote, expected, Boolean(checkpoint));
    if (!checkpoint) {
      const signature = await signSwapKitRecoveryQuote(quote, expected);
      await assertCurrent();
      checkpoint = { quote, signature };
    }
    // Re-persist even a memory checkpoint whose prior disk write failed.
    await SwapKitOrderStore.checkpointRecovery(quote.txId, checkpoint);
    await assertCurrent();
    const accepted = await acceptSwapKitRecovery({
      txId: quote.txId,
      quoteId: quote.quoteId,
      signature: checkpoint.signature,
    });
    await assertCurrent();
    validateRecoveryAcceptance(quote, accepted);
    await SwapKitOrderStore.checkpointRecovery(quote.txId, { ...checkpoint, accepted });
    await assertCurrent();
    return currentOrder(quote.txId);
  } finally {
    accepting.delete(quote.txId);
  }
}

/** Only server-accepted, exact fixed bounds can authorize a resumed CoW leg. */
export async function acceptedRecoveryQuote(
  order: SwapKitOrder,
): Promise<SwapKitRecoveryQuote | null> {
  const current = SwapKitOrderStore.list().find((row) => row.txId === order.txId) ?? order;
  const consent = current.recoveryConsent;
  if (!consent) return null;
  if (!consent.accepted) throw new Error("Recovery confirmation is not yet accepted.");
  validateSwapKitRecoveryQuote(consent.quote, await binding(order.txId), true);
  validateRecoveryAcceptance(consent.quote, consent.accepted);
  if (
    !(await verifyTypedData({
      ...consent.quote.typedData,
      address: consent.quote.owner as `0x${string}`,
      signature: consent.signature,
    }))
  ) {
    throw new Error("Recovery signature does not match the accepted quote.");
  }
  validateSwapKitRecoveryQuote(consent.quote, await binding(order.txId), true);
  return consent.quote;
}
