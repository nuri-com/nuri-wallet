#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  CSVMultisigTapscript,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  OnchainWallet,
  SingleKey,
  Transaction,
  Unroll,
  VtxoScript,
  Wallet,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { EventSource } from "eventsource";

const SRC = "scripts/arkade-vtxo-recovery-check.mjs";
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-compat-e2e-arkade-exit-delay-mainnet.json",
);

function shortTime(date = new Date()) {
  return date.toISOString().slice(11, 23);
}

function log(level, action, fields = {}) {
  const parts = [
    `🔎 ${level}`,
    "FLOW",
    "grp=Bitcoin",
    `act=${action}`,
    `t=${shortTime()}`,
    `src=${SRC}#main`,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, "_")}`);
  }
  console.log(parts.join(" "));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function includesKey(pubkeys, expected) {
  return Array.isArray(pubkeys) && pubkeys.some((pubkey) => sameBytes(pubkey, expected));
}

function truncateMiddle(value, max = 40) {
  const raw = String(value || "");
  if (raw.length <= max) return raw;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function normalizeTimelock(timelock) {
  assert(timelock && typeof timelock === "object", "Arkade user-exit CSV missing");
  assert(
    timelock.type === "blocks" || timelock.type === "seconds",
    `Arkade user-exit CSV has invalid type ${timelock.type}`,
  );
  const value = typeof timelock.value === "bigint" ? timelock.value : BigInt(timelock.value);
  assert(value > 0n, "Arkade user-exit CSV must be positive");
  return { type: timelock.type, value };
}

function formatTimelock(timelock) {
  const normalized = normalizeTimelock(timelock);
  return `${normalized.value.toString()}_${normalized.type}`;
}

function timelockEquals(a, b) {
  try {
    const left = normalizeTimelock(a);
    const right = normalizeTimelock(b);
    return left.type === right.type && left.value === right.value;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {
    nodeUrl: DEFAULT_NODE_URL,
    esploraUrl: DEFAULT_ESPLORA_URL,
    statePath: DEFAULT_STATE_PATH,
    broadcastUnroll: false,
    outpoint: "",
    feeKey: "receiver",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--node") {
      args.nodeUrl = String(next || "");
      i += 1;
    } else if (arg === "--esplora") {
      args.esploraUrl = String(next || "");
      i += 1;
    } else if (arg === "--state") {
      args.statePath = String(next || "");
      i += 1;
    } else if (arg === "--broadcast-unroll") {
      args.broadcastUnroll = true;
    } else if (arg === "--outpoint") {
      args.outpoint = String(next || "");
      i += 1;
    } else if (arg === "--fee-key") {
      args.feeKey = String(next || "");
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.feeKey !== "receiver" && args.feeKey !== "client") {
    throw new Error("--fee-key must be receiver or client");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-vtxo-recovery-check.mjs
  node scripts/arkade-vtxo-recovery-check.mjs --state /path/to/state.json
  node scripts/arkade-vtxo-recovery-check.mjs --broadcast-unroll --outpoint <txid:vout>

Checks current VTXOs without broadcasting:
  - exact custom tapTree bytes
  - Arkade collaborative leaf
  - Nuri-client-only recovery leaf
  - Arkade user-exit CSV
  - local Nuri client Schnorr signature

Broadcast mode:
  --broadcast-unroll       Broadcast the selected VTXO unroll package
  --outpoint <txid:vout>   Optional exact VTXO to unroll
  --fee-key receiver|client Anchor fee key from state. Default: receiver`);
}

class NuriAggregateIdentity {
  constructor(clientKeyHex, nuriServerKeyHex) {
    this.clientKey = hex.decode(clientKeyHex);
    this.nuriServerKey = hex.decode(nuriServerKeyHex);
    this.clientPk33 = pubECDSA(this.clientKey, true);
    this.nuriServerPk33 = pubECDSA(this.nuriServerKey, true);
    this.sortedKeys = musig2.sortKeys([this.clientPk33, this.nuriServerPk33]);
    this.aggregatedPk33 = musig2.keyAggregate(this.sortedKeys).aggPublicKey.toBytes(true);
    this.aggregatedXonly = this.aggregatedPk33.slice(1);
  }

  async compressedPublicKey() {
    return this.aggregatedPk33;
  }

