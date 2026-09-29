/**
 * The Lightning→Tanzanian-shilling corridor, as the wallet talks to it.
 *
 * remit.nuri.com exposes one interface — an MCP endpoint speaking JSON-RPC over
 * plain HTTP POST — so this is a thin client for it, not a second remittance
 * implementation. It owns exactly two things the send screen needs: what a TZS
 * figure costs in sats, and the BOLT11 that delivers it.
 *
 * Nothing here pays anything. The invoice this returns is handed to the wallet's
 * existing Lightning send path (`BitcoinSendService` → `bolt11`), which is what
 * decides what actually leaves the balance — the amount written INSIDE the
 * invoice, never the figure a quote said about it. The payout to the phone is
 * the server's own move after that invoice settles.
 */

import { isBolt11Invoice } from "../../lib/bitcoin/lightning";
import { REMIT_MCP_URL } from "../../config/network";
import { log } from "../logging/LoggerService";

const SATS_PER_BTC = 100_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

export type RemitRates = {
  usdTzs: number;
  eurTzs: number;
  btcUsd: number;
};

export type RemitInvoice = {
  /** The BOLT11 to pay. Its own amount is what leaves the wallet. */
  invoice: string;
  /** The corridor's handle for this payment, for a later status read. */
  sessionId: string | null;
  /**
   * The corridor's own figure for the invoice, when it states one. Advisory:
   * what the wallet spends is always decoded from the invoice itself.
   */
  amountSats: number | null;
  /** Who ClickPesa says owns the number — the one thing that confirms the payee. */
  receiverName: string | null;
  /** The shillings delivered, and the corridor's fee on top of them. */
  amountTZS: number | null;
  feeTZS: number | null;
  totalTZS: number | null;
};

let requestId = 0;

/**
 * One MCP tool call.
 *
 * The endpoint is stateless for tool calls — it answers `tools/call` without a
 * prior `initialize` as long as the protocol version is stated in the header —
 * so there is no session to hold open across a send.
 */
async function callRemitTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  requestId += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(REMIT_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The endpoint may answer either shape; both are read below.
        Accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`remit ${name} failed (${response.status})`);
    }

    // The abort timer stays armed until the body is fully read: headers can
    // arrive promptly while the body (an SSE frame, or a stalled stream)
    // trickles forever, and a send screen must never wait on that.
    const body = await response.text();
    const envelope = parseJsonRpcBody(body);
    const error = (envelope as { error?: { message?: string } })?.error;
    if (error) {
      throw new Error(String(error.message || `remit ${name} failed`));
    }
    const result = (envelope as { result?: unknown })?.result;
    return unwrapToolResult(result);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The JSON-RPC envelope, whichever transport shape carried it. A streamable-HTTP
 * server may answer a single call as one SSE frame instead of a JSON body, and
 * the difference is not something a caller should have to know about.
 */
function parseJsonRpcBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("remit returned an empty response");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (!value.startsWith("data:")) continue;
    const payload = value.slice("data:".length).trim();
    if (payload.startsWith("{")) return JSON.parse(payload);
  }
  throw new Error("remit returned an unreadable response");
}

/**
 * The tool's own payload. `structuredContent` is the typed answer when the tool
 * publishes one; the text block is the same JSON and is the fallback. Either way
 * the corridor states its own failures in an `ok` flag, and a failed call must
 * not read as a successful one with missing fields.
 */
