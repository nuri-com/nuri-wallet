import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CONFIG_PATH = resolve(ROOT, "config/arkadeContract.json");

export const ARKADE_CONTRACT_CONFIG = Object.freeze(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));

export const NURI_SERVER_CSV_POLICY = Object.freeze({
  type: ARKADE_CONTRACT_CONFIG.nuri_csv.type,
  value: ARKADE_CONTRACT_CONFIG.nuri_csv.value,
});

export function formatCsvPolicy(policy = NURI_SERVER_CSV_POLICY) {
  return `${policy.value}_${policy.type}`;
}

export function versionMatrixFields({
  arkadeCsv = ARKADE_CONTRACT_CONFIG.arkade_csv,
  nuriCsv = NURI_SERVER_CSV_POLICY,
  bitcoinTxVersion = ARKADE_CONTRACT_CONFIG.bitcoin_tx_version,
  serverVersion = ARKADE_CONTRACT_CONFIG.nuri_server_version,
} = {}) {
  return {
    nuri_server_api: ARKADE_CONTRACT_CONFIG.nuri_server_api,
    nuri_server_version: serverVersion,
    nuri_contract_version: ARKADE_CONTRACT_CONFIG.nuri_contract_version,
    nuri_contract_type: ARKADE_CONTRACT_CONFIG.nuri_contract_type,
    arkade_sdk_version: ARKADE_CONTRACT_CONFIG.arkade_sdk_version,
    bitcoin_tx_version: bitcoinTxVersion,
    arkade_csv: arkadeCsv,
    nuri_csv: formatCsvPolicy(nuriCsv),
  };
}
