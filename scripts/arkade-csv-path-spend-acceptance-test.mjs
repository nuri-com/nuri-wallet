#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ArkAddress,
  CSVMultisigTapscript,
  ContractManager,
  DefaultContractHandler,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  P2A,
  Ramps,
  SingleKey,
  Transaction,
  VtxoScript,
  VtxoTaprootTree,
  Wallet,
  contractHandlers,
  setArkPsbtField,
  verifyTapscriptSignatures,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { base64, hex } from "@scure/base";
import { EventSource } from "eventsource";

const SRC = "scripts/arkade-csv-path-spend-acceptance-test.mjs";
const CONTRACT_TYPE = "nuri_client_recovery_v1";
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-csv-path-spend-acceptance-mainnet.json",
);
const ZERO_XONLY = new Uint8Array(32);
const ZERO_XONLY_HEX = "00".repeat(32);

let lastLogAt = Date.now();

function shortTime(date = new Date()) {
  return date.toISOString().slice(11, 23);
}

function formatLogValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Uint8Array) return truncateMiddle(hex.encode(value), 24);
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.replace(/\s+/g, "_");
}

function logLine(emoji, level, event, group, scope, action, fields = {}) {
  const now = Date.now();
  const parts = [
    `${emoji} ${level}`,
    event,
    `grp=${group}`,
    `scope=${scope}`,
    `act=${action}`,
    `t=${shortTime()}`,
    `dt=+${now - lastLogAt}ms`,
    `src=${SRC}#${scope}`,
  ];
  lastLogAt = now;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${formatLogValue(value)}`);
  }
  console.log(parts.join(" "));
}

function info(scope, action, fields = {}) {
  logLine("🧪", "INFO", "FLOW", "Bitcoin", scope, action, fields);
}

function warn(scope, action, fields = {}) {
  logLine("⚠️", "WARN", "VALIDATION", "Bitcoin", scope, action, fields);
}

function errorLog(scope, action, fields = {}) {
  logLine("❌", "ERROR", "BUG", "Bitcoin", scope, action, fields);
}

function truncateMiddle(value, max = 40) {
  const raw = String(value || "");
  if (raw.length <= max) return raw;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function sha256Bytes(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
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

function getBlockCsvValue(timelock) {
  if (!timelock || timelock.type !== "blocks") return 0;
  const blocks = Number(timelock.value);
  return Number.isInteger(blocks) ? blocks : 0;
}

function arkadeTimelockToSequence(timelock) {
  const serialized = DefaultContractHandler.serializeParams({
    pubKey: ZERO_XONLY,
    serverPubKey: ZERO_XONLY,
    csvTimelock: timelock,
  });
  return Number(serialized.csvTimelock || 0);
}

function sequenceToArkadeTimelock(sequence) {
  return DefaultContractHandler.deserializeParams({
    pubKey: ZERO_XONLY_HEX,
    serverPubKey: ZERO_XONLY_HEX,
    csvTimelock: String(sequence),
  }).csvTimelock;
}

function assertXOnly(pubkey, field) {
  assert(pubkey instanceof Uint8Array && pubkey.length === 32, `${field} must be 32 bytes`);
}

function assertCsvBlocks(timelock, field) {
  const blocks = getBlockCsvValue(timelock);
  assert(blocks > 0, `${field} must be a positive block timelock`);
  return blocks;
}

function taprootTweak(xonlyHex, tapMerkleRoot) {
  const internal = hex.decode(xonlyHex);
  return schnorr.utils.taggedHash(
    "TapTweak",
    ...(tapMerkleRoot instanceof Uint8Array && tapMerkleRoot.length === 32
      ? [internal, tapMerkleRoot]
      : [internal]),
  );
}

function inputTapMerkleRoot(input) {
  const root = input?.tapMerkleRoot;
  if (root instanceof Uint8Array && root.length === 32) return root;
  if (ArrayBuffer.isView(root)) {
    const bytes = new Uint8Array(root.buffer, root.byteOffset, root.byteLength);
    return bytes.length === 32 ? new Uint8Array(bytes) : null;
  }
  return null;
}

function appendTaprootSighash(sig64, sighashType) {
  if (sighashType === btc.SigHash.DEFAULT) return sig64;
  const out = new Uint8Array(sig64.length + 1);
  out.set(sig64, 0);
  out[sig64.length] = Number(sighashType) & 0xff;
  return out;
}

function scriptContainsXOnly(scriptOps, xOnlyPubkey) {
  const xOnlyHex = hex.encode(xOnlyPubkey);
  for (const op of scriptOps) {
    if (!(op instanceof Uint8Array)) continue;
    if (op.length === 32 && hex.encode(op) === xOnlyHex) return true;
    if (op.length === 33 && hex.encode(op.slice(1)) === xOnlyHex) return true;
  }
  return false;
}

function tapLeafScriptBody(leaf) {
  assert(Array.isArray(leaf) && leaf.length >= 2, "invalid tap leaf script");
  const scriptWithVersion = leaf[1];
  assert(
    scriptWithVersion instanceof Uint8Array && scriptWithVersion.length > 1,
    "invalid leaf body",
  );
  return scriptWithVersion.subarray(0, scriptWithVersion.length - 1);
}

function vtxoTxid(vtxo) {
  return String(vtxo?.txid || vtxo?.outpoint?.txid || "");
}

function vtxoVout(vtxo) {
  return Math.max(0, Math.trunc(Number(vtxo?.vout ?? vtxo?.outpoint?.vout ?? 0)));
}

class NuriClientRecoveryScript extends VtxoScript {
  constructor(params) {
    assertXOnly(params.cooperativePubKey, "cooperativePubKey");
    assertXOnly(params.clientPubKey, "clientPubKey");
    assertXOnly(params.serverPubKey, "serverPubKey");
    assertCsvBlocks(params.csvTimelock, "csvTimelock");

    const forfeit = MultisigTapscript.encode({
      pubkeys: [params.cooperativePubKey, params.serverPubKey],
    });
    const exit = CSVMultisigTapscript.encode({
      timelock: params.csvTimelock,
      pubkeys: [params.clientPubKey],
    });
    super([forfeit.script, exit.script]);
    this.options = {
      ...params,
      pubKey: params.cooperativePubKey,
    };
    this.forfeitScript = hex.encode(forfeit.script);
    this.exitScript = hex.encode(exit.script);
  }

  forfeit() {
    return this.findLeaf(this.forfeitScript);
  }

  exit() {
    return this.findLeaf(this.exitScript);
  }
}

const NuriClientRecoveryContractHandler = {
  type: CONTRACT_TYPE,

  createScript(params) {
    return new NuriClientRecoveryScript(this.deserializeParams(params));
  },

  serializeParams(params) {
    assertCsvBlocks(params.csvTimelock, "csvTimelock");
    return {
      cooperativePubKey: hex.encode(params.cooperativePubKey),
      clientPubKey: hex.encode(params.clientPubKey),
      serverPubKey: hex.encode(params.serverPubKey),
      csvTimelock: String(arkadeTimelockToSequence(params.csvTimelock)),
    };
  },

  deserializeParams(params) {
    const sequence = Number(params.csvTimelock || 0);
    assert(Number.isInteger(sequence) && sequence > 0, "csvTimelock must be a positive sequence");
    const csvTimelock = sequenceToArkadeTimelock(sequence);
    assertCsvBlocks(csvTimelock, "csvTimelock");
    return {
      cooperativePubKey: hex.decode(String(params.cooperativePubKey || "")),
      clientPubKey: hex.decode(String(params.clientPubKey || "")),
      serverPubKey: hex.decode(String(params.serverPubKey || "")),
      csvTimelock,
    };
  },

  selectPath(script, contract, context) {
    if (context.collaborative) return { leaf: script.forfeit() };
    const sequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : undefined;
    return { leaf: script.exit(), sequence };
  },

  getAllSpendingPaths(script, contract, context) {
    const paths = [];
    if (context.collaborative) paths.push({ leaf: script.forfeit() });
    const sequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : undefined;
    paths.push({ leaf: script.exit(), sequence });
    return paths;
  },

  getSpendablePaths(script, contract, context) {
    return this.getAllSpendingPaths(script, contract, context);
  },
};

function registerNuriClientRecoveryContract() {
  if (!contractHandlers.has(CONTRACT_TYPE)) {
    contractHandlers.register(NuriClientRecoveryContractHandler);
  }
}

class LocalAggregateIdentity {
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

  async signMessage(message, signatureType = "schnorr") {
    if (signatureType !== "schnorr") {
      throw new Error("LocalAggregateIdentity supports schnorr signatures only");
    }
    const msg32 = message.length === 32 ? message : sha256Bytes(message);
    return this.signMsg32(msg32);
  }

  signMsg32(msg32, tweak32) {
    const clientNonce = musig2.nonceGen(
      this.clientPk33,
      this.clientKey,
      this.aggregatedXonly,
      msg32,
    );
    const serverNonce = musig2.nonceGen(
      this.nuriServerPk33,
      this.nuriServerKey,
      this.aggregatedXonly,
      msg32,
    );
    const aggNonce = musig2.nonceAggregate([clientNonce.public, serverNonce.public]);
    const session = tweak32
      ? new musig2.Session(aggNonce, this.sortedKeys, msg32, [tweak32], [true])
      : new musig2.Session(aggNonce, this.sortedKeys, msg32);
    const partials = this.sortedKeys.map((pubkey) => {
      if (sameBytes(pubkey, this.clientPk33)) {
        return session.sign(clientNonce.secret, this.clientKey);
      }
      if (sameBytes(pubkey, this.nuriServerPk33)) {
        return session.sign(serverNonce.secret, this.nuriServerKey);
      }
      throw new Error("aggregate signer key mismatch");
    });
    const finalSig = session.partialSigAgg(partials);
    if (!tweak32 && !schnorr.verify(finalSig, msg32, this.aggregatedXonly)) {
      throw new Error("local aggregate signature verification failed");
    }
    return finalSig;
  }

  async sign(tx, inputIndexes) {
    const txCopy = tx.clone();
    const targets = Array.isArray(inputIndexes)
      ? [...inputIndexes]
      : [...Array(txCopy.inputsLength).keys()];
    const prevScripts = [];
    const prevAmounts = [];
    for (let i = 0; i < txCopy.inputsLength; i += 1) {
      const input = txCopy.getInput(i);
      prevScripts.push(input?.witnessUtxo?.script || new Uint8Array());
      prevAmounts.push(input?.witnessUtxo?.amount || 0n);
    }

    let signed = 0;
    for (const inputIndex of targets) {
      const input = txCopy.getInput(inputIndex);
      if (!input?.witnessUtxo) {
        if (inputIndexes) throw new Error(`input ${inputIndex} missing witnessUtxo`);
        continue;
      }
      const witnessScript = input.witnessUtxo.script;
      const isTaproot =
        witnessScript?.length === 34 && witnessScript[0] === 0x51 && witnessScript[1] === 0x20;
      if (!isTaproot) {
        if (inputIndexes) throw new Error(`input ${inputIndex} is not taproot`);
        continue;
      }
      const sighashType = input.sighashType || btc.SigHash.DEFAULT;
      let signedThisInput = false;
      if (Array.isArray(input.tapLeafScript) && input.tapLeafScript.length > 0) {
        for (const leaf of input.tapLeafScript) {
          const leafScript = tapLeafScriptBody(leaf);
          const leafVersion = leaf[1][leaf[1].length - 1];
          let decoded = [];
          try {
            decoded = btc.Script.decode(leafScript);
          } catch {
            continue;
          }
          if (!scriptContainsXOnly(decoded, this.aggregatedXonly)) continue;
          const msg32 = txCopy.preimageWitnessV1(
            inputIndex,
            prevScripts,
            sighashType,
            prevAmounts,
            undefined,
            leafScript,
            leafVersion,
          );
          const leafSig = appendTaprootSighash(this.signMsg32(msg32), sighashType);
          txCopy.updateInput(
            inputIndex,
            {
              tapScriptSig: [
                [
                  {
                    pubKey: this.aggregatedXonly,
                    leafHash: tapLeafHash(leafScript, leafVersion),
                  },
                  leafSig,
                ],
              ],
            },
            true,
          );
          signedThisInput = true;
        }
      }

      if (!signedThisInput) {
        const msg32 = txCopy.preimageWitnessV1(inputIndex, prevScripts, sighashType, prevAmounts);
        const tweak32 = taprootTweak(hex.encode(this.aggregatedXonly), inputTapMerkleRoot(input));
        const sig = appendTaprootSighash(this.signMsg32(msg32, tweak32), sighashType);
        txCopy.updateInput(inputIndex, {
          tapKeySig: sig,
          tapInternalKey: this.aggregatedXonly,
        });
      }
      signed += 1;
    }
    if (inputIndexes && signed !== inputIndexes.length) {
      throw new Error(`requested ${inputIndexes.length} signatures, produced ${signed}`);
    }
    if (!inputIndexes && signed === 0) throw new Error("No inputs signed");
    info("aggregate_identity", "signed", {
      inputs: signed,
      client_pk: truncateMiddle(hex.encode(this.clientPk33), 18),
      nuri_server_pk: truncateMiddle(hex.encode(this.nuriServerPk33), 18),
      aggregate_pk: truncateMiddle(hex.encode(this.aggregatedPk33), 18),
    });
    return txCopy;
  }
}

function decodeScriptLeaves(decoded) {
  const csvLeaves = [];
  const multisigLeaves = [];
  for (const script of decoded.scripts) {
    try {
      csvLeaves.push(CSVMultisigTapscript.decode(script));
      continue;
    } catch {}
    try {
      multisigLeaves.push(MultisigTapscript.decode(script));
    } catch {}
  }
  return { csvLeaves, multisigLeaves };
}

function verifyClientRecoveryTapTree({
  tapTree,
  cooperativePubKey,
  clientPubKey,
  serverPubKey,
  csvBlocks,
  network,
}) {
  const decoded = VtxoScript.decode(tapTree);
  const { csvLeaves, multisigLeaves } = decodeScriptLeaves(decoded);
  const forfeitLeaves = multisigLeaves.filter((leaf) => {
    const pubkeys = leaf?.params?.pubkeys || [];
    return (
      pubkeys.length === 2 &&
      sameBytes(pubkeys[0], cooperativePubKey) &&
      sameBytes(pubkeys[1], serverPubKey)
    );
  });
  const clientCsvLeaves = csvLeaves.filter((leaf) => {
    const pubkeys = leaf?.params?.pubkeys || [];
    return (
      pubkeys.length === 1 &&
      sameBytes(pubkeys[0], clientPubKey) &&
      leaf?.params?.timelock?.type === "blocks" &&
      Number(leaf.params.timelock.value) === csvBlocks
    );
  });
  const aggregateCsvLeaves = csvLeaves.filter((leaf) => {
    const pubkeys = leaf?.params?.pubkeys || [];
    return includesKey(pubkeys, cooperativePubKey) || includesKey(pubkeys, serverPubKey);
  });
  const oldDefaultLeaves = csvLeaves.filter((leaf) => {
    const pubkeys = leaf?.params?.pubkeys || [];
    return pubkeys.length !== 1 || !sameBytes(pubkeys[0], clientPubKey);
  });

  assert(decoded.scripts.length === 2, `expected 2 leaves, got ${decoded.scripts.length}`);
  assert(
    forfeitLeaves.length === 1,
    `expected 1 cooperative forfeit leaf, got ${forfeitLeaves.length}`,
  );
  assert(clientCsvLeaves.length === 1, `expected 1 client CSV leaf, got ${clientCsvLeaves.length}`);
  assert(csvLeaves.length === 1, `expected exactly 1 CSV leaf, got ${csvLeaves.length}`);
  assert(aggregateCsvLeaves.length === 0, "aggregate/server key found in CSV exit path");
  assert(oldDefaultLeaves.length === 0, "old/default CSV format found");

  return {
    verdict: "pass",
    leafCount: decoded.scripts.length,
    csvLeaves: csvLeaves.length,
    forfeitLeaves: forfeitLeaves.length,
    scriptPubKey: hex.encode(decoded.pkScript),
    l1ExitAddress: decoded.onchainAddress(network),
  };
}

function buildVirtualTxWithSequence(inputs, outputs) {
  const tx = new Transaction({
    version: 3,
    lockTime: 0,
  });
  for (const [inputIndex, input] of inputs.entries()) {
    tx.addInput({
      txid: input.txid,
      index: input.vout,
      sequence: input.sequence,
      witnessUtxo: {
        script: VtxoScript.decode(input.tapTree).pkScript,
        amount: BigInt(input.value),
      },
      tapLeafScript: [input.tapLeafScript],
    });
    setArkPsbtField(tx, inputIndex, VtxoTaprootTree, input.tapTree);
  }
  for (const output of outputs) {
    tx.addOutput(output);
  }
  tx.addOutput(P2A);
  return tx;
}

function buildCheckpointTxWithSequence(vtxo, serverUnrollScript) {
  const csvLeafScript = tapLeafScriptBody(vtxo.tapLeafScript);
  const checkpointVtxoScript = new VtxoScript([serverUnrollScript.script, csvLeafScript]);
  const checkpointTx = buildVirtualTxWithSequence(
    [vtxo],
    [
      {
        amount: BigInt(vtxo.value),
        script: checkpointVtxoScript.pkScript,
      },
    ],
  );
  const checkpointSpendLeaf = checkpointVtxoScript.findLeaf(hex.encode(csvLeafScript));
  assert(checkpointSpendLeaf, "checkpoint CSV spend leaf missing");
  return {
    tx: checkpointTx,
    input: {
      txid: checkpointTx.id,
      vout: 0,
      value: vtxo.value,
      tapLeafScript: checkpointSpendLeaf,
      tapTree: checkpointVtxoScript.encode(),
      sequence: vtxo.sequence,
    },
  };
}

function buildCsvPathOffchainTx(inputs, outputs, serverUnrollScript) {
  const checkpoints = inputs.map((input) =>
    buildCheckpointTxWithSequence(input, serverUnrollScript),
  );
  const arkTx = buildVirtualTxWithSequence(
    checkpoints.map((checkpoint) => checkpoint.input),
    outputs,
  );
  return {
    arkTx,
    checkpoints: checkpoints.map((checkpoint) => checkpoint.tx),
  };
}

function parseArgs(argv) {
  const args = {
    nodeUrl: DEFAULT_NODE_URL,
    esploraUrl: DEFAULT_ESPLORA_URL,
    statePath: DEFAULT_STATE_PATH,
    timeoutMs: 600000,
    csvBlocks: 3,
    spendSats: 500,
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
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(next || 0);
      i += 1;
    } else if (arg === "--csv") {
      args.csvBlocks = Number(next || 0);
      i += 1;
    } else if (arg === "--spend-sats") {
      args.spendSats = Number(next || 0);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  if (!Number.isInteger(args.csvBlocks) || args.csvBlocks <= 0) {
    throw new Error("--csv must be positive");
  }
  if (!Number.isInteger(args.spendSats) || args.spendSats <= 0) {
    throw new Error("--spend-sats must be positive");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-csv-path-spend-acceptance-test.mjs

Options:
  --node URL             Default: ${DEFAULT_NODE_URL}
  --esplora URL          Default: ${DEFAULT_ESPLORA_URL}
  --state PATH           Default: ${DEFAULT_STATE_PATH}
  --timeout-ms N         Default: 600000
  --csv N                Nuri recovery CSV blocks. Default: 3
  --spend-sats N         Receiver amount. Default: 500

Flow:
  1. Creates a sender wallet using Nuri aggregate identity.
  2. Installs nuri_client_recovery_v1.
  3. Creates a receiver wallet.
  4. Prints a boarding address if sender needs funds.
  5. Onboards existing boarding funds into a custom VTXO.
  6. Builds an Arkade offchain transaction using the client-only CSV leaf.
  7. Signs that spend with the Nuri client key only.
  8. Submits/finalizes it and verifies receiver VTXO arrival.
`);
}

