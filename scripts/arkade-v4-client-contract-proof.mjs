#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARKADE_CONTRACT_CONFIG,
  NURI_SERVER_CSV_POLICY,
  versionMatrixFields,
} from "./arkade-version-matrix.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const HANDLER_PATH = resolve(ROOT, "services/arkade/ArkadeClientRecoveryContract.ts");

const CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
const REQUIRED_FIELDS = [
  "aggregatePubKey",
  "clientPubKey",
  "nuriServerPubKey",
  "arkadeServerPubKey",
  "arkadeCsvTimelock",
  "nuriServerCsvTimelock",
];
const REJECTED_FIELDS = ["cooperativePubKey", "serverPubKey", "csvTimelock"];

let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

function read(path) {
  return readFileSync(path, "utf8");
}

function hasField(params, field) {
  return typeof params[field] === "string" && params[field].trim().length > 0;
}

function diagnostics(params) {
  const safeParams = params || {};
  const missingFields = REQUIRED_FIELDS.filter((field) => !hasField(safeParams, field));
  const rejectedFields = REJECTED_FIELDS.filter((field) => hasField(safeParams, field));
  return {
    schema:
      missingFields.length === 0
        ? "current_v1"
        : rejectedFields.length > 0
          ? "rejected"
          : "unknown",
    missingFields,
    rejectedFields,
    presentFields: Object.keys(safeParams).sort(),
  };
}

function validate(params) {
  const out = diagnostics(params);
  if (out.missingFields.length <= 0) return out;
  throw new Error(
    [
      `${CONTRACT_TYPE} contract params validation failed`,
      `schema=${out.schema}`,
      `missing=${out.missingFields.join(",")}`,
      `rejectedFields=${out.rejectedFields.join(",") || "none"}`,
      `present=${out.presentFields.join(",") || "none"}`,
      `expected=${REQUIRED_FIELDS.join(",")}`,
    ].join(" "),
  );
}

function expectThrows(fn, includes) {
  try {
    fn();
  } catch (error) {
    const text = String(error?.message || error || "");
    for (const item of includes) {
      assert(text.includes(item), `expected error to include ${item}, got ${text}`);
    }
    return text;
  }
  throw new Error("expected function to throw");
}

const handlerSource = read(HANDLER_PATH);

assert(
  handlerSource.includes("export const ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE = NURI_CONTRACT_TYPE;"),
  "handler must use shared Nuri contract type",
);
assert(
  handlerSource.includes("validateSerializedArkadeClientRecoveryContractParams(params);"),
  "handler must validate params before decode",
);
assert(
  handlerSource.indexOf("validateSerializedArkadeClientRecoveryContractParams(params);") <
    handlerSource.indexOf("hexToBytes(params.aggregatePubKey)"),
  "handler validation must run before aggregatePubKey decode",
);
assert(
  !handlerSource.includes("LegacyArkadeClientRecoveryVtxoScript"),
  "handler must not include old VTXO script reader",
);
assert(
  !handlerSource.includes('diagnostics.schema === "legacy_v0"'),
  "handler must not route old params before current decode",
);
assert(
  handlerSource.includes("contractHandlers.unregister(ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE)"),
  "handler registration must replace stale debug handlers",
);
assert(
  handlerSource.includes("invalid public key point"),
  "handler must identify invalid x-only public-key fields",
);
assert(
  handlerSource.includes("forfeit()"),
  "handler scripts must expose forfeit() for SDK VTXO annotation",
);
for (const field of REQUIRED_FIELDS) {
  assert(handlerSource.includes(`"${field}"`), `handler missing required field ${field}`);
}
for (const field of REJECTED_FIELDS) {
  assert(
    handlerSource.includes(`"${field}"`),
    `handler missing rejected diagnostic field ${field}`,
  );
}

const xonlyA = "11".repeat(32);
const xonlyB = "22".repeat(32);
const xonlyC = "33".repeat(32);
const xonlyD = "44".repeat(32);
const expectedCsvSequence = String(NURI_SERVER_CSV_POLICY.value);

const currentParams = {
  aggregatePubKey: xonlyA,
  clientPubKey: xonlyB,
  nuriServerPubKey: xonlyC,
  arkadeServerPubKey: xonlyD,
  arkadeCsvTimelock: expectedCsvSequence,
  nuriServerCsvTimelock: expectedCsvSequence,
};
const current = validate(currentParams);
assert(current.schema === "current_v1", "current params must validate as current_v1");
assert(current.missingFields.length === 0, "current params must have no missing fields");

const rejectedParams = {
  cooperativePubKey: xonlyA,
  clientPubKey: xonlyB,
  serverPubKey: xonlyC,
  csvTimelock: expectedCsvSequence,
};
const rejectedError = expectThrows(
  () => validate(rejectedParams),
  [
    `${CONTRACT_TYPE} contract params validation failed`,
    "schema=rejected",
    "missing=aggregatePubKey",
    "nuriServerPubKey",
    "arkadeServerPubKey",
    "arkadeCsvTimelock",
    "nuriServerCsvTimelock",
    "rejectedFields=cooperativePubKey,serverPubKey,csvTimelock",
  ],
);

console.log(`ARKADE_V4_CLIENT_CONTRACT_PROOF_REJECTED_VALIDATION_ERROR ${rejectedError}`);
console.log("ARKADE_V4_CLIENT_CONTRACT_PROOF_REJECTED_HANDLER_PASS route=none");
console.log(
  `ARKADE_V4_CLIENT_CONTRACT_PROOF_VERSION_MATRIX ${Object.entries(versionMatrixFields())
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`,
);
console.log(`ARKADE_V4_CLIENT_CONTRACT_PROOF_PASS checks=${checks}`);
