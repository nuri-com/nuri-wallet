#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CSVMultisigTapscript,
  ContractManager,
  DefaultContractHandler,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  OnchainWallet,
  Ramps,
  SingleKey,
  Transaction,
  Unroll,
  VtxoScript,
  Wallet,
  contractHandlers,
  verifyTapscriptSignatures,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { EventSource } from "eventsource";
import { ARKADE_CONTRACT_CONFIG, versionMatrixFields } from "./arkade-version-matrix.mjs";

const SRC = "scripts/arkade-l1-csv-proof-v2.mjs";
const CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-l1-csv-proof-v2-mainnet.json",
);
const ZERO_XONLY = new Uint8Array(32);
const ZERO_XONLY_HEX = "00".repeat(32);
const DEFAULT_LOCAL_PROOF_FEE_SATS = 330n;
const DUST_SATS = 546n;

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

function api(scope, action, fields = {}) {
  logLine("🌐", "INFO", "API", "Network", scope, action, fields);
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

function errorText(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/\s+/g, "_")
    .slice(0, 240);
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

async function fetchText(url) {
  const started = Date.now();
  const response = await fetch(url);
  const body = await response.text();
  api("esplora", "get", {
    status: response.status,
    dur: `${Date.now() - started}ms`,
    path: new URL(url).pathname,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${body}`);
  return body;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
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
    let scriptPath = 0;
    let keyPath = 0;
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
          if (!Array.isArray(leaf) || leaf.length < 2) continue;
          const scriptWithVersion = leaf[1];
          if (!(scriptWithVersion instanceof Uint8Array) || scriptWithVersion.length < 2) continue;
          const leafScript = scriptWithVersion.subarray(0, -1);
          const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];
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
          scriptPath += 1;
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
        keyPath += 1;
      }
      signed += 1;
    }
    if (inputIndexes && signed !== inputIndexes.length) {
      throw new Error(`requested ${inputIndexes.length} signatures, produced ${signed}`);
    }
    if (!inputIndexes && signed === 0) throw new Error("No inputs signed");
    info("aggregate_identity", "signed", {
      inputs: signed,
      script_path: scriptPath,
      key_path: keyPath,
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
  aggregatePubKey,
  clientPubKey,
  nuriServerPubKey,
  arkadeServerPubKey,
  csvBlocks,
  network,
}) {
  const decoded = VtxoScript.decode(tapTree);
  const { csvLeaves, multisigLeaves } = decodeScriptLeaves(decoded);
  const cooperativeLeaves = multisigLeaves.filter((leaf) => {
    const pubkeys = leaf?.params?.pubkeys || [];
    return (
      pubkeys.length === 2 &&
      sameBytes(pubkeys[0], aggregatePubKey) &&
      sameBytes(pubkeys[1], arkadeServerPubKey)
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
  const csvWithAggregate = csvLeaves.filter((leaf) =>
    includesKey(leaf?.params?.pubkeys || [], aggregatePubKey),
  );
  const csvWithArkadeServer = csvLeaves.filter((leaf) =>
    includesKey(leaf?.params?.pubkeys || [], arkadeServerPubKey),
  );
  const csvWithNuriServer = csvLeaves.filter((leaf) =>
    includesKey(leaf?.params?.pubkeys || [], nuriServerPubKey),
  );

  assert(decoded.scripts.length === 2, `expected 2 leaves, got ${decoded.scripts.length}`);
  assert(
    cooperativeLeaves.length === 1,
    `expected 1 aggregate+arkade cooperative leaf, got ${cooperativeLeaves.length}`,
  );
  assert(clientCsvLeaves.length === 1, `expected 1 client CSV leaf, got ${clientCsvLeaves.length}`);
  assert(csvLeaves.length === 1, `expected exactly 1 CSV leaf, got ${csvLeaves.length}`);
  assert(csvWithAggregate.length === 0, "aggregate key found in client CSV path");
  assert(csvWithArkadeServer.length === 0, "arkade server key found in client CSV path");
  assert(csvWithNuriServer.length === 0, "nuri server key found in client CSV path");

  return {
    verdict: "pass",
    leafCount: decoded.scripts.length,
    csvLeaves: csvLeaves.length,
    cooperativeLeaves: cooperativeLeaves.length,
    scriptPubKey: hex.encode(decoded.pkScript),
    l1ExitAddress: decoded.onchainAddress(network),
    clientCsvLeaf: decoded.findLeaf(hex.encode(clientCsvLeaves[0].script)),
    clientCsvScript: clientCsvLeaves[0].script,
  };
}

function summarizeBalance(balance) {
  return {
    boarding_confirmed: Number(balance?.boarding?.confirmed || 0),
    boarding_total: Number(balance?.boarding?.total || 0),
    available: Number(balance?.available || 0),
    settled: Number(balance?.settled || 0),
    preconfirmed: Number(balance?.preconfirmed || 0),
    recoverable: Number(balance?.recoverable || 0),
    total: Number(balance?.total || 0),
  };
}

function parseArgs(argv) {
  const args = {
    nodeUrl: DEFAULT_NODE_URL,
    esploraUrl: DEFAULT_ESPLORA_URL,
    statePath: DEFAULT_STATE_PATH,
    timeoutMs: 600000,
    csvBlocks: 3,
    waitCsv: false,
    noSpendProof: false,
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
    } else if (arg === "--wait-csv") {
      args.waitCsv = true;
    } else if (arg === "--no-spend-proof") {
      args.noSpendProof = true;
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
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-l1-csv-proof-v2.mjs
  node scripts/arkade-l1-csv-proof-v2.mjs --wait-csv

Options:
  --node URL             Default: ${DEFAULT_NODE_URL}
  --esplora URL          Default: ${DEFAULT_ESPLORA_URL}
  --state PATH           Default: ${DEFAULT_STATE_PATH}
  --timeout-ms N         Default: 600000
  --csv N                Nuri client recovery CSV blocks. Default: 3
  --wait-csv             Wait until L1 CSV maturity before final proof.
  --no-spend-proof       Skip local non-broadcast client spend proof.

Flow:
  1. Creates a fixed Nuri aggregate sender wallet.
  2. Installs nuri_client_recovery_v1.
  3. Prints boarding and anchor addresses when funding is needed.
  4. Onboards boarding funds into a custom Arkade VTXO.
  5. Unrolls the VTXO to L1 using anchor funds.
  6. Verifies L1 UTXO exists at the address derived from the tap tree.
  7. Builds and signs a local client-only CSV spend without broadcasting.
`);
}

async function loadOrCreateState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    assert(typeof parsed.clientKeyHex === "string", "state missing client key");
    assert(typeof parsed.nuriServerKeyHex === "string", "state missing nuri server key");
    info("state", "loaded", { path: statePath });
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const client = SingleKey.fromRandomBytes();
  const nuriServer = SingleKey.fromRandomBytes();
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    account: "nuri-arkade-l1-csv-proof-v2-mainnet",
    clientKeyHex: client.toHex(),
    nuriServerKeyHex: nuriServer.toHex(),
    expectedArkAddress: "",
    expectedBoardingAddress: "",
    expectedAnchorAddress: "",
    expectedArkAddressesByCsv: {},
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
  const aggregatePubKey = await wallet.identity.xOnlyPublicKey();
  const clientPubKey = await clientIdentity.xOnlyPublicKey();
  const arkadeServerPubKey = wallet.arkServerPublicKey;
  assertXOnly(arkadeServerPubKey, "wallet.arkServerPublicKey");
  const csvTimelock = { type: "blocks", value: BigInt(csvBlocks) };
  const script = new NuriClientRecoveryScript({
    cooperativePubKey: aggregatePubKey,
    clientPubKey,
    serverPubKey: arkadeServerPubKey,
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
      metadata: { recovery: "client_only_l1_csv_proof_v2" },
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
    immediate_leaf: "nuri_aggregate_plus_arkade_server",
    delayed_leaf: "nuri_client_only",
    aggregate_pk: truncateMiddle(hex.encode(aggregatePubKey), 18),
    client_pk: truncateMiddle(hex.encode(clientPubKey), 18),
    arkade_server_pk: truncateMiddle(hex.encode(arkadeServerPubKey), 18),
    script: truncateMiddle(scriptHex, 28),
  });
  return {
    aggregatePubKey,
    clientPubKey,
    arkadeServerPubKey,
    csvBlocks,
    script,
  };
}

async function createWallets(args, state) {
  if (!globalThis.EventSource) globalThis.EventSource = EventSource;
  const aggregateIdentity = new LocalAggregateIdentity(state.clientKeyHex, state.nuriServerKeyHex);
  const clientIdentity = SingleKey.fromHex(state.clientKeyHex);
  const nuriServerIdentity = SingleKey.fromHex(state.nuriServerKeyHex);
  const wallet = await createBaseWallet(args, aggregateIdentity);
  const anchorWallet = await OnchainWallet.create(
    clientIdentity,
    wallet.networkName,
    wallet.onchainProvider,
  );
  const contract = await installClientRecoveryWallet(wallet, clientIdentity, args.csvBlocks);
  return {
    wallet,
    anchorWallet,
    clientIdentity,
    nuriServerIdentity,
    aggregateIdentity,
    contract,
  };
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

async function pollVtxos(wallet, timeoutMs, predicate, label) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    const match = predicate(vtxos);
    info("indexer", "poll_vtxos", {
      label,
      attempt,
      vtxos: vtxos.length,
      found: match ? 1 : 0,
      elapsed: `${Date.now() - started}ms`,
    });
    if (match) return { vtxos, match };
    await sleep(Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 30))));
  }
  throw new Error(`${label}_vtxo_poll_timeout_after_${timeoutMs}ms`);
}