async function loadOrCreateState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    assert(typeof parsed.clientKeyHex === "string", "state missing client key");
    assert(typeof parsed.nuriServerKeyHex === "string", "state missing nuri server key");
    assert(typeof parsed.receiverKeyHex === "string", "state missing receiver key");
    info("state", "loaded", { path: statePath });
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const client = SingleKey.fromRandomBytes();
  const nuriServer = SingleKey.fromRandomBytes();
  const receiver = SingleKey.fromRandomBytes();
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    account: "nuri-arkade-csv-path-spend-acceptance",
    clientKeyHex: client.toHex(),
    nuriServerKeyHex: nuriServer.toHex(),
    receiverKeyHex: receiver.toHex(),
    expectedSenderArkAddress: "",
    expectedSenderBoardingAddress: "",
    expectedReceiverArkAddress: "",
    expectedSenderArkAddressesByCsv: {},
  };
  await saveState(statePath, state);
  info("state", "created", {
    path: statePath,
    secret: "local_file_not_logged",
  });
  return state;
}

async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function guardFixedAddress(statePath, state, field, value, label) {
  const current = String(value || "");
  const expected = String(state[field] || "");
  if (!expected) {
    state[field] = current;
    await saveState(statePath, state);
    info("fixed_account", "address_pinned", { label, address: current, state: statePath });
    return;
  }
  if (expected !== current) {
    throw new Error(`${label}_address_drift expected=${expected} got=${current}`);
  }
  info("fixed_account", "address_verified", { label, address: current });
}

