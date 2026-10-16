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
import { randomUUID } from "expo-crypto";

import { REMIT_MCP_URL, ZAPREMIT_MCP_URL } from "../../config/network";
import {
  parseZapRemitMethods,
  type ZapRemitMethod,
  type ZapRemitOption,
} from "../../lib/remit/zapremitForm";
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
async function callRemitTool(
  name: string,
  args: Record<string, unknown>,
  endpoint: string = REMIT_MCP_URL,
): Promise<unknown> {
  requestId += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
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

// ── ZapRemit: Lightning → bank or mobile money abroad ───────────────────
// A different MCP endpoint, same transport. ZapRemit locks a quote for a
// recipient, then hands out the BOLT11 that funds it and pays out by itself
// once that invoice settles: nothing to nudge afterwards. Countries, methods
// and their recipient fields are read live (`lib/remit/zapremitForm.ts`).

export type ZapRemitCountry = { code: string; name: string; currency: string };

export type ZapRemitTerms = {
  /** Units of the payout currency per bitcoin, ZapRemit's reference rate. */
  btcRate: number;
  /** The method's band, in the payout currency. */
  min: number;
  max: number;
};

function callZapRemitTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return callRemitTool(name, args, ZAPREMIT_MCP_URL);
}

export async function getZapRemitCountries(): Promise<ZapRemitCountry[]> {
  // `{ data: [...] }` arrives already reduced to the list by the shared unwrap.
  const data = await callZapRemitTool("zapremit_countries", {});
  if (!Array.isArray(data)) throw new Error("zapremit unavailable");
  return (data as Array<Record<string, unknown>>).flatMap((c) =>
    typeof c?.code === "string" && typeof c?.currency === "string"
      ? [{ code: c.code, name: typeof c.name === "string" ? c.name : c.code, currency: c.currency }]
      : [],
  );
}

/** The methods the app offers for a country: active, no sender KYC. */
export async function getZapRemitMethods(country: string): Promise<ZapRemitMethod[]> {
  return parseZapRemitMethods(await callZapRemitTool("zapremit_methods", { country }));
}

/** Allowed values for a picked field (banks, networks), by its field name. */
export async function getZapRemitOptions(
  country: string,
  methodCode: string,
  field: string,
): Promise<ZapRemitOption[]> {
  const data = (await callZapRemitTool("zapremit_options", { country, methodCode })) as Record<
    string,
    unknown
  >;
  const list = data?.[field];
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).flatMap((o) =>
    typeof o?.code === "string"
      ? [{ code: o.code, name: typeof o.name === "string" ? o.name.trim() : o.code }]
      : [],
  );
}

export async function getZapRemitTerms(
  country: string,
  methodCode: string,
  currency: string,
): Promise<ZapRemitTerms> {
  const [rates, methods] = (await Promise.all([
    callZapRemitTool("zapremit_rates", {}),
    getZapRemitMethods(country),
  ])) as [{ BTC?: Record<string, unknown> }, ZapRemitMethod[]];
  const btcRate = finiteNumber(rates?.BTC?.[currency]);
  const method = methods.find((entry) => entry.code === methodCode);
  if (btcRate === null || btcRate <= 0 || !method) throw new Error("zapremit unavailable");
  return { btcRate, min: method.min, max: method.max };
}

/** What this much payout currency costs in sats at the reference rate. Shown, never paid. */
export function localToSats(amount: number, btcRate: number): number {
  return Math.ceil((amount / btcRate) * SATS_PER_BTC);
}

/**
 * The invoice that delivers `amount` of the method's currency to `recipient`.
 *
 * Quote, then invoice: neither moves money, and ZapRemit pays out only once
 * this invoice settles. Each press gets a fresh reference: a quote lives a
 * minute, and an unpaid one is simply left to expire.
 */
export async function createZapRemitLightningInvoice(params: {
  country: string;
  methodCode: string;
  currency: string;
  amount: number;
  recipient: Record<string, unknown>;
}): Promise<{ invoice: string; orderId: string }> {
  const amount = Math.floor(Number(params.amount) || 0);
  if (amount <= 0) throw new Error("amount required");
  const fullName = params.recipient?.fullName;
  if (typeof fullName === "string" && !fullName.trim()) throw new Error("recipient required");

  const quote = (await callZapRemitTool("zapremit_quote", {
    country: params.country,
    methodCode: params.methodCode,
    amount,
    currency: params.currency,
    recipient: params.recipient,
    referenceId: randomUUID().toLowerCase(),
  })) as { orderId?: unknown };
  const orderId = typeof quote?.orderId === "string" ? quote.orderId : "";
  if (!orderId) throw new Error("zapremit returned no order");

  const payment = (await callZapRemitTool("zapremit_payment", { orderId })) as Record<
    string,
    unknown
  >;
  const invoice =
    typeof payment?.invoice === "string" && isBolt11Invoice(payment.invoice.trim())
      ? payment.invoice.trim()
      : findInvoice(payment);
  if (!invoice) throw new Error("zapremit returned no invoice");

  log(
    `🔐 STEP Remit=1 step=remit_zapremit_invoice_created status=ok country=${params.country} method=${params.methodCode} amount=${amount} currency=${params.currency} sats=${
      finiteNumber(payment?.amountSats) ?? "?"
    } src=services/remit/RemitService.ts#createZapRemitLightningInvoice`,
  );
  return { invoice, orderId };
}

// ── Tanzania on the same host: bank, Lipa Namba, TanQR (`send_tzs`) ─────
// An order names the destination and answers with the ways it can be paid.
// Each offer carries `automaticDetection`; only those are used, so nothing
// here ever needs a proof typed back. Bank payouts take USDC only.