function unwrapToolResult(result: unknown): unknown {
  const record = (result ?? {}) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  let payload: unknown = record.structuredContent;
  if (payload === undefined) {
    const text = record.content?.find((entry) => entry?.type === "text")?.text;
    if (typeof text === "string" && text.trim().startsWith("{")) {
      try {
        payload = JSON.parse(text);
      } catch {}
    }
  }
  const envelope = (payload ?? {}) as { ok?: boolean; data?: unknown; error?: unknown };
  if (record.isError || envelope.ok === false) {
    const message =
      typeof envelope.error === "string"
        ? envelope.error
        : (record.content?.find((entry) => entry?.type === "text")?.text ?? "remit call failed");
    throw new Error(message);
  }
  return envelope.data !== undefined ? envelope.data : payload;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getRemitRates(): Promise<RemitRates> {
  const data = (await callRemitTool("get_rates", {})) as Record<string, unknown>;
  const usdTzs = finiteNumber(data?.usd_tzs);
  const eurTzs = finiteNumber(data?.eur_tzs);
  const btcUsd = finiteNumber(data?.btc_usd);
  if (usdTzs === null || eurTzs === null || btcUsd === null) {
    throw new Error("remit rates unavailable");
  }
  return { usdTzs, eurTzs, btcUsd };
}

/**
 * What this many shillings costs in sats, as the corridor prices it right now.
 *
 * This is the figure the screen SHOWS. It is not what gets paid: the invoice
 * minted at confirm time carries its own amount, and that is the one the send
 * path enforces against the balance.
 */
export async function quoteRemitSats(amountTZS: number): Promise<number> {
  const tzs = Math.floor(Number(amountTZS) || 0);
  if (tzs <= 0) throw new Error("amount required");
  const data = (await callRemitTool("quote_tzs", { amountTZS: tzs })) as {
    amounts?: Record<string, unknown>;
  };
  const btc = finiteNumber(data?.amounts?.btc);
  if (btc === null || btc <= 0) throw new Error("remit quote unavailable");
  return Math.ceil(btc * SATS_PER_BTC);
}

/**
 * The invoice that delivers `amountTZS` to `phoneNumber`.
 *
 * Creating it moves no money — the corridor pays the phone out only once this
 * invoice settles, which is why the wallet may mint one and still let the user
 * walk away. `clientReference` is the caller's idempotency key, so a retry after
 * a dropped answer does not open a second payout.
 */
export async function createRemitLightningInvoice(params: {
  amountTZS: number;
  phoneNumber: string;
  clientReference?: string;
}): Promise<RemitInvoice> {
  const tzs = Math.floor(Number(params.amountTZS) || 0);
  if (tzs <= 0) throw new Error("amount required");
  const phoneNumber = String(params.phoneNumber || "").trim();
  if (!phoneNumber) throw new Error("recipient required");

  const data = (await callRemitTool("send_tzs_to_phone_with_lightning", {
    amountTZS: tzs,
    phoneNumber,
    ...(params.clientReference ? { clientReference: params.clientReference } : {}),
  })) as Record<string, unknown>;

  // The corridor names its own fields, so they are read directly; `findInvoice`
  // stays as the fallback for a payload whose shape has moved on, since an
  // invoice is recognisable on its own terms whatever it is filed under.
  const invoice =
    typeof data?.invoice === "string" && isBolt11Invoice(data.invoice.trim())
      ? data.invoice.trim()
      : findInvoice(data);
  if (!invoice) throw new Error("remit returned no invoice");

  const preview = (data?.preview ?? {}) as Record<string, unknown>;
  const receiverName =
    typeof data?.receiverName === "string" && data.receiverName.trim()
      ? data.receiverName.trim()
      : typeof preview.receiverName === "string" && preview.receiverName.trim()
        ? preview.receiverName.trim()
        : null;
  const sessionId =
    typeof data?.sessionId === "string" && data.sessionId.trim()
      ? data.sessionId.trim()
      : findSessionId(data);

  // `session_id`, not `session`: the redactor in DebugLogBuffer matches the
  // field name, and this handle is the sole locator the unauthenticated status
  // tools accept — a support dump carrying it hands over the payment.
  log(
    `🔐 STEP Remit=1 step=remit_invoice_created status=ok tzs=${tzs} sats=${
      finiteNumber(data?.amountSats) ?? "?"
    } fee_tzs=${finiteNumber(preview.feeTZS) ?? "?"} session_id=${sessionId ?? "none"} src=services/remit/RemitService.ts#createRemitLightningInvoice`,
  );
  return {
    invoice,
    sessionId,
    amountSats: finiteNumber(data?.amountSats),
    receiverName,
    amountTZS: finiteNumber(preview.amountTZS) ?? finiteNumber(data?.amountTZS),
    feeTZS: finiteNumber(preview.feeTZS),
    totalTZS: finiteNumber(preview.totalTZS),
  };
}

/**
 * The BOLT11 inside the answer, found by what it IS rather than by the key it
 * arrived under. The corridor's field names are its own and may change; an
 * invoice is recognisable on its own terms, and taking anything else from this
 * payload as payable is how a wallet ends up paying a string it never checked.
 */
function findInvoice(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    const candidate = value.trim();
    return isBolt11Invoice(candidate) ? candidate : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findInvoice(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = findInvoice(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findSessionId(value: unknown, depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "session_id", "id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const entry of Object.values(record)) {
    const found = findSessionId(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

export type RemitPaymentStatus = {
  sessionId: string;
  /** The corridor's own words for where the payment stands, when it gives any. */
  status: string | null;
  /** Whether the Lightning invoice has settled. */
  settled: boolean;
  /** Whether the shillings have reached the phone. */
  paidOut: boolean;
  /** The raw payload, for the debug screen to show what the corridor actually said. */
  raw: unknown;
};

const SETTLED_STATES = ["settled", "paid", "complete", "completed", "success", "successful"];
const PAID_OUT_STATES = ["paid_out", "payout_completed", "completed", "success", "successful"];

function readStatus(sessionId: string, data: unknown): RemitPaymentStatus {
  const record = (data ?? {}) as Record<string, unknown>;
  const status =
    typeof record.status === "string"
      ? record.status
      : typeof record.state === "string"
        ? record.state
        : null;
  const normalized = (status || "").toLowerCase();
  const payoutStatus = String(
    (record.payoutStatus ?? record.payout_status ?? "") as string,
  ).toLowerCase();
  return {
    sessionId,
    status,
    settled: record.settled === true || SETTLED_STATES.includes(normalized),
    paidOut:
      record.paidOut === true ||
      PAID_OUT_STATES.includes(payoutStatus) ||
      PAID_OUT_STATES.includes(normalized),
    raw: data,
  };
}

/** Where a payment stands. Reads only — it advances nothing. */
export async function getRemitPayment(sessionId: string): Promise<RemitPaymentStatus> {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("session required");
  return readStatus(id, await callRemitTool("get_lightning_tzs_payment", { sessionId: id }));
}

/**
 * The same read, but the corridor continues the payout when it finds the invoice
 * settled. The wallet calls this once after its own send returns, so the
 * shillings do not wait on the server noticing by itself.
 */
export async function checkRemitPayment(sessionId: string): Promise<RemitPaymentStatus> {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("session required");
  return readStatus(id, await callRemitTool("check_lightning_tzs_payment", { sessionId: id }));
}