function verifyAndLogCustomVtxo(vtxo, contract, nuriServerPubKey, wallet, scope, action) {
  assert(vtxo?.tapTree, `${scope} vtxo missing tapTree`);
  const proof = verifyClientRecoveryTapTree({
    tapTree: vtxo.tapTree,
    aggregatePubKey: contract.aggregatePubKey,
    clientPubKey: contract.clientPubKey,
    nuriServerPubKey,
    arkadeServerPubKey: contract.arkadeServerPubKey,
    csvBlocks: contract.csvBlocks,
    network: wallet.network,
  });
  info(scope, action, {
    verdict: proof.verdict,
    txid: truncateMiddle(vtxoTxid(vtxo), 24),
    vout: vtxoVout(vtxo),
    value: Number(vtxo?.value || 0),
    l1_exit: truncateMiddle(proof.l1ExitAddress, 36),
    immediate_leaf: "nuri_aggregate_plus_arkade_server",
    delayed_leaf: "nuri_client_only",
    nuri_server_in_csv: "absent",
    arkade_server_in_csv: "absent",
  });
  return proof;
}

async function selectOrCreateVtxo(wallet, anchorWallet, contract, nuriServerPubKey, args) {
  let vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
  if (vtxos.length === 0) {
    const onboarded = await onboardBoardingFunds(wallet, args);
    if (onboarded) {
      const result = await pollVtxos(
        wallet,
        args.timeoutMs,
        (items) => items.find((vtxo) => vtxo?.tapTree && !vtxo?.isSpent),
        "sender_after_onboard",
      );
      vtxos = result.vtxos;
    }
  }
  const candidate =
    vtxos.find((vtxo) => vtxo?.tapTree && !vtxo?.isSpent && !vtxo?.isUnrolled) ||
    vtxos.find((vtxo) => vtxo?.tapTree && vtxo?.isUnrolled) ||
    vtxos.find((vtxo) => vtxo?.tapTree);
  if (!candidate) {
    const boardingAddress = await wallet.getBoardingAddress();
    warn("funding", "funding_required", {
      boarding_address: boardingAddress,
      anchor_address: anchorWallet.address,
      instruction: "fund_both_addresses_then_rerun_same_command",
    });
    console.log(`FUND_BOARDING_ADDRESS=${boardingAddress}`);
    console.log(`FUND_ANCHOR_ADDRESS=${anchorWallet.address}`);
    return null;
  }
  verifyAndLogCustomVtxo(candidate, contract, nuriServerPubKey, wallet, "proof", "vtxo_verified");
  return candidate;
}

