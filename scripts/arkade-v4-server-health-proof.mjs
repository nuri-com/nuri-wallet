#!/usr/bin/env node
import {
  ARKADE_CONTRACT_CONFIG,
  formatCsvPolicy,
  versionMatrixFields,
} from "./arkade-version-matrix.mjs";

const SRC = "scripts/arkade-v4-server-health-proof.mjs";

function shortTime(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}

function log(level, eventType, event, fields = {}) {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(
    `🔐 [${shortTime()} src=${SRC}#main ${level} ${eventType} grp=Bitcoin] ${event} ${details}`.trim(),
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return String(process.argv[index + 1] || "").trim();
}

function usage() {
  return "Usage: node scripts/arkade-v4-server-health-proof.mjs --base-url http://127.0.0.1:13946";
}

function parseBaseUrl() {
  const raw = readArg("--base-url").replace(/\/+$/, "");
  assert(raw, `--base-url is required. ${usage()}`);
  const url = new URL(raw);
  assert(url.protocol === "http:" || url.protocol === "https:", "--base-url must be http(s)");
  return url;
}

function buildUrl(baseUrl, path) {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`.replace(
    /^\/+/,
    "/",
  );
  return url;
}

async function requestJson(baseUrl, path) {
  const url = buildUrl(baseUrl, path);
  const startedAt = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    status = res.status;
    let body = {};
    try {
      body = await res.json();
    } catch {}
    return { ok: res.ok, status, body };
  } finally {
    const dur = Date.now() - startedAt;
    log("INFO", "API", "HTTP_GET", {
      method: "GET",
      host: url.host,
      path: url.pathname,
      status,
      dur: `${dur}ms`,
    });
  }
}

function assertCsvPolicy(value, label) {
  assert(value?.type === ARKADE_CONTRACT_CONFIG.nuri_csv.type, `${label} type mismatch`);
  assert(value?.value === ARKADE_CONTRACT_CONFIG.nuri_csv.value, `${label} value mismatch`);
}

function assertVersionMatrix(body, label) {
  assert(body?.nuri_server_api === ARKADE_CONTRACT_CONFIG.nuri_server_api, `${label} api mismatch`);
  assert(
    body?.nuri_server_version === ARKADE_CONTRACT_CONFIG.nuri_server_version,
    `${label} server version mismatch`,
  );
  assert(
    body?.nuri_contract_version === ARKADE_CONTRACT_CONFIG.nuri_contract_version,
    `${label} contract version mismatch`,
  );
  assert(
    body?.nuri_contract_type === ARKADE_CONTRACT_CONFIG.nuri_contract_type,
    `${label} contract type mismatch`,
  );
  assert(
    body?.arkade_sdk_version === ARKADE_CONTRACT_CONFIG.arkade_sdk_version,
    `${label} sdk version mismatch`,
  );
  assert(
    body?.bitcoin_tx_version === ARKADE_CONTRACT_CONFIG.bitcoin_tx_version,
    `${label} bitcoin tx version mismatch`,
  );
  assert(body?.arkade_csv === ARKADE_CONTRACT_CONFIG.arkade_csv, `${label} arkade CSV mismatch`);
  assertCsvPolicy(body?.nuri_csv, `${label} nuri_csv`);
}

function assertRecoveryPolicy(policy) {
  const expectedCsv = ARKADE_CONTRACT_CONFIG.nuri_csv;
  const expectedCsvLabel = formatCsvPolicy(expectedCsv);
  assert(policy && typeof policy === "object", "recovery_policy must be an object");
  assert(policy.type === "taproot_musig2_with_csv_client_exit", "recovery_policy.type mismatch");
  assert(
    policy.nuri_server_csv?.type === expectedCsv.type,
    `recovery_policy CSV type must be ${expectedCsv.type}`,
  );
  assert(
    policy.nuri_server_csv?.value === expectedCsv.value,
    `recovery_policy CSV value must be ${expectedCsv.value}`,
  );
  assert(
    policy.cooperative_path === "musig2(client_pubkey,server_pubkey)",
    "recovery_policy cooperative_path mismatch",
  );
  assert(
    policy.recovery_path === `and_v(v:pk(client_pubkey),older(${expectedCsvLabel}))`,
    `recovery_policy recovery_path must use ${expectedCsvLabel}`,
  );
  assert(policy.client_key_exit_after_csv === true, "client_key_exit_after_csv must be true");
  assert(
    policy.server_key_required_before_csv === true,
    "server_key_required_before_csv must be true",
  );
  assert(policy.server_key_expires === true, "server_key_expires must be true");
}

async function main() {
  const baseUrl = parseBaseUrl();
  const health = await requestJson(baseUrl, "/health");
  assert(health.ok, `health failed status=${health.status} error=${health.body?.error || "n/a"}`);
  assert(health.body?.ok === true, "health ok must be true");
  assertVersionMatrix(health.body, "health");
  assertCsvPolicy(health.body?.nuri_server_csv, "health nuri_server_csv");
  assertRecoveryPolicy(health.body?.recovery_policy);

  const ready = await requestJson(baseUrl, "/ready");
  assert(ready.ok, `ready failed status=${ready.status} error=${ready.body?.error || "n/a"}`);
  assert(ready.body?.ok === true, "ready ok must be true");
  assertVersionMatrix(ready.body, "ready");
  assert(ready.body?.database?.ok === true, "ready database must be ok");

  log("INFO", "FLOW", "ARKADE_V4_SERVER_HEALTH_PROOF_PASS", {
    ...versionMatrixFields({
      nuriCsv: health.body?.nuri_csv || health.body?.nuri_server_csv,
      serverVersion: health.body?.nuri_server_version || health.body?.version,
    }),
    base: baseUrl.toString().replace(/\/+$/, ""),
    version: health.body.version,
    csv: formatCsvPolicy(ARKADE_CONTRACT_CONFIG.nuri_csv),
    recovery_policy: health.body.recovery_policy.type,
  });
}

main().catch((error) => {
  log("ERROR", "FLOW", "ARKADE_V4_SERVER_HEALTH_PROOF_FAIL", {
    err: JSON.stringify(String(error?.message || error)),
  });
  process.exitCode = 1;
});
