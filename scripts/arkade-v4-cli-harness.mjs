#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bech32 } from "bech32";
import {
  NURI_SERVER_CSV_POLICY,
  formatCsvPolicy,
  versionMatrixFields,
} from "./arkade-version-matrix.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:1344";
export const DEFAULT_STATE_PATH = "/tmp/nuri-arkade-v4-cli-state.json";

const SRC = "scripts/arkade-v4-cli-harness.mjs";
let lastLogAtMs = 0;

function shortTime(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
}

function logHarness(level, event, group, scope, action, fields = {}) {
  const now = Date.now();
  const dt = lastLogAtMs > 0 ? now - lastLogAtMs : 0;
  lastLogAtMs = now;
  const details = formatFields(fields);
  console.log(
    `🧪 ${level} ${event} grp=${group} scope=${scope} act=${action} t=${shortTime(now)} dt=+${dt}ms src=${SRC}#${action}${details ? ` ${details}` : ""}`,
  );
}

function requireOptionValue(arg, next) {
  if (!next || next.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return next;
}

function normalizeBaseUrl(rawBaseUrl) {
  const raw = String(rawBaseUrl || "").trim();
  if (!raw) throw new Error("base URL is required");
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function baseUrlFromEnv(env) {
  if (env.ARKADE_V4_BASE_URL) return env.ARKADE_V4_BASE_URL;
  if (env.BASE_URL) return env.BASE_URL;
  if (env.HOST_V4 || env.PORT_V4) {
    return `http://${env.HOST_V4 || "127.0.0.1"}:${env.PORT_V4 || "1344"}`;
  }
  return DEFAULT_BASE_URL;
}

export function parseHarnessArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    baseUrl: "",
    statePath: env.ARKADE_V4_CLI_STATE_PATH || env.ARKADE_V4_STATE_PATH || DEFAULT_STATE_PATH,
    flow: "status",
    invoice: "",
    lnurl: "",
    amountSats: "",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--base-url") {
      args.baseUrl = requireOptionValue(arg, next);
      i += 1;
    } else if (arg === "--state") {
      args.statePath = requireOptionValue(arg, next);
      i += 1;
    } else if (arg === "--flow") {
      args.flow = requireOptionValue(arg, next);
      i += 1;
    } else if (arg === "--invoice") {
      args.invoice = requireOptionValue(arg, next);
      i += 1;
    } else if (arg === "--lnurl") {
      args.lnurl = requireOptionValue(arg, next);
      i += 1;
    } else if (arg === "--amount-sats") {
      args.amountSats = requireOptionValue(arg, next);
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return {
    ...args,
    baseUrl: normalizeBaseUrl(args.baseUrl || baseUrlFromEnv(env)),
    statePath: path.resolve(args.statePath),
  };
}

export function createEmptyHarnessState() {
  return { version: 1, attempts: [] };
}

function normalizeHarnessState(state) {
  return {
    version: 1,
    ...state,
    attempts: Array.isArray(state?.attempts) ? state.attempts : [],
  };
}

export async function saveHarnessState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(normalizeHarnessState(state), null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function loadHarnessState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("state file must contain a JSON object");
    }
    return { state: normalizeHarnessState(state), status: "loaded" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const state = createEmptyHarnessState();
  await saveHarnessState(statePath, state);
  return { state, status: "created" };
}

export function formatHarnessStatus({ baseUrl, statePath }) {
  const matrix = versionMatrixFields();
  return [
    "arkade_v4_cli_harness=ready",
    `base_url=${baseUrl}`,
    `state_path=${statePath}`,
    "state_ready=true",
    `nuri_server_api=${matrix.nuri_server_api}`,
    `nuri_contract_version=${matrix.nuri_contract_version}`,
    `arkade_sdk_version=${matrix.arkade_sdk_version}`,
    `bitcoin_tx_version=${matrix.bitcoin_tx_version}`,
    `arkade_csv=${matrix.arkade_csv}`,
    `nuri_csv=${matrix.nuri_csv}`,
    `nuri_server_csv=${formatCsvPolicy()}`,
    "flows=status|invoice-preflight|lnurl-preflight",
  ].join("\n");
}

function normalizeInvoice(rawInvoice) {
  const invoice = String(rawInvoice || "")
    .trim()
    .toLowerCase();
  if (!invoice) throw new Error("--invoice is required");
  if (!invoice.startsWith("ln") || invoice.startsWith("lnurl")) {
    throw new Error("invoice must be a bolt11 invoice");
  }
  return invoice;
}

// Minimal bolt11 read: enough for a preflight (payment hash + amount). The
// retired swap package used to supply these two lookups.
function bolt11AmountSats(hrp) {
  const match = String(hrp || "").match(/^ln(?:bc|tb|bcrt|sb)([0-9]+)?([munp])?$/);
  if (!match || !match[1]) return "";
  const multipliers = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
  const btc = Number(match[1]) * (multipliers[match[2] || ""] ?? 1);
  return Number.isFinite(btc) ? String(Math.round(btc * 1e8)) : "";
}

function bolt11PaymentHash(words) {
  // BOLT11 puts seven 5-bit words of timestamp ahead of the tagged fields, so
  // the tag walk starts at index 7 — starting at 0 reads the timestamp as a
  // tag/length pair and yields a bogus hash.
  let cursor = 7;
  while (cursor + 2 < words.length) {
    const tag = words[cursor];
    cursor += 1;
    const length = (words[cursor] << 5) | words[cursor + 1];
    cursor += 2;
    const payload = words.slice(cursor, cursor + length);
    cursor += length;
    if (tag === 1) {
      return Buffer.from(bech32.fromWords(payload)).toString("hex").slice(0, 64);
    }
  }
  return "";
}

function decodeInvoiceForPreflight(invoiceRaw) {
  const invoice = normalizeInvoice(invoiceRaw);
  const decoded = bech32.decode(invoice, 2000);
  const amountSats = bolt11AmountSats(decoded.prefix);
  const paymentHash = bolt11PaymentHash(decoded.words).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new Error("invoice payment hash missing");
  }
  return {
    invoice,
    paymentHash,
    amountSats,
  };
}