async function guardCsvAddress(statePath, state, field, csvBlocks, value, label) {
  const current = String(value || "");
  const csvKey = String(csvBlocks);
  const pins = state[field] && typeof state[field] === "object" ? state[field] : {};
  const expected = String(pins[csvKey] || "");
  if (!expected) {
    pins[csvKey] = current;
    state[field] = pins;
    await saveState(statePath, state);
    info("fixed_account", "csv_address_pinned", {
      label,
      csv_blocks: csvBlocks,
      address: current,
      state: statePath,
    });
    return;
  }
  if (expected !== current) {
    throw new Error(`${label}_csv_${csvBlocks}_address_drift expected=${expected} got=${current}`);
  }
  info("fixed_account", "csv_address_verified", {
    label,
    csv_blocks: csvBlocks,
    address: current,
  });
}

async function withTimeout(timeoutMs, promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createBaseWallet(args, identity) {
  return Wallet.create({
    identity,
    arkServerUrl: args.nodeUrl,
    esploraUrl: args.esploraUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });
}

async function installClientRecoveryWallet(wallet, clientIdentity, csvBlocks) {
  registerNuriClientRecoveryContract();
  const cooperativePubKey = await wallet.identity.xOnlyPublicKey();
  const clientPubKey = await clientIdentity.xOnlyPublicKey();
  const serverPubKey = wallet.arkServerPublicKey;
  assertXOnly(serverPubKey, "wallet.arkServerPublicKey");
  const csvTimelock = { type: "blocks", value: BigInt(csvBlocks) };
  const script = new NuriClientRecoveryScript({
    cooperativePubKey,
    clientPubKey,
    serverPubKey,
    csvTimelock,
  });
  const params = NuriClientRecoveryContractHandler.serializeParams(script.options);
  const scriptHex = hex.encode(script.pkScript);

  wallet.offchainTapscript = script;
  wallet.initializeContractManager = async function initializeNuriClientRecoveryContractManager() {
    const manager = await ContractManager.create({
      indexerProvider: this.indexerProvider,
      contractRepository: this.contractRepository,
      walletRepository: this.walletRepository,
      getDefaultAddress: () => this.getAddress(),
      watcherConfig: this.watcherConfig,
    });
    await manager.createContract({
      type: CONTRACT_TYPE,
      params,
      script: scriptHex,
      address: await this.getAddress(),
      state: "active",
      metadata: { recovery: "client_only_csv" },
    });
    return manager;
  };
  wallet.getWalletScripts = async function getNuriClientRecoveryWalletScripts() {
    return [scriptHex];
  };
  wallet.getScriptMap = async function getNuriClientRecoveryScriptMap() {
    return new Map([[scriptHex, script]]);
  };
  try {
    await wallet._vtxoManager?.dispose?.();
  } catch {}
  wallet._vtxoManager = undefined;
  wallet._vtxoManagerInitializing = undefined;
  wallet._contractManager = undefined;
  wallet._contractManagerInitializing = undefined;
  wallet.settlementConfig = false;
  await wallet.getContractManager();
  await wallet.getVtxoManager();
  info("contract", "installed", {
    type: CONTRACT_TYPE,
    csv_blocks: csvBlocks,
    cooperative_pk: truncateMiddle(hex.encode(cooperativePubKey), 18),
    client_pk: truncateMiddle(hex.encode(clientPubKey), 18),
    server_pk: truncateMiddle(hex.encode(serverPubKey), 18),
    script: truncateMiddle(scriptHex, 28),
  });
  return {
    cooperativePubKey,
    clientPubKey,
    serverPubKey,
    csvBlocks,
    script,
  };
}

async function createWallets(args, state) {
  if (!globalThis.EventSource) globalThis.EventSource = EventSource;
  const aggregateIdentity = new LocalAggregateIdentity(state.clientKeyHex, state.nuriServerKeyHex);
  const clientIdentity = SingleKey.fromHex(state.clientKeyHex);
  const receiverIdentity = SingleKey.fromHex(state.receiverKeyHex);
  const sender = await createBaseWallet(args, aggregateIdentity);
  const receiver = await createBaseWallet(args, receiverIdentity);
  const contract = await installClientRecoveryWallet(sender, clientIdentity, args.csvBlocks);
  return { sender, receiver, clientIdentity, aggregateIdentity, contract };
}

async function pollVtxos(wallet, timeoutMs, minCount = 1, label = "wallet") {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    info("indexer", "poll_vtxos", {
      label,
      attempt,
      vtxos: vtxos.length,
      min: minCount,
      elapsed: `${Date.now() - started}ms`,
    });
    if (vtxos.length >= minCount) return vtxos;
    await sleep(Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 30))));
  }
  throw new Error(`${label}_vtxo_poll_timeout_after_${timeoutMs}ms`);
}