  async xOnlyPublicKey() {
    return this.aggregatedXonly;
  }

  signerSession() {
    return SingleKey.fromRandomBytes().signerSession();
  }

  async signMessage() {
    throw new Error("aggregate signing is intentionally unused in recovery check");
  }
}

class NuriRecoveryScript extends VtxoScript {
  constructor({ cooperativePubKey, clientPubKey, serverPubKey, arkadeUserExitCsv }) {
    const forfeit = MultisigTapscript.encode({
      pubkeys: [cooperativePubKey, serverPubKey],
    });
    const recovery = CSVMultisigTapscript.encode({
      timelock: arkadeUserExitCsv,
      pubkeys: [clientPubKey],
    });
    super([forfeit.script, recovery.script]);
    this.forfeitScript = hex.encode(forfeit.script);
    this.recoveryScript = hex.encode(recovery.script);
  }

  forfeit() {
    return this.findLeaf(this.forfeitScript);
  }

  recovery() {
    return this.findLeaf(this.recoveryScript);
  }
}

async function loadState(statePath) {
  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  assert(typeof state.clientKeyHex === "string", "state missing clientKeyHex");
  assert(typeof state.nuriServerKeyHex === "string", "state missing nuriServerKeyHex");
  return state;
}

async function createWallet(args, aggregateIdentity, expectedScript, defaultScript) {
  const wallet = await Wallet.create({
    identity: aggregateIdentity,
    arkServerUrl: args.nodeUrl,
    esploraUrl: args.esploraUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });

  const expectedScriptHex = hex.encode(expectedScript.pkScript);
  const defaultScriptHex = hex.encode(defaultScript.pkScript);
  wallet.getWalletScripts = async function getRecoveryCheckWalletScripts() {
    return [...new Set([expectedScriptHex, defaultScriptHex])];
  };
  wallet.getScriptMap = async function getRecoveryCheckScriptMap() {
    return new Map([
      [expectedScriptHex, expectedScript],
      [defaultScriptHex, defaultScript],
    ]);
  };
  return wallet;
}

function decodeLeaves(tapTree) {
  const decoded = VtxoScript.decode(tapTree);
  const csvLeaves = [];
  const multisigLeaves = [];
  for (const script of decoded.scripts) {
    try {
      csvLeaves.push({
        scriptHex: hex.encode(script),
        decoded: CSVMultisigTapscript.decode(script),
      });
      continue;
    } catch {}
    try {
      multisigLeaves.push({
        scriptHex: hex.encode(script),
        decoded: MultisigTapscript.decode(script),
      });
    } catch {}
  }
  return { decoded, csvLeaves, multisigLeaves };
}

function vtxoOutpoint(vtxo) {
  return `${vtxo.txid}:${vtxo.vout}`;
}

function parseOutpoint(raw) {
  const [txid, voutRaw] = String(raw || "").split(":");
  const vout = Number(voutRaw);
  if (!/^[0-9a-f]{64}$/i.test(txid || "") || !Number.isInteger(vout) || vout < 0) {
    throw new Error(`invalid outpoint: ${raw}`);
  }
  return { txid, vout };
}

function txFromHex(rawHex) {
  return Transaction.fromRaw(hex.decode(rawHex));
}

function findOutputWithScript(tx, scriptHex) {
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i);
    if (hex.encode(output?.script || new Uint8Array()) === scriptHex) {
      return { index: i, amount: output.amount };
    }
  }
  return null;
}

async function fetchTxHex(esploraUrl, txid) {
  const response = await fetch(`${esploraUrl.replace(/\/$/, "")}/tx/${txid}/hex`);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`fetch_tx_hex_failed ${response.status} ${body}`.slice(0, 180));
  }
  return response.text();
}

async function assertNodeKnowsTx(provider, txid) {
  try {
    await provider.getTxStatus(txid);
    return true;
  } catch {
    return false;
  }
}

async function verifyClientSignature(clientIdentity, clientPubKey, vtxo, recoveryScriptHex) {
  const challenge = createHash("sha256")
    .update("nuri-vtxo-recovery-check-v1")
    .update(vtxo.txid)
    .update(String(vtxo.vout))
    .update(recoveryScriptHex)
    .digest();
  const signature = await clientIdentity.signMessage(new Uint8Array(challenge), "schnorr");
  return schnorr.verify(signature, new Uint8Array(challenge), clientPubKey);
}