async function txVisibility(onchainProvider, txid) {
  try {
    const status = await onchainProvider.getTxStatus(txid);
    return status?.confirmed ? `confirmed:${status.blockHeight || "unknown"}` : "mempool";
  } catch (error) {
    return `missing:${errorText(error)}`;
  }
}

async function broadcastUnrollPackage(anchorWallet, tx) {
  const [parentHex, childHex] = await anchorWallet.bumpP2A(tx);
  const parentTx = btc.Transaction.fromRaw(hex.decode(parentHex));
  const childTx = btc.Transaction.fromRaw(hex.decode(childHex));
  info("unroll", "package_built", {
    parent_txid: parentTx.id,
    child_txid: childTx.id,
    parent_matches_step: parentTx.id === tx.id ? 1 : 0,
  });
  const started = Date.now();
  const response = await anchorWallet.provider.broadcastTransaction(parentHex, childHex);
  api("unroll_broadcast", "post", {
    status: "ok",
    dur: `${Date.now() - started}ms`,
    parent_txid: parentTx.id,
    child_txid: childTx.id,
    response: JSON.stringify(response).slice(0, 2000),
  });
  if (response?.package_msg && response.package_msg !== "success") {
    throw new Error(`unroll_package_broadcast_failed:${JSON.stringify(response).slice(0, 2000)}`);
  }

  const visibilityStarted = Date.now();
  let parentStatus = "missing:not_checked";
  let childStatus = "missing:not_checked";
  while (Date.now() - visibilityStarted < 120000) {
    [parentStatus, childStatus] = await Promise.all([
      txVisibility(anchorWallet.provider, parentTx.id),
      txVisibility(anchorWallet.provider, childTx.id),
    ]);
    info("unroll", "package_visibility", {
      parent_txid: parentTx.id,
      parent: parentStatus,
      child_txid: childTx.id,
      child: childStatus,
      elapsed: `${Date.now() - visibilityStarted}ms`,
    });
    const parentVisible =
      parentStatus.startsWith("mempool") || parentStatus.startsWith("confirmed");
    const childVisible = childStatus.startsWith("mempool") || childStatus.startsWith("confirmed");
    if (parentVisible && childVisible) return;
    await sleep(5000);
  }
  throw new Error(
    `unroll_package_not_visible parent=${parentTx.id}:${parentStatus} child=${childTx.id}:${childStatus}`,
  );
}