async function onboardBoardingFunds(wallet, args) {
  const boardingUtxos = await wallet.getBoardingUtxos();
  info("funding", "boarding_utxos", {
    count: boardingUtxos.length,
    sats: boardingUtxos.reduce((sum, utxo) => sum + Number(utxo.value || 0), 0),
  });
  if (boardingUtxos.length === 0) return false;
  const infoResponse = await wallet.arkProvider.getInfo();
  const ramps = new Ramps(wallet);
  const arkTxid = await withTimeout(
    args.timeoutMs,
    ramps.onboard(infoResponse.fees, boardingUtxos, undefined, (event) => {
      info("funding", "batch_event", {
        type: event?.type || "unknown",
        id: truncateMiddle(event?.id || event?.txid || "", 24),
      });
    }),
    "boarding_onboard",
  );
  info("funding", "boarding_onboarded", { ark_txid: truncateMiddle(arkTxid, 32) });
  return true;
}

function verifyAndLogCustomVtxo(vtxo, contract, wallet, scope, action) {
  assert(vtxo?.tapTree, `${scope} vtxo missing tapTree`);
  const proof = verifyClientRecoveryTapTree({
    tapTree: vtxo.tapTree,
    cooperativePubKey: contract.cooperativePubKey,
    clientPubKey: contract.clientPubKey,
    serverPubKey: contract.serverPubKey,
    csvBlocks: contract.csvBlocks,
    network: wallet.network,
  });
  info(scope, action, {
    verdict: proof.verdict,
    txid: truncateMiddle(vtxoTxid(vtxo), 24),
    vout: vtxoVout(vtxo),
    value: Number(vtxo?.value || 0),
    l1_exit: truncateMiddle(proof.l1ExitAddress, 36),
    client_csv_leaf: "pass",
    forfeit_leaf: "pass",
    old_format: "absent",
  });
  return proof;
}