function normalizeLightningInput(raw) {
  return String(raw || "")
    .trim()
    .replace(/^lightning:/i, "");
}

function isLightningAddress(raw) {
  const value = String(raw || "").trim();
  if (!value || value.includes(" ")) return false;
  const parts = value.split("@");
  return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
}

function isLnurlBech32(raw) {
  return String(raw || "")
    .toLowerCase()
    .startsWith("lnurl1");
}

function isLnurlUrl(raw) {
  return /^https?:\/\//i.test(String(raw || ""));
}

function decodeLnurlToUrl(lnurl) {
  const decoded = bech32.decode(String(lnurl || "").toLowerCase(), 1500);
  const bytes = bech32.fromWords(decoded.words);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function getDomainFromUrl(url) {
  const match = String(url || "").match(/^https?:\/\/([^/]+)/i);
  return match?.[1] || "unknown";
}

async function fetchLnurlJson(url) {
  const startedAtMs = Date.now();
  const response = await fetch(url);
  const durMs = Date.now() - startedAtMs;
  logHarness(
    response.ok ? "INFO" : "ERROR",
    response.ok ? "API" : "API_ERR",
    "Network",
    "Lnurl",
    "fetch",
    {
      method: "GET",
      host: getDomainFromUrl(url),
      status: response.status,
      dur: `${durMs}ms`,
    },
  );
  if (!response.ok) {
    throw new Error(`LNURL HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json?.status === "ERROR") {
    logHarness("ERROR", "API_ERR", "Network", "Lnurl", "fetch", {
      status: "ERROR",
      host: getDomainFromUrl(url),
      reason: String(json?.reason || "LNURL error"),
    });
    throw new Error(json?.reason || "LNURL error");
  }
  return json;
}

async function resolveLnurlPayRequest(rawLnurl) {
  const normalized = normalizeLightningInput(rawLnurl);
  if (!normalized) throw new Error("--lnurl is required");

  let url = "";
  if (isLightningAddress(normalized)) {
    const [name, domain] = normalized.toLowerCase().split("@");
    url = `https://${domain}/.well-known/lnurlp/${name}`;
  } else if (isLnurlBech32(normalized)) {
    url = decodeLnurlToUrl(normalized);
  } else if (isLnurlUrl(normalized)) {
    url = normalized;
  }
  if (!url) throw new Error("--lnurl must be a lightning address, lnurl1, or URL");

  const data = await fetchLnurlJson(url);
  if (data?.tag !== "payRequest") {
    throw new Error("unsupported LNURL");
  }
  const callback = String(data?.callback || "");
  const minSendableMsats = Number(data?.minSendable);
  const maxSendableMsats = Number(data?.maxSendable);
  if (!callback) throw new Error("LNURL callback missing");
  if (
    !Number.isFinite(minSendableMsats) ||
    !Number.isFinite(maxSendableMsats) ||
    maxSendableMsats <= 0 ||
    maxSendableMsats < minSendableMsats
  ) {
    throw new Error("LNURL amount range invalid");
  }

  return {
    callback,
    domain: getDomainFromUrl(url),
    minSendableSats: Math.ceil(minSendableMsats / 1000),
    maxSendableSats: Math.floor(maxSendableMsats / 1000),
  };
}

async function requestLnurlInvoice(callback, amountSats) {
  const amountMsats = Math.round(Number(amountSats) * 1000);
  if (!Number.isFinite(amountMsats) || amountMsats <= 0) {
    throw new Error("--amount-sats is required for lnurl-preflight");
  }
  const separator = callback.includes("?") ? "&" : "?";
  const data = await fetchLnurlJson(`${callback}${separator}amount=${amountMsats}`);
  const invoice = String(data?.pr || "");
  if (!invoice) throw new Error("LNURL invoice missing");
  return invoice;
}

function shortHash(value) {
  return String(value || "").slice(0, 16);
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} JSON invalid: ${error?.message || error}`);
  }
}

function attemptIdForInvoice(invoice) {
  return `ln_${createHash("sha256").update(invoice).digest("hex").slice(0, 16)}`;
}

function findInvoiceAttempt(state, decodedInvoice) {
  return normalizeHarnessState(state).attempts.find(
    (attempt) =>
      attempt?.invoice === decodedInvoice.invoice ||
      attempt?.paymentHash === decodedInvoice.paymentHash,
  );
}

async function reserveDecodedInvoice(config, state, decoded, fields = {}) {
  const existing = findInvoiceAttempt(state, decoded);
  if (existing) {
    logHarness("WARN", "VALIDATION", "Auth", "CliHarness", "invoicePreflight", {
      status: "blocked",
      why: "reused_invoice",
      payment_hash: shortHash(decoded.paymentHash),
      first_attempt: existing.id,
      ...fields,
      expected_next: "create_fresh_invoice",
    });
    throw new Error("reused invoice blocked; create a fresh invoice before app testing");
  }
  const now = Date.now();
  const amountSats = config.amountSats || decoded.amountSats || "n/a";
  const attempt = {
    id: attemptIdForInvoice(decoded.invoice),
    flow: "ln_invoice_pay",
    status: "reserved",
    invoice: decoded.invoice,
    paymentHash: decoded.paymentHash,
    amountSats,
    source: fields.source || "invoice",
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.attempts = [...normalizeHarnessState(state).attempts, attempt];
  await saveHarnessState(config.statePath, state);
  logHarness("INFO", "VALIDATION", "Auth", "CliHarness", "invoicePreflight", {
    status: "ok",
    attempt: attempt.id,
    payment_hash: shortHash(decoded.paymentHash),
    sats: amountSats,
    ...fields,
    expected_next: "single_app_payment_attempt",
  });
  return { attempt, amountSats };
}

async function runInvoicePreflight(config, state) {
  const decoded = decodeInvoiceForPreflight(config.invoice);
  logHarness("INFO", "VALIDATION", "Auth", "CliHarness", "sdkInvoiceDecode", {
    status: "ok",
    sdk: "@arkade-os/swap",
    payment_hash: shortHash(decoded.paymentHash),
    sats: decoded.amountSats || "n/a",
  });
  const { attempt, amountSats } = await reserveDecodedInvoice(config, state, decoded);
  return [
    "arkade_v4_cli_harness=invoice_preflight_ok",
    `attempt=${attempt.id}`,
    `payment_hash=${decoded.paymentHash}`,
    `amount_sats=${amountSats}`,
    `state_path=${config.statePath}`,
  ].join("\n");
}

async function runLnurlPreflight(config, state) {
  const lnurl = await resolveLnurlPayRequest(config.lnurl);
  const requestedSats = Math.trunc(Number(config.amountSats || 0));
  if (!Number.isFinite(requestedSats) || requestedSats <= 0) {
    throw new Error("--amount-sats is required for lnurl-preflight");
  }
  if (requestedSats < lnurl.minSendableSats) {
    throw new Error(`LNURL amount must be >= ${lnurl.minSendableSats} sats`);
  }
  if (requestedSats > lnurl.maxSendableSats) {
    throw new Error(`LNURL amount must be <= ${lnurl.maxSendableSats} sats`);
  }
  logHarness("INFO", "VALIDATION", "Auth", "CliHarness", "lnurlResolved", {
    status: "ok",
    domain: lnurl.domain,
    sats: requestedSats,
    min: lnurl.minSendableSats,
    max: lnurl.maxSendableSats,
    expected_next: "request_invoice",
  });
  const invoice = await requestLnurlInvoice(lnurl.callback, requestedSats);
  const decoded = decodeInvoiceForPreflight(invoice);
  logHarness("INFO", "VALIDATION", "Auth", "CliHarness", "sdkInvoiceDecode", {
    status: "ok",
    sdk: "@arkade-os/swap",
    payment_hash: shortHash(decoded.paymentHash),
    sats: decoded.amountSats || "n/a",
    source: "lnurl",
  });
  const { attempt, amountSats } = await reserveDecodedInvoice(config, state, decoded, {
    source: "lnurl",
    domain: lnurl.domain,
  });
  return [
    "arkade_v4_cli_harness=lnurl_preflight_ok",
    `attempt=${attempt.id}`,
    `payment_hash=${decoded.paymentHash}`,
    `amount_sats=${amountSats}`,
    `domain=${lnurl.domain}`,
    `state_path=${config.statePath}`,
  ].join("\n");
}

export async function runHarness(argv = process.argv.slice(2), env = process.env) {
  const config = parseHarnessArgs(argv, env);
  const { state } = await loadHarnessState(config.statePath);
  if (config.flow === "invoice-preflight") {
    return {
      ...config,
      state,
      nuriServerCsv: NURI_SERVER_CSV_POLICY,
      statusText: await runInvoicePreflight(config, state),
    };
  }
  if (config.flow === "lnurl-preflight") {
    return {
      ...config,
      state,
      nuriServerCsv: NURI_SERVER_CSV_POLICY,
      statusText: await runLnurlPreflight(config, state),
    };
  }
  if (config.flow !== "status") {
    throw new Error(`unknown flow ${config.flow}`);
  }
  return {
    ...config,
    state,
    nuriServerCsv: NURI_SERVER_CSV_POLICY,
    statusText: formatHarnessStatus(config),
  };
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/arkade-v4-cli-harness.mjs --flow status --base-url URL --state PATH",
    "  node scripts/arkade-v4-cli-harness.mjs --flow invoice-preflight --invoice BOLT11",
    "  node scripts/arkade-v4-cli-harness.mjs --flow lnurl-preflight --lnurl LNURL --amount-sats SATS",
    "",
    "Env:",
    "  ARKADE_V4_BASE_URL, BASE_URL, HOST_V4, PORT_V4",
    "  ARKADE_V4_CLI_STATE_PATH, ARKADE_V4_STATE_PATH",
  ].join("\n");
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      console.log(usage());
    } else {
      const result = await runHarness();
      console.log(result.statusText);
    }
  } catch (error) {
    console.error(
      `🧪 ERROR FLOW grp=Auth scope=CliHarness act=main t=${shortTime()} dt=+0ms src=${SRC}#main message=${String(error.message || error).replace(/\s+/g, "_")}`,
    );
    process.exitCode = 1;
  }
}