async function unrollToL1(wallet, anchorWallet, candidate, args) {
  if (candidate?.isUnrolled) {
    info("unroll", "already_unrolled", {
      txid: truncateMiddle(vtxoTxid(candidate), 24),
      vout: vtxoVout(candidate),
    });
    return candidate;
  }
  const anchorBalance = await anchorWallet.getBalance().catch(() => 0);
  info("unroll", "anchor_balance", {
    address: anchorWallet.address,
    sats: Number(anchorBalance || 0),
  });
  if (Number(anchorBalance || 0) <= 0) {
    warn("funding", "anchor_funding_required", {
      anchor_address: anchorWallet.address,
      instruction: "fund_anchor_for_p2a_fee_then_rerun",
    });
    console.log(`FUND_ANCHOR_ADDRESS=${anchorWallet.address}`);
    return null;
  }
  const txid = vtxoTxid(candidate);
  const vout = vtxoVout(candidate);
  const session = await Unroll.Session.create(
    { txid, vout },
    anchorWallet,
    anchorWallet.provider,
    wallet.indexerProvider,
  );
  const started = Date.now();
  while (Date.now() - started < args.timeoutMs) {
    const step = await withTimeout(Math.min(args.timeoutMs, 120000), session.next(), "unroll_next");
    const stepName =
      step.type === Unroll.StepType.UNROLL
        ? "unroll"
        : step.type === Unroll.StepType.WAIT
          ? "wait"
          : "done";
    info("unroll", "step", {
      step: stepName,
      txid: truncateMiddle(step?.tx?.id || step?.txid || step?.vtxoTxid || txid, 24),
    });
    if (step.type === Unroll.StepType.UNROLL) {
      await withTimeout(
        Math.min(args.timeoutMs, 120000),
        broadcastUnrollPackage(anchorWallet, step.tx),
        "unroll_broadcast",
      );
      const result = await pollVtxos(
        wallet,
        args.timeoutMs,
        (items) => items.find((vtxo) => vtxoTxid(vtxo) === txid && vtxo?.isUnrolled),
        "unrolled_vtxo",
      );
      return result.match;
    }
    if (step.type === Unroll.StepType.WAIT) {
      await withTimeout(Math.min(args.timeoutMs, 120000), step.do(), "unroll_wait");
      continue;
    }
    const result = await pollVtxos(
      wallet,
      args.timeoutMs,
      (items) => items.find((vtxo) => vtxoTxid(vtxo) === txid && vtxo?.isUnrolled),
      "unrolled_vtxo",
    ).catch(() => ({ match: candidate }));
    return result.match;
  }
  throw new Error(`unroll_timeout_after_${args.timeoutMs}ms`);
}