async function ensureSenderFunded(sender, contract, args) {
  let vtxos = await sender.getVtxos({ withRecoverable: true, withUnrolled: true });
  if (vtxos.length === 0) {
    const onboarded = await onboardBoardingFunds(sender, args);
    if (onboarded) vtxos = await pollVtxos(sender, args.timeoutMs, 1, "sender");
  }
  if (vtxos.length === 0) {
    const boardingAddress = await sender.getBoardingAddress();
    warn("funding", "funding_required", {
      boarding_address: boardingAddress,
      instruction: "fund_boarding_then_rerun_same_command",
    });
    console.log(`FUND_ONCHAIN_ADDRESS=${boardingAddress}`);
    return [];
  }
  const customVtxo = vtxos.find((vtxo) => vtxo?.tapTree) || vtxos[0];
  verifyAndLogCustomVtxo(customVtxo, contract, sender, "proof", "sender_custom_vtxo_verified");
  return vtxos;
}

function selectCsvSpendVtxo(vtxos, spendSats) {
  const candidates = vtxos
    .filter((vtxo) => vtxo?.tapTree && !vtxo?.isSpent && Number(vtxo?.value || 0) >= spendSats)
    .sort((a, b) => Number(a.value || 0) - Number(b.value || 0));
  return candidates[0] || null;
}