async function checkVtxo(vtxo, context) {
  const {
    aggregatePubKey,
    arkadeServerPubKey,
    clientIdentity,
    clientPubKey,
    expectedScript,
    expectedScriptHex,
    nuriServerPubKey,
    arkadeUserExitCsv,
    network,
  } = context;
  const failures = [];
  if (!vtxo.tapTree) failures.push("missing_tapTree");

  const actualScriptHex = String(vtxo.script || "");
  if (actualScriptHex !== expectedScriptHex) {
    failures.push(`wrong_script:${truncateMiddle(actualScriptHex || "empty", 24)}`);
  }

  let onchainAddress = "";
  let l1Script = "";
  if (vtxo.tapTree) {
    try {
      const { decoded, csvLeaves, multisigLeaves } = decodeLeaves(vtxo.tapTree);
      onchainAddress = decoded.onchainAddress(network);
      l1Script = hex.encode(decoded.pkScript);

      const exactForfeit = multisigLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return (
          leaf.scriptHex === expectedScript.forfeitScript &&
          pubkeys.length === 2 &&
          sameBytes(pubkeys[0], aggregatePubKey) &&
          sameBytes(pubkeys[1], arkadeServerPubKey)
        );
      });
      if (exactForfeit.length !== 1) failures.push(`forfeit_leaf_count:${exactForfeit.length}`);

      const recoveryLeaves = csvLeaves.filter(
        (leaf) => leaf.scriptHex === expectedScript.recoveryScript,
      );
      if (recoveryLeaves.length !== 1)
        failures.push(`recovery_leaf_count:${recoveryLeaves.length}`);
      const recovery = recoveryLeaves[0]?.decoded;
      const recoveryPubkeys = recovery?.params?.pubkeys || [];
      if (recoveryPubkeys.length !== 1 || !sameBytes(recoveryPubkeys[0], clientPubKey)) {
        failures.push("recovery_not_client_only");
      }
      if (!timelockEquals(recovery?.params?.timelock, arkadeUserExitCsv)) {
        failures.push("recovery_not_arkade_user_exit_csv");
      }
      if (
        includesKey(recoveryPubkeys, aggregatePubKey) ||
        includesKey(recoveryPubkeys, arkadeServerPubKey) ||
        includesKey(recoveryPubkeys, nuriServerPubKey)
      ) {
        failures.push("server_or_aggregate_key_in_recovery_leaf");
      }
    } catch (error) {
      failures.push(`decode_failed:${String(error?.message || error).slice(0, 80)}`);
    }
  }

  const signatureOk =
    failures.length === 0 &&
    (await verifyClientSignature(
      clientIdentity,
      clientPubKey,
      vtxo,
      expectedScript.recoveryScript,
    ));
  if (!signatureOk) failures.push("client_signature_check_failed");

  const pass = failures.length === 0;
  log(pass ? "INFO" : "ERROR", pass ? "VTXO_RECOVERABLE_PASS" : "VTXO_RECOVERABLE_FAIL", {
    outpoint: vtxoOutpoint(vtxo),
    value: vtxo.value,
    state: vtxo.virtualStatus?.state || "unknown",
    spent: vtxo.isSpent || false,
    unrolled: vtxo.isUnrolled || false,
    l1: truncateMiddle(onchainAddress, 42),
    l1_script: truncateMiddle(l1Script, 34),
    arkade_user_exit_csv: formatTimelock(arkadeUserExitCsv),
    failures: failures.join(",") || "none",
  });
  return pass;
}

function selectBroadcastVtxo(candidates, requestedOutpoint) {
  if (requestedOutpoint) {
    const wanted = parseOutpoint(requestedOutpoint);
    const selected = candidates.find(
      (vtxo) => vtxo.txid === wanted.txid && Number(vtxo.vout) === wanted.vout,
    );
    assert(selected, `requested outpoint did not pass recovery check: ${requestedOutpoint}`);
    return selected;
  }
  assert(candidates.length > 0, "no recoverable unspent VTXO available to unroll");
  if (candidates.length > 1) {
    throw new Error("multiple recoverable VTXOs found; pass --outpoint <txid:vout>");
  }
  return candidates[0];
}