async function fetchAddressUtxos(esploraUrl, address) {
  const apiRoot = esploraUrl.replace(/\/+$/, "");
  const utxos = await fetchJson(`${apiRoot}/address/${address}/utxo`);
  assert(Array.isArray(utxos), "invalid UTXO response");
  return utxos;
}

async function fetchTipHeight(esploraUrl) {
  const apiRoot = esploraUrl.replace(/\/+$/, "");
  const height = Number.parseInt(await fetchText(`${apiRoot}/blocks/tip/height`), 10);
  assert(Number.isFinite(height), "invalid tip height response");
  return height;
}

async function proveL1ScriptFunding(args, l1ExitAddress, expectedValue, expectedTxid = "") {
  const [height, utxos] = await Promise.all([
    fetchTipHeight(args.esploraUrl),
    fetchAddressUtxos(args.esploraUrl, l1ExitAddress),
  ]);
  const matches = utxos.filter((utxo) => {
    if (expectedTxid && String(utxo.txid || "") !== expectedTxid) return false;
    return Math.max(0, Math.trunc(Number(utxo.value || 0))) > 0;
  });
  const total = matches.reduce((sum, utxo) => sum + Math.max(0, Number(utxo.value || 0)), 0);
  assert(matches.length > 0, "no L1 UTXO found at verified exit address");
  if (Number(expectedValue || 0) > 0) {
    assert(
      total >= Number(expectedValue),
      `L1 UTXO total below expected value: expected=${expectedValue} got=${total}`,
    );
  }
  info("l1_proof", "script_funding_verified", {
    verdict: "pass",
    address: truncateMiddle(l1ExitAddress, 36),
    tip: height,
    utxos: matches.length,
    sats: total,
    expected_txid: truncateMiddle(expectedTxid, 24),
  });
  return { height, utxos: matches, total };
}

async function csvStatus(wallet, txid, csvBlocks) {
  const [status, tip] = await Promise.all([
    wallet.onchainProvider.getTxStatus(txid).catch(() => null),
    wallet.onchainProvider.getChainTip(),
  ]);
  const confirmedHeight = Number(status?.blockHeight || 0);
  const tipHeight = Number(tip?.height || 0);
  const remaining = status?.confirmed
    ? Math.max(0, confirmedHeight + csvBlocks - tipHeight)
    : Number.POSITIVE_INFINITY;
  return {
    confirmed: Boolean(status?.confirmed),
    confirmedHeight,
    tipHeight,
    remaining,
    mature: Boolean(status?.confirmed) && remaining === 0,
  };
}