function buildCsvSpendInput(vtxo, contract) {
  const decoded = VtxoScript.decode(vtxo.tapTree);
  const exitLeaf = decoded.findLeaf(contract.script.exitScript);
  assert(exitLeaf, "client CSV leaf missing from selected VTXO tapTree");
  const exitScript = tapLeafScriptBody(exitLeaf);
  const decodedExit = CSVMultisigTapscript.decode(exitScript);
  const pubkeys = decodedExit?.params?.pubkeys || [];
  assert(pubkeys.length === 1, "CSV path must have one pubkey");
  assert(sameBytes(pubkeys[0], contract.clientPubKey), "CSV path pubkey must be client key");
  assert(
    getBlockCsvValue(decodedExit.params.timelock) === contract.csvBlocks,
    "CSV blocks mismatch",
  );
  return {
    txid: vtxoTxid(vtxo),
    vout: vtxoVout(vtxo),
    value: Number(vtxo.value || 0),
    tapLeafScript: exitLeaf,
    tapTree: vtxo.tapTree,
    sequence: arkadeTimelockToSequence(decodedExit.params.timelock),
  };
}

async function submitClientOnlyCsvPathSpend(
  sender,
  receiver,
  clientIdentity,
  contract,
  vtxo,
  args,
) {
  const receiverAddress = await receiver.getAddress();
  const senderAddress = await sender.getAddress();
  const receiverScript = ArkAddress.decode(receiverAddress).pkScript;
  const senderArkAddress = ArkAddress.decode(senderAddress);
  const spendInput = buildCsvSpendInput(vtxo, contract);
  const sendAmount = BigInt(args.spendSats);
  const inputAmount = BigInt(spendInput.value);
  assert(inputAmount >= sendAmount, "selected VTXO amount below spend amount");
  const changeAmount = inputAmount - sendAmount;
  const outputs = [
    {
      script: receiverScript,
      amount: sendAmount,
    },
  ];
  if (changeAmount > 0n) {
    outputs.push({
      script:
        changeAmount < BigInt(sender.dustAmount)
          ? senderArkAddress.subdustPkScript
          : senderArkAddress.pkScript,
      amount: changeAmount,
    });
  }

  info("csv_spend", "build", {
    source_txid: truncateMiddle(spendInput.txid, 24),
    source_vout: spendInput.vout,
    source_value: spendInput.value,
    receiver: truncateMiddle(receiverAddress, 36),
    send_sats: args.spendSats,
    change_sats: changeAmount,
    sequence: spendInput.sequence,
    signer: "client_only",
    nuri_server: "not_used",
  });

  const offchainTx = buildCsvPathOffchainTx([spendInput], outputs, sender.serverUnrollScript);
  const clientPubkeyHex = hex.encode(contract.clientPubKey);
  const signedVirtualTx = await clientIdentity.sign(offchainTx.arkTx);
  verifyTapscriptSignatures(signedVirtualTx, 0, [clientPubkeyHex]);
  info("csv_spend", "virtual_signed", {
    txid: truncateMiddle(signedVirtualTx.id, 24),
    signer: "client_only",
    client_pk: truncateMiddle(clientPubkeyHex, 18),
  });

  const submit = await sender.arkProvider.submitTx(
    base64.encode(signedVirtualTx.toPSBT()),
    offchainTx.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  );
  info("csv_spend", "submitted", {
    ark_txid: truncateMiddle(submit.arkTxid, 32),
    checkpoints: Array.isArray(submit.signedCheckpointTxs) ? submit.signedCheckpointTxs.length : 0,
  });

  const finalCheckpoints = [];
  for (const [index, checkpointPsbt] of submit.signedCheckpointTxs.entries()) {
    const checkpoint = Transaction.fromPSBT(base64.decode(checkpointPsbt));
    const signedCheckpoint = await clientIdentity.sign(checkpoint);
    verifyTapscriptSignatures(signedCheckpoint, 0, [clientPubkeyHex]);
    finalCheckpoints.push(base64.encode(signedCheckpoint.toPSBT()));
    info("csv_spend", "checkpoint_signed", {
      index,
      txid: truncateMiddle(signedCheckpoint.id, 24),
      signer: "client_only",
    });
  }

  await sender.arkProvider.finalizeTx(submit.arkTxid, finalCheckpoints);
  info("csv_spend", "finalized", {
    ark_txid: truncateMiddle(submit.arkTxid, 32),
    verdict: "arkade_accepted_client_csv_path",
  });
  return submit.arkTxid;
}