/** Exact amount and address for a stablecoin transfer on Base. */
export type TzStablePayment = {
  payTo: string;
  amountAtomic: string;
  amount: string;
  /** When the order lapses, epoch ms; a payment after it may never pay out. */
  expiresAt: number | null;
};

export type TzOrder = {
  orderId: string;
  /** When the order lapses, epoch ms; null when the service did not say. */
  expiresAt: number | null;
  /** The order's own BOLT11, when the service offers Lightning for it. */
  invoice: string | null;
  usdc: TzStablePayment | null;
  eurc: TzStablePayment | null;
};

export type TzPrice = { sats: number; usdc: number; eurc: number };

function tzStableOffer(
  entry: Record<string, unknown>,
  expiresAt: number | null,
): TzStablePayment | null {
  const payTo = typeof entry.payTo === "string" ? entry.payTo.trim() : "";
  const amountAtomic = typeof entry.amount === "string" ? entry.amount : "";
  const amount = typeof entry.amountLesbar === "string" ? entry.amountLesbar : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || !/^\d+$/.test(amountAtomic) || !amount) return null;
  return { payTo, amountAtomic, amount, expiresAt };
}

/** The offers of a `send_tzs` order the wallet can pay without a proof. */
export function parseTzOrder(data: unknown): TzOrder {
  const record = (data ?? {}) as {
    orderId?: unknown;
    payWith?: unknown;
    gueltigBis?: unknown;
    validForSeconds?: unknown;
  };
  const orderId = typeof record.orderId === "string" ? record.orderId : "";
  if (!orderId) throw new Error("remit returned no order");
  const until = Date.parse(String(record.gueltigBis ?? ""));
  const forSeconds = Number(record.validForSeconds);
  const expiresAt = Number.isFinite(until)
    ? until
    : Number.isFinite(forSeconds) && forSeconds > 0
      ? Date.now() + forSeconds * 1000
      : null;
  const offers = Array.isArray(record.payWith)
    ? (record.payWith as Array<Record<string, unknown>>).filter(
        (o) => o?.automaticDetection === true,
      )
    : [];
  const lightning = offers.find((o) => o.protocol === "l402");
  const invoice =
    typeof lightning?.invoice === "string" && isBolt11Invoice(lightning.invoice.trim())
      ? lightning.invoice.trim()
      : null;
  const usdc = offers.find((o) => o.protocol === "onchain-usdc");
  const eurc = offers.find((o) => o.protocol === "onchain-eurc");
  return {
    orderId,
    expiresAt,
    invoice,
    usdc: usdc ? tzStableOffer(usdc, expiresAt) : null,
    eurc: eurc ? tzStableOffer(eurc, expiresAt) : null,
  };
}

/** Time a payment needs to land before its order lapses. */
const TZ_ORDER_SAFETY_MS = 120_000;

/** Whether an order (or a quote paying it) is too close to lapsing to pay now. */
export function tzPaymentLapsed(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && now > expiresAt - TZ_ORDER_SAFETY_MS;
}

/** What `amountTZS` costs, per asset, before an order exists. Shown, never paid. */
export async function quoteTzPayout(amountTZS: number): Promise<TzPrice> {
  const tzs = Math.floor(Number(amountTZS) || 0);
  if (tzs <= 0) throw new Error("amount required");
  const data = (await callZapRemitTool("quote_tzs", { amountTZS: tzs })) as {
    customerPays?: Record<string, unknown>;
  };
  const btc = finiteNumber(data?.customerPays?.BTC);
  const usdc = finiteNumber(data?.customerPays?.USDC);
  const eurc = finiteNumber(data?.customerPays?.EURC);
  if (btc === null || usdc === null || eurc === null) throw new Error("remit quote unavailable");
  return { sats: Math.ceil(btc * SATS_PER_BTC), usdc, eurc };
}

/** Banks and Lipa Namba providers, as `{ code, name }` for the form's pickers. */
export async function listTzOptions(field: "bic" | "providerCode"): Promise<ZapRemitOption[]> {
  const data = await callZapRemitTool(field === "bic" ? "list_banks" : "list_lipa_providers", {});
  const record = (data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(data)
    ? data
    : ((record.banks ?? record.providers ?? record.data) as unknown);
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).flatMap((o) => {
    const code = o.bic ?? o.providerCode ?? o.code;
    const name = o.name ?? o.bankName ?? o.providerName ?? code;
    return typeof code === "string" ? [{ code, name: String(name).trim() }] : [];
  });
}

/**
 * The order that pays `amountTZS` to a Tanzanian bank account, Lipa Namba or
 * TanQR. Creating it moves no money; the service pays out once one of its
 * offers is paid, and an unpaid order lapses on its own.
 */
export async function createTzOrder(
  amountTZS: number,
  recipient: Record<string, unknown>,
): Promise<TzOrder> {
  const tzs = Math.floor(Number(amountTZS) || 0);
  if (tzs <= 0) throw new Error("amount required");
  const order = parseTzOrder(await callZapRemitTool("send_tzs", { amountTZS: tzs, ...recipient }));
  log(
    `🔐 STEP Remit=1 step=remit_tz_order_created status=ok tzs=${tzs} lightning=${
      order.invoice ? 1 : 0
    } usdc=${order.usdc ? 1 : 0} eurc=${order.eurc ? 1 : 0} src=services/remit/RemitService.ts#createTzOrder`,
  );
  return order;
}
