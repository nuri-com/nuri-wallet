import arkadeContractConfig from "../../config/arkadeContract.json";

export type ArkadeVersionCsvPolicy = {
  type: "blocks" | "seconds";
  value: number;
};

type ArkadeContractConfig = {
  nuri_server_api: string;
  nuri_server_version: string;
  nuri_contract_version: string;
  nuri_contract_type: string;
  arkade_sdk_version: string;
  bitcoin_tx_version: string;
  arkade_csv: string;
  nuri_csv: ArkadeVersionCsvPolicy;
};

const ARKADE_CONTRACT_CONFIG = arkadeContractConfig as ArkadeContractConfig;

export const NURI_SERVER_API_VERSION = ARKADE_CONTRACT_CONFIG.nuri_server_api;
export const NURI_SERVER_VERSION = ARKADE_CONTRACT_CONFIG.nuri_server_version;
export const NURI_CONTRACT_VERSION = ARKADE_CONTRACT_CONFIG.nuri_contract_version;
export const NURI_CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
export const ARKADE_SDK_VERSION = ARKADE_CONTRACT_CONFIG.arkade_sdk_version;
export const BITCOIN_TX_VERSION = ARKADE_CONTRACT_CONFIG.bitcoin_tx_version;
export const ARKADE_CSV_SOURCE = ARKADE_CONTRACT_CONFIG.arkade_csv;
// Seconds-based BIP68 values must match the signer server and protocol granularity.
export const NURI_CSV_POLICY = ARKADE_CONTRACT_CONFIG.nuri_csv;

export const ARKADE_CLIENT_VERSION = `nuri-app-arkade-debug-${NURI_CONTRACT_VERSION}`;
export const ARKADE_SDK_HINT = `@arkade-os/sdk/${ARKADE_SDK_VERSION}`;
export const ARKADE_EXPECTED_SIGNER_SERVER = NURI_SERVER_VERSION;
export const ARKADE_LIGHTNING_STATUS = "retired_boltz_engine_removed";
export const ARKADE_STRICT_AGGREGATED_KEY_MATCH = true;

function formatCsvPolicy(value: ArkadeVersionCsvPolicy | null | undefined): string {
  if (!value) return "n/a";
  return `${value.value}_${value.type}`;
}

export function formatArkadeVersionMatrix(
  fields: {
    arkadeCsv?: string | null;
    nuriCsv?: ArkadeVersionCsvPolicy | null;
    serverVersion?: string | null;
  } = {},
): string {
  return [
    `nuri_server_api=${NURI_SERVER_API_VERSION}`,
    `nuri_server_version=${fields.serverVersion || NURI_SERVER_VERSION}`,
    `nuri_contract_version=${NURI_CONTRACT_VERSION}`,
    `nuri_contract_type=${NURI_CONTRACT_TYPE}`,
    `arkade_sdk_version=${ARKADE_SDK_VERSION}`,
    `bitcoin_tx_version=${BITCOIN_TX_VERSION}`,
    `arkade_csv=${fields.arkadeCsv || ARKADE_CSV_SOURCE}`,
    `nuri_csv=${formatCsvPolicy(fields.nuriCsv || NURI_CSV_POLICY)}`,
  ].join(" ");
}