async function runCsvPathAcceptance(sender, receiver, clientIdentity, contract, args) {
  const senderVtxos = await sender.getVtxos({ withRecoverable: true, withUnrolled: true });
  const selected = selectCsvSpendVtxo(senderVtxos, args.spendSats);
  if (!selected) {
    warn("csv_spend", "insufficient_vtxo", {
      vtxos: senderVtxos.length,
      spend_sats: args.spendSats,
    });
    return { verdict: "waiting_funds" };
  }
  verifyAndLogCustomVtxo(selected, contract, sender, "csv_spend", "selected_vtxo_verified");
  const beforeReceiver = await receiver.getVtxos({ withRecoverable: true, withUnrolled: true });
  const arkTxid = await withTimeout(
    args.timeoutMs,
    submitClientOnlyCsvPathSpend(sender, receiver, clientIdentity, contract, selected, args),
    "csv_path_spend",
  );
  const receiverVtxos = await pollVtxos(
    receiver,
    args.timeoutMs,
    beforeReceiver.length + 1,
    "receiver",
  );
  info("receiver", "received_csv_path_spend", {
    ark_txid: truncateMiddle(arkTxid, 32),
    before: beforeReceiver.length,
    after: receiverVtxos.length,
    verdict: "pass",
  });
  return { verdict: "pass", arkTxid };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  info("main", "start", {
    node: args.nodeUrl,
    esplora: args.esploraUrl,
    state: args.statePath,
    csv: args.csvBlocks,
    spend_sats: args.spendSats,
  });
  const state = await loadOrCreateState(args.statePath);
  const { sender, receiver, clientIdentity, aggregateIdentity, contract } = await createWallets(
    args,
    state,
  );
  try {
    const senderArk = await sender.getAddress();
    const senderBoarding = await sender.getBoardingAddress();
    const receiverArk = await receiver.getAddress();
    await guardCsvAddress(
      args.statePath,
      state,
      "expectedSenderArkAddressesByCsv",
      args.csvBlocks,
      senderArk,
      "sender_ark",
    );
    await guardFixedAddress(
      args.statePath,
      state,
      "expectedSenderBoardingAddress",
      senderBoarding,
      "sender_boarding",
    );
    await guardFixedAddress(
      args.statePath,
      state,
      "expectedReceiverArkAddress",
      receiverArk,
      "receiver_ark",
    );
    info("wallets", "ready", {
      csv_blocks: args.csvBlocks,
      sender_ark: truncateMiddle(senderArk, 36),
      sender_boarding: senderBoarding,
      receiver_ark: truncateMiddle(receiverArk, 36),
      aggregate_pk: truncateMiddle(hex.encode(aggregateIdentity.aggregatedPk33), 18),
      state: args.statePath,
    });

    const vtxos = await ensureSenderFunded(sender, contract, args);
    if (vtxos.length === 0) return;

    const result = await runCsvPathAcceptance(sender, receiver, clientIdentity, contract, args);
    if (result.verdict === "pass") {
      info("main", "final", {
        verdict: "pass",
        proof: "arkade_client_only_csv_path_spend_acceptance",
        ark_txid: truncateMiddle(result.arkTxid, 32),
        nuri_server: "not_used_for_csv_spend",
      });
      return;
    }
    warn("main", "final", {
      verdict: result.verdict,
      expected_next: "fund_more_then_rerun",
    });
  } finally {
    await sender.dispose?.();
    await receiver.dispose?.();
    info("wallets", "disposed", { status: "ok" });
  }
}

main().catch((err) => {
  errorLog("main", "failed", {
    err: truncateMiddle(err?.stack || err?.message || err, 220),
  });
  process.exitCode = 1;
});
