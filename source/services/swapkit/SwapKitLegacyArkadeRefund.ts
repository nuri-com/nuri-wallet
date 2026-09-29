// Recovery for SwapKit v1 Arkade locks that never completed.
//
// Every new swap runs on SwapKit v2. A few orders created before the cutover
// still hold the user's sats in a Satora Arkade VHTLC whose refund window is
// open, and nothing else in the app will ever return them: the v2 tracker only
// knows v2 orders, and the v2 sweep only reports EVM locks. So on app open this
// asks the v1 order store, READ-ONLY, for this wallet's open orders, refunds any
// Arkade lock the server says is due, and reports the refund txid so the order
// closes. It creates nothing, funds nothing, and signs nothing but that refund.
//
// This is the only place the app still reaches the v1 endpoint, and it is
// limited to exactly the three calls below.

import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";

export const SWAPKIT_V1_RECOVERY_URL = "https://swapkit.nuri.com/mcp";
const V1_RECOVERY_TOOLS = ["swap_list", "swap_track", "swap_wallet_submit"] as const;
type V1RecoveryTool = (typeof V1_RECOVERY_TOOLS)[number];

const SOURCE = "services/swapkit/SwapKitLegacyArkadeRefund.ts";

export type LegacyVhtlc = {
  address: string;
  amountSats: number;
  hashLock: string;
  senderPublicKey: string;
  receiverPublicKey: string;
  arkadeServerPublicKey: string;
  refundLocktime: number;
  unilateralClaimDelay: number;
  unilateralRefundDelay: number;
  unilateralRefundWithoutReceiverDelay: number;
  network?: string;
  scriptVersion?: number;
};

/** One refund the server asks this wallet to sign. */
export type LegacyArkadeRefund = {
  txId: string;
  actionId: string;
  provider: string;
  externalId?: string;
  keyIndex: number;
  vhtlc: LegacyVhtlc;
};

type Call = (tool: V1RecoveryTool, args: Record<string, unknown>) => Promise<unknown>;