async function broadcastUnrollProof({ args, state, wallet, selectedVtxo, expectedScriptHex }) {
  const feeKeyHex =
    args.feeKey === "receiver" ? String(state.receiverKeyHex || "") : String(state.clientKeyHex);
  assert(feeKeyHex, `state missing ${args.feeKey} fee key`);

  const feeIdentity = SingleKey.fromHex(feeKeyHex);
  const bumper = await OnchainWallet.create(
    feeIdentity,
    wallet.networkName,
    wallet.onchainProvider,
  );
  const feeBalance = await bumper.getBalance();
  log("INFO", "UNROLL_FEE_WALLET", {
    key: args.feeKey,
    address: truncateMiddle(bumper.address, 42),
    balance: feeBalance,
  });
  if (feeBalance <= 0) {
    log("ERROR", "UNROLL_BROADCAST_BLOCKED", {
      reason: "fee_wallet_has_no_onchain_funds",
      fee_key: args.feeKey,
      fund_address: bumper.address,
    });
    return false;
  }

  const target = { txid: selectedVtxo.txid, vout: selectedVtxo.vout };
  const session = await Unroll.Session.create(
    target,
    bumper,
    wallet.onchainProvider,
    wallet.indexerProvider,
  );
  const step = await session.next();
  const stepType = Object.keys(Unroll.StepType).find((key) => Unroll.StepType[key] === step.type);

  if (step.type === Unroll.StepType.DONE) {
    log("INFO", "UNROLL_ALREADY_DONE", { checked_vtxo: vtxoOutpoint(selectedVtxo) });
    return true;
  }

  if (step.type === Unroll.StepType.WAIT) {
    const parentHex = await fetchTxHex(args.esploraUrl, step.txid);
    const parentTx = txFromHex(parentHex);
    const output = findOutputWithScript(parentTx, expectedScriptHex);
    assert(output, "existing unroll tx does not contain expected L1 script");
    log("INFO", "UNROLL_ALREADY_ACCEPTED", {
      checked_vtxo: vtxoOutpoint(selectedVtxo),
      unroll_parent_txid: step.txid,
      node_accept: "pass",
      l1_script_match: "pass",
      output_index: output.index,
      output_amount: output.amount,
    });
    return true;
  }

  assert(step.type === Unroll.StepType.UNROLL, `unexpected unroll step ${stepType || step.type}`);
  const expectedOutput = findOutputWithScript(step.tx, expectedScriptHex);
  assert(expectedOutput, "unroll tx does not contain expected L1 script before broadcast");

  const [parentHex, childHex] = await bumper.bumpP2A(step.tx);
  const parentTx = txFromHex(parentHex);
  const childTx = txFromHex(childHex);
  const parentTxid = parentTx.id;
  const childTxid = childTx.id;
  const parentAccepted = await assertNodeKnowsTx(wallet.onchainProvider, parentTxid);
  const childAccepted = await assertNodeKnowsTx(wallet.onchainProvider, childTxid);
  const parentOutput = findOutputWithScript(parentTx, expectedScriptHex);
  const accepted = parentAccepted && childAccepted && !!parentOutput;

  log(accepted ? "INFO" : "ERROR", accepted ? "UNROLL_BROADCAST_PASS" : "UNROLL_BROADCAST_FAIL", {
    checked_vtxo: vtxoOutpoint(selectedVtxo),
    unroll_parent_txid: parentTxid,
    anchor_child_txid: childTxid,
    node_accept_parent: parentAccepted ? "pass" : "fail",
    node_accept_child: childAccepted ? "pass" : "fail",
    l1_script_match: parentOutput ? "pass" : "fail",
    output_index: parentOutput?.index ?? "",
    output_amount: parentOutput?.amount ?? "",
    expected_l1_script: truncateMiddle(expectedScriptHex, 34),
    actual_l1_script: parentOutput ? truncateMiddle(expectedScriptHex, 34) : "missing",
  });
  return accepted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!globalThis.EventSource) globalThis.EventSource = EventSource;

  const state = await loadState(args.statePath);
  const aggregateIdentity = new NuriAggregateIdentity(state.clientKeyHex, state.nuriServerKeyHex);
  const clientIdentity = SingleKey.fromHex(state.clientKeyHex);
  const nuriServerIdentity = SingleKey.fromHex(state.nuriServerKeyHex);
  const aggregatePubKey = await aggregateIdentity.xOnlyPublicKey();
  const clientPubKey = await clientIdentity.xOnlyPublicKey();
  const nuriServerPubKey = await nuriServerIdentity.xOnlyPublicKey();

  const setupWallet = await Wallet.create({
    identity: aggregateIdentity,
    arkServerUrl: args.nodeUrl,
    esploraUrl: args.esploraUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });
  const defaultScript = setupWallet.offchainTapscript;
  const arkadeServerPubKey = setupWallet.arkServerPublicKey;
  const arkadeUserExitCsv = normalizeTimelock(defaultScript.options.csvTimelock);
  const expectedScript = new NuriRecoveryScript({
    cooperativePubKey: aggregatePubKey,
    clientPubKey,
    serverPubKey: arkadeServerPubKey,
    arkadeUserExitCsv,
  });
  const expectedScriptHex = hex.encode(expectedScript.pkScript);
  const expectedAddress = expectedScript
    .address(setupWallet.network.hrp, arkadeServerPubKey)
    .encode();
  await setupWallet.dispose?.();

  const pinnedAddress = String(state.expectedSenderArkAddress || "");
  if (pinnedAddress && pinnedAddress !== expectedAddress) {
    log("ERROR", "PINNED_ADDRESS_MISMATCH", {
      pinned: truncateMiddle(pinnedAddress, 42),
      computed: truncateMiddle(expectedAddress, 42),
    });
    process.exitCode = 1;
    return;
  }

  const wallet = await createWallet(args, aggregateIdentity, expectedScript, defaultScript);
  const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
  log("INFO", "EXPECTED_SCRIPT", {
    arkade_address: truncateMiddle(expectedAddress, 42),
    l1_address: truncateMiddle(expectedScript.onchainAddress(wallet.network), 42),
    arkade_user_exit_csv: formatTimelock(arkadeUserExitCsv),
    vtxos: vtxos.length,
  });

  if (vtxos.length === 0) {
    log("ERROR", "NO_VTXOS_FOUND", {
      checked_scripts: 2,
      reason: "no_current_vtxos_for_expected_or_default_script",
    });
    process.exitCode = 1;
    await wallet.dispose?.();
    return;
  }

  let passCount = 0;
  let checkedCount = 0;
  let skippedSpentCount = 0;
  const recoverableCandidates = [];
  for (const vtxo of vtxos) {
    if (vtxo.isSpent) {
      skippedSpentCount += 1;
      log("INFO", "VTXO_SKIPPED_SPENT", {
        outpoint: vtxoOutpoint(vtxo),
        value: vtxo.value,
        state: vtxo.virtualStatus?.state || "unknown",
        unrolled: vtxo.isUnrolled || false,
      });
      continue;
    }
    checkedCount += 1;
    const pass = await checkVtxo(vtxo, {
      aggregatePubKey,
      arkadeServerPubKey,
      arkadeUserExitCsv,
      clientIdentity,
      clientPubKey,
      expectedScript,
      expectedScriptHex,
      network: wallet.network,
      nuriServerPubKey,
    });
    if (pass) {
      passCount += 1;
      if (!vtxo.isUnrolled) recoverableCandidates.push(vtxo);
    }
  }

  const verdict = checkedCount > 0 && passCount === checkedCount ? "PASS" : "FAIL";
  log(verdict === "PASS" ? "INFO" : "ERROR", "SUMMARY", {
    verdict,
    pass: passCount,
    checked: checkedCount,
    skipped_spent: skippedSpentCount,
    total_seen: vtxos.length,
  });
  if (verdict !== "PASS") {
    process.exitCode = 1;
    await wallet.dispose?.();
    return;
  }

  if (args.broadcastUnroll) {
    const selectedVtxo = selectBroadcastVtxo(recoverableCandidates, args.outpoint);
    const unrollOk = await broadcastUnrollProof({
      args,
      state,
      wallet,
      selectedVtxo,
      expectedScriptHex,
    });
    if (!unrollOk) process.exitCode = 1;
  }
  await wallet.dispose?.();
}

main().catch((error) => {
  log("ERROR", "CHECK_FAILED", { err: String(error?.message || error).slice(0, 240) });
  process.exitCode = 1;
});