async function waitForCsvReady(wallet, txid, csvBlocks, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await csvStatus(wallet, txid, csvBlocks);
    info("csv", "wait", {
      txid: truncateMiddle(txid, 24),
      confirmed: status.confirmed ? 1 : 0,
      confirmed_height: status.confirmedHeight || "n/a",
      tip: status.tipHeight || "n/a",
      csv_blocks: csvBlocks,
      remaining: Number.isFinite(status.remaining) ? status.remaining : "unconfirmed",
    });
    if (status.mature) return status;
    await sleep(10000);
  }
  throw new Error(`csv_wait_timeout_after_${timeoutMs}ms`);
}

async function buildClientOnlySpendProof(
  wallet,
  clientIdentity,
  contract,
  unrolled,
  outputAddress,
) {
  const txid = vtxoTxid(unrolled);
  const vout = vtxoVout(unrolled);
  const value = BigInt(unrolled.value || 0);
  assert(value > DUST_SATS + DEFAULT_LOCAL_PROOF_FEE_SATS, "unrolled value too small for proof tx");
  const decoded = VtxoScript.decode(unrolled.tapTree);
  const exitLeaf = decoded.findLeaf(contract.script.exitScript);
  const exitScript = tapLeafScriptBody(exitLeaf);
  const decodedExit = CSVMultisigTapscript.decode(exitScript);
  const pubkeys = decodedExit?.params?.pubkeys || [];
  assert(pubkeys.length === 1, "CSV path must have one pubkey");
  assert(sameBytes(pubkeys[0], contract.clientPubKey), "CSV path pubkey must be client key");
  assert(
    getBlockCsvValue(decodedExit.params.timelock) === contract.csvBlocks,
    "CSV blocks mismatch",
  );
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid,
    index: vout,
    tapLeafScript: [exitLeaf],
    sequence: arkadeTimelockToSequence(decodedExit.params.timelock),
    witnessUtxo: {
      amount: value,
      script: decoded.pkScript,
    },
    sighashType: btc.SigHash.DEFAULT,
  });
  tx.addOutputAddress(outputAddress, value - DEFAULT_LOCAL_PROOF_FEE_SATS);
  const signedTx = await clientIdentity.sign(tx);
  const clientPubkeyHex = hex.encode(contract.clientPubKey);
  verifyTapscriptSignatures(signedTx, 0, [clientPubkeyHex]);
  const input = signedTx.getInput(0);
  assert(input.tapScriptSig?.length === 1, "client proof must contain exactly one tap script sig");
  assert(
    sameBytes(input.tapScriptSig[0][0].pubKey, contract.clientPubKey),
    "client proof signer mismatch",
  );
  signedTx.finalize();
  info("spend_proof", "client_only_signed_not_broadcast", {
    verdict: "pass",
    source_txid: truncateMiddle(txid, 24),
    source_vout: vout,
    local_txid: truncateMiddle(signedTx.id, 24),
    destination: outputAddress,
    signer: "nuri_client_only",
    broadcast: 0,
  });
  return signedTx.id;
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
    csv_blocks: args.csvBlocks,
    wait_csv: args.waitCsv ? 1 : 0,
    ...versionMatrixFields(),
  });
  const state = await loadOrCreateState(args.statePath);
  const { wallet, anchorWallet, clientIdentity, nuriServerIdentity, aggregateIdentity, contract } =
    await createWallets(args, state);
  try {
    const arkAddress = await wallet.getAddress();
    const boardingAddress = await wallet.getBoardingAddress();
    const nuriServerPubKey = await nuriServerIdentity.xOnlyPublicKey();
    await guardCsvAddress(
      args.statePath,
      state,
      "expectedArkAddressesByCsv",
      args.csvBlocks,
      arkAddress,
      "ark",
    );
    await guardFixedAddress(
      args.statePath,
      state,
      "expectedBoardingAddress",
      boardingAddress,
      "boarding",
    );
    await guardFixedAddress(
      args.statePath,
      state,
      "expectedAnchorAddress",
      anchorWallet.address,
      "anchor",
    );
    const [walletBalance, anchorBalance] = await Promise.all([
      wallet.getBalance(),
      anchorWallet.getBalance().catch(() => 0),
    ]);
    info("wallets", "ready", {
      ark: truncateMiddle(arkAddress, 36),
      boarding: boardingAddress,
      anchor: anchorWallet.address,
      aggregate_pk: truncateMiddle(hex.encode(aggregateIdentity.aggregatedPk33), 18),
      nuri_client_pk: truncateMiddle(hex.encode(contract.clientPubKey), 18),
      nuri_server_pk: truncateMiddle(hex.encode(nuriServerPubKey), 18),
      arkade_server_pk: truncateMiddle(hex.encode(contract.arkadeServerPubKey), 18),
      state: args.statePath,
    });
    info("wallets", "balance", {
      wallet: JSON.stringify(summarizeBalance(walletBalance)),
      anchor_sats: Number(anchorBalance || 0),
    });

    const candidate = await selectOrCreateVtxo(
      wallet,
      anchorWallet,
      contract,
      nuriServerPubKey,
      args,
    );
    if (!candidate) return;

    const treeProof = verifyAndLogCustomVtxo(
      candidate,
      contract,
      nuriServerPubKey,
      wallet,
      "proof",
      "pre_unroll_tree_verified",
    );
    const unrolled = await unrollToL1(wallet, anchorWallet, candidate, args);
    if (!unrolled) return;

    const unrolledProof = verifyAndLogCustomVtxo(
      unrolled,
      contract,
      nuriServerPubKey,
      wallet,
      "proof",
      "post_unroll_tree_verified",
    );
    assert(
      unrolledProof.l1ExitAddress === treeProof.l1ExitAddress,
      "l1 exit address changed after unroll",
    );
    const exitTxid = vtxoTxid(unrolled) || vtxoTxid(candidate);
    const l1Proof = await proveL1ScriptFunding(
      args,
      unrolledProof.l1ExitAddress,
      Number(unrolled.value || candidate.value || 0),
      exitTxid,
    );
    const maturity = args.waitCsv
      ? await waitForCsvReady(wallet, exitTxid, contract.csvBlocks, args.timeoutMs)
      : await csvStatus(wallet, exitTxid, contract.csvBlocks);
    info("csv", "status", {
      txid: truncateMiddle(exitTxid, 24),
      confirmed: maturity.confirmed ? 1 : 0,
      confirmed_height: maturity.confirmedHeight || "n/a",
      tip: maturity.tipHeight || "n/a",
      csv_blocks: contract.csvBlocks,
      remaining: Number.isFinite(maturity.remaining) ? maturity.remaining : "unconfirmed",
      mature: maturity.mature ? 1 : 0,
    });
    let localSpendTxid = "";
    if (!args.noSpendProof) {
      localSpendTxid = await buildClientOnlySpendProof(
        wallet,
        clientIdentity,
        contract,
        unrolled,
        anchorWallet.address,
      );
    }
    info("main", "final", {
      verdict: "pass",
      proof: "l1_funds_locked_by_verified_nuri_recovery_tree",
      l1_exit: truncateMiddle(unrolledProof.l1ExitAddress, 36),
      l1_utxos: l1Proof.utxos.length,
      l1_sats: l1Proof.total,
      csv_mature: maturity.mature ? 1 : 0,
      client_spend_proof: localSpendTxid ? truncateMiddle(localSpendTxid, 24) : "skipped",
      broadcast: 0,
    });
  } finally {
    await wallet.dispose?.();
    info("wallets", "disposed", { status: "ok" });
  }
}

main().catch((err) => {
  errorLog("main", "failed", {
    err: truncateMiddle(err?.stack || err?.message || err, 700),
  });
  process.exitCode = 1;
});