export type LegacyArkadeRefundDeps = {
  call: Call;
  /** The wallet's EVM address, which v1 keyed its orders by. */
  getOwner: () => Promise<string | null>;
  /** This wallet's own Arkade address: the only place a refund may pay. */
  getRefundAddress: () => Promise<string>;
  refund: (args: {
    provider: string;
    keyIndex: number;
    vhtlc: LegacyVhtlc;
    destinationAddress: string;
    onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
    previouslySubmittedArkTxid?: string;
  }) => Promise<string>;
  isRefundable: (vhtlc: LegacyVhtlc) => boolean;
  journal: {
    get: (actionId: string) => Promise<string | null>;
    set: (actionId: string, txid: string) => Promise<void>;
  };
  now?: () => number;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * The Arkade refunds an order asks for. Only `arkade_vhtlc_v1` refunds whose key
 * reference names the action's own provider qualify; every other action kind is
 * a forward step of a swap that is over and is ignored.
 */
export function legacyArkadeRefundsOf(order: unknown): LegacyArkadeRefund[] {
  const o = asRecord(order);
  const txId = String(o.txId || "").trim();
  if (!txId || o.terminal === true) return [];
  const actions = Array.isArray(o.actions) ? o.actions : [];
  const out: LegacyArkadeRefund[] = [];
  for (const raw of actions) {
    const action = asRecord(raw);
    const request = asRecord(action.request);
    const kind = String(request.kind || "").toLowerCase();
    const operation = String(action.operation || "").toLowerCase();
    if (String(action.type || "") !== "arkade_vhtlc_v1") continue;
    if (kind !== "refund_vhtlc" && !(kind === "" && operation === "refund")) continue;
    const provider = String(action.provider || "").trim();
    const keyRef = asRecord(action.keyRef);
    if (!provider || String(keyRef.provider || "") !== provider) continue;
    const keyIndex = Number(keyRef.keyIndex);
    if (!Number.isInteger(keyIndex) || keyIndex < 0) continue;
    const actionId = String(action.actionId || "").trim();
    if (!actionId) continue;
    const vhtlc = asRecord(request.vhtlc) as unknown as LegacyVhtlc;
    if (!vhtlc || !String(vhtlc.address || "").trim()) continue;
    out.push({
      txId,
      actionId,
      provider,
      ...(action.externalId ? { externalId: String(action.externalId) } : {}),
      keyIndex,
      vhtlc,
    });
  }
  return out;
}

function log(message: string, data?: Record<string, unknown>): void {
  logWithId(`${LOG_EMOJI.bitcoin} SwapKitLegacyRefund`, message, data, {
    source: SOURCE,
    event: "FLOW",
    action: "refund",
  });
}

/**
 * Refund every due v1 Arkade lock this wallet funded. Returns the refunded
 * txIds. Each failure is logged and left for the next app open; one order's
 * failure never stops another's.
 */
export async function recoverLegacyArkadeRefunds(deps: LegacyArkadeRefundDeps): Promise<string[]> {
  const owner = String((await deps.getOwner()) || "")
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return [];
  const listed = asRecord(await deps.call("swap_list", { fromAddress: owner, limit: 100 }));
  const rows = (Array.isArray(listed.transactions) ? listed.transactions : []).map(asRecord);
  const open = rows.filter(
    (row) => row.terminal !== true && String(row.from || "") === "BTC_ARKADE",
  );
  const refunded: string[] = [];
  for (const row of open) {
    const txId = String(row.txId || "").trim();
    if (!txId) continue;
    try {
      // Refreshed: a row stored before the lock matured never shows the refund
      // action on its own, so a cached read would leave it locked forever.
      const order = await deps.call("swap_track", { txId, refresh: true });
      for (const refund of legacyArkadeRefundsOf(order)) {
        if (!deps.isRefundable(refund.vhtlc)) {
          log(`legacy refund not due yet txId=${txId}`);
          continue;
        }
        // The refund pays this wallet's OWN address, never the server's value.
        const destination = await deps.getRefundAddress();
        const previous = await deps.journal.get(refund.actionId);
        const txid = await deps.refund({
          provider: refund.provider,
          keyIndex: refund.keyIndex,
          vhtlc: refund.vhtlc,
          destinationAddress: destination,
          onSubmittedArkTxid: (arkTxid) => deps.journal.set(refund.actionId, arkTxid),
          ...(previous ? { previouslySubmittedArkTxid: previous } : {}),
        });
        await deps.journal.set(refund.actionId, txid);
        await deps.call("swap_wallet_submit", {
          txId,
          actionId: refund.actionId,
          provider: refund.provider,
          ...(refund.externalId ? { externalId: refund.externalId } : {}),
          txHash: txid,
          result: { txId: txid },
        });
        log(`legacy Arkade lock refunded txId=${txId} txid=${txid}`, { txid });
        refunded.push(txId);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error || "unknown");
      errorWithId(
        `${LOG_EMOJI.bitcoin} SwapKitLegacyRefund`,
        `legacy refund failed txId=${txId} — ${reason}`,
        { err: reason },
        { source: SOURCE, event: "API_ERR", action: "refund" },
      );
    }
  }
  return refunded;
}

/** The v1 transport, restricted to the three recovery tools. */
export async function callV1RecoveryTool(
  tool: V1RecoveryTool,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!V1_RECOVERY_TOOLS.includes(tool)) throw new Error(`v1 tool ${tool} is not a recovery call`);
  const response = await fetchImpl(SWAPKIT_V1_RECOVERY_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1_000_000_000),
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const raw = await response.text();
  const dataLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .pop();
  const envelope = asRecord(JSON.parse(dataLine ? dataLine.slice(5).trim() : raw));
  const result = asRecord(envelope.result);
  const text = (Array.isArray(result.content) ? result.content : [])
    .map(asRecord)
    .find((part) => typeof part.text === "string")?.text as string | undefined;
  if (!response.ok || envelope.error || result.isError || !text) {
    throw new Error(
      String(
        asRecord(envelope.error).message ||
          text ||
          `SwapKit ${tool} failed (http ${response.status})`,
      ),
    );
  }
  return JSON.parse(text);
}
