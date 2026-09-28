#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { OnchainWallet, SingleKey, Transaction } from "@arkade-os/sdk";

const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-l1-csv-proof-v2-mainnet.json",
);
const DEFAULT_FEE_SATS = 2000;
const DUST_SATS = 546;

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const statePath = arg("--state", DEFAULT_STATE_PATH);
  const destination = arg("--to").trim();
  const feeSats = Number.parseInt(arg("--fee-sats", String(DEFAULT_FEE_SATS)), 10);
  assert(destination, "--to is required");
  assert(Number.isInteger(feeSats) && feeSats > 0, "--fee-sats must be positive");

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert(typeof state.clientKeyHex === "string", "state missing client key");
  assert(typeof state.expectedAnchorAddress === "string", "state missing anchor address");

  const identity = SingleKey.fromHex(state.clientKeyHex);
  const wallet = await OnchainWallet.create(identity, "bitcoin");
  assert(
    wallet.address === state.expectedAnchorAddress,
    `anchor address mismatch expected=${state.expectedAnchorAddress} got=${wallet.address}`,
  );

  const coins = await wallet.getCoins();
  assert(coins.length > 0, "anchor wallet has no UTXOs");
  const total = coins.reduce((sum, coin) => sum + Number(coin.value || 0), 0);
  const sendAmount = total - feeSats;
  assert(sendAmount >= DUST_SATS, `send amount below dust: ${sendAmount}`);

  let tx = new Transaction({ version: 2 });
  for (const coin of coins) {
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      witnessUtxo: {
        script: wallet.onchainP2TR.script,
        amount: BigInt(coin.value),
      },
      tapInternalKey: wallet.onchainP2TR.tapInternalKey,
    });
  }
  tx.addOutputAddress(destination, BigInt(sendAmount), wallet.network);
  tx = await identity.sign(tx);
  tx.finalize();

  console.log(
    `ANCHOR_SWEEP_READY from=${wallet.address} to=${destination} inputs=${coins.length} total_sats=${total} fee_sats=${feeSats} send_sats=${sendAmount} txid=${tx.id}`,
  );
  const txid = await wallet.provider.broadcastTransaction(tx.hex);
  console.log(`ANCHOR_SWEEP_BROADCAST txid=${txid}`);
}

main().catch((error) => {
  console.error(`ANCHOR_SWEEP_FAILED ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
