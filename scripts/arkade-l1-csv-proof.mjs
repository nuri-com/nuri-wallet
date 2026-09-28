#!/usr/bin/env node

const DEFAULT_API = "https://mempool.space/api";
const DEFAULT_CSV_BLOCKS = 3;

function usage() {
  console.log(`Usage:
  node scripts/arkade-l1-csv-proof.mjs --address <bc1p...> [--csv-blocks 3] [--api https://mempool.space/api]

Readonly check for the Arkade -> Bitcoin L1 CSV proof address.
It fetches tip height and UTXOs, then reports CSV maturity.`);
}

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function shortAddress(address) {
  return address.length > 18 ? `${address.slice(0, 10)}...${address.slice(-6)}` : address;
}

function proofLog(message) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(
    `₿ [${time} src=scripts/arkade-l1-csv-proof.mjs#main INFO FLOW grp=Bitcoin] NURI_L1_CSV_PROOF ${message}`,
  );
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} ${await response.text()}`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const address = readArg("--address").trim();
  const api = readArg("--api", DEFAULT_API).replace(/\/+$/, "");
  const csvBlocks = Number.parseInt(readArg("--csv-blocks", String(DEFAULT_CSV_BLOCKS)), 10);

  if (!address) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(csvBlocks) || csvBlocks <= 0) {
    throw new Error(`invalid --csv-blocks ${csvBlocks}`);
  }

  proofLog(`probe_start address=${shortAddress(address)} csv=${csvBlocks} api=${api}`);
  const height = Number.parseInt(await fetchText(`${api}/blocks/tip/height`), 10);
  if (!Number.isFinite(height)) {
    throw new Error("invalid tip height response");
  }
  const utxos = await fetchJson(`${api}/address/${address}/utxo`);
  if (!Array.isArray(utxos)) {
    throw new Error("invalid UTXO response");
  }

  let total = 0;
  let recoverable = 0;
  for (const utxo of utxos) {
    const value = Math.max(0, Math.trunc(Number(utxo.value || 0)));
    total += value;
    const confirmed = Boolean(utxo.status?.confirmed);
    const blockHeight = Number(utxo.status?.block_height || 0);
    const unlockHeight = confirmed ? blockHeight + csvBlocks : 0;
    const remaining = confirmed ? Math.max(0, unlockHeight - height) : Number.POSITIVE_INFINITY;
    const mature = confirmed && remaining === 0;
    if (mature) recoverable += value;
    proofLog(
      `utxo txid=${String(utxo.txid || "").slice(0, 12)}:${utxo.vout} sats=${value} confirmed=${confirmed ? 1 : 0} confirmed_height=${blockHeight || "n/a"} unlock_height=${unlockHeight || "n/a"} remaining=${Number.isFinite(remaining) ? remaining : "unconfirmed"} recoverable=${mature ? 1 : 0}`,
    );
  }

  proofLog(
    `probe_done height=${height} utxos=${utxos.length} total_sats=${total} recoverable_sats=${recoverable} ready=${recoverable > 0 ? 1 : 0}`,
  );
}

main().catch((error) => {
  proofLog(`probe_failed err=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
