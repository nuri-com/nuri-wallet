#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { base64, hex } from "@scure/base";
import {
  CSVMultisigTapscript,
  ChainTxType,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  SingleKey,
  Transaction,
  VtxoScript,
  Wallet,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { NURI_SERVER_CSV_POLICY } from "./arkade-version-matrix.mjs";
import { EventSource } from "eventsource";
import { ARKADE_CONTRACT_CONFIG, versionMatrixFields } from "./arkade-version-matrix.mjs";

const SRC = "scripts/arkade-vtxo-safety-proof.mjs";
const SERVER_DECAY_CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-server-decay-proof-mainnet.json",
);
const DEFAULT_OUT_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-vtxo-safety-proof-mainnet.json",
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTimelock(timelock, label = "timelock") {
  assert(timelock && typeof timelock === "object", `${label} missing`);
  assert(
    timelock.type === "blocks" || timelock.type === "seconds",
    `${label} has invalid type ${timelock.type}`,
  );
  const value = typeof timelock.value === "bigint" ? timelock.value : BigInt(timelock.value);
  assert(value > 0n, `${label} must be positive`);
  return { type: timelock.type, value };
}

function formatTimelock(timelock) {
  const normalized = normalizeTimelock(timelock);
  return `${normalized.value.toString()}_${normalized.type}`;
}

function serializableTimelock(timelock) {
  const normalized = normalizeTimelock(timelock);
  return {
    type: normalized.type,
    value: normalized.value.toString(),
  };
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

function timelockGreaterThan(a, b) {
  const left = normalizeTimelock(a);
  const right = normalizeTimelock(b);
  return left.type === right.type && left.value > right.value;
}

function addSameUnitTimelocks(base, extra) {
  const left = normalizeTimelock(base, "baseTimelock");
  const right = normalizeTimelock(extra, "extraTimelock");
  assert(left.type === right.type, "timelock units must match");
  return { type: left.type, value: left.value + right.value };
}

function parseArgs(argv) {
  const args = {
    nodeUrl: DEFAULT_NODE_URL,
    esploraUrl: DEFAULT_ESPLORA_URL,
    statePath: DEFAULT_STATE_PATH,
    outPath: DEFAULT_OUT_PATH,
    outpoint: "",
    nuriDecaySeconds: NURI_SERVER_CSV_POLICY.value,
    nuriDecayBlocks: 1,
    renewalThresholdHours: 24 * 7,
    noWrite: false,
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
    } else if (arg === "--out") {
      args.outPath = String(next || "");
      i += 1;
    } else if (arg === "--outpoint") {
      args.outpoint = String(next || "");
      i += 1;
    } else if (arg === "--nuri-decay-seconds") {
      args.nuriDecaySeconds = Number(next || 0);
      i += 1;
    } else if (arg === "--nuri-decay-blocks") {
      args.nuriDecayBlocks = Number(next || 0);
      i += 1;
    } else if (arg === "--renewal-threshold-hours") {
      args.renewalThresholdHours = Number(next || 0);
      i += 1;
    } else if (arg === "--no-write") {
      args.noWrite = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.nuriDecaySeconds) || args.nuriDecaySeconds <= 0) {
    throw new Error("--nuri-decay-seconds must be positive");
  }
  if (!Number.isInteger(args.nuriDecayBlocks) || args.nuriDecayBlocks <= 0) {
    throw new Error("--nuri-decay-blocks must be positive");
  }
  if (!Number.isFinite(args.renewalThresholdHours) || args.renewalThresholdHours <= 0) {
    throw new Error("--renewal-threshold-hours must be positive");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-vtxo-safety-proof.mjs
  node scripts/arkade-vtxo-safety-proof.mjs --outpoint <txid:vout>
  node scripts/arkade-vtxo-safety-proof.mjs --no-write

Dry-run proof only. This never broadcasts to L1.

It proves for each current VTXO:
  - VTXO_SAFE: decoded taproot tree matches Nuri server-decay policy
  - EXIT_DATA_PACKAGE_READY: unroll chain and virtual PSBTs are captured
  - EXPIRY_OK or NEEDS_RENEWAL: expiry state is known

Options:
  --state PATH                         Default: ${DEFAULT_STATE_PATH}
  --out PATH                           Default: ${DEFAULT_OUT_PATH}
  --node URL                           Default: ${DEFAULT_NODE_URL}
  --esplora URL                        Default: ${DEFAULT_ESPLORA_URL}
  --outpoint <txid:vout>               Only package one VTXO
  --renewal-threshold-hours HOURS      Default: 168
  --nuri-decay-seconds SECONDS         Default: ${NURI_SERVER_CSV_POLICY.value}
  --nuri-decay-blocks BLOCKS           Default: 1
  --no-write                           Print only, do not save JSON`);
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

  async signMessage(message, signatureType = "schnorr") {
    if (signatureType !== "schnorr") {
      throw new Error("NuriAggregateIdentity supports schnorr signatures only");
    }
    const msg32 = message.length === 32 ? message : createHash("sha256").update(message).digest();
    return this.signMsg32(new Uint8Array(msg32));
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
      if (sameBytes(pubkey, this.clientPk33))
        return session.sign(clientNonce.secret, this.clientKey);
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
    return txCopy;
  }
}

class NuriServerDecayScript extends VtxoScript {
  constructor({
    cooperativePubKey,
    clientPubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv,
    clientDecayCsv,
  }) {
    const forfeit = MultisigTapscript.encode({
      pubkeys: [cooperativePubKey, arkadeServerPubKey],
    });
    const aggregateRecovery = CSVMultisigTapscript.encode({
      timelock: arkadeUserExitCsv,
      pubkeys: [cooperativePubKey],
    });
    const clientRecovery = CSVMultisigTapscript.encode({
      timelock: clientDecayCsv,
      pubkeys: [clientPubKey],
    });
    super([forfeit.script, aggregateRecovery.script, clientRecovery.script]);
    this.forfeitScript = hex.encode(forfeit.script);
    this.aggregateRecoveryScript = hex.encode(aggregateRecovery.script);
    this.clientRecoveryScript = hex.encode(clientRecovery.script);
    this.options = {
      cooperativePubKey,
      clientPubKey,
      arkadeServerPubKey,
      arkadeUserExitCsv,
      clientDecayCsv,
      pubKey: cooperativePubKey,
      serverPubKey: arkadeServerPubKey,
      csvTimelock: arkadeUserExitCsv,
    };
  }

  forfeit() {
    return this.findLeaf(this.forfeitScript);
  }

  aggregateRecovery() {
    return this.findLeaf(this.aggregateRecoveryScript);
  }

  exit() {
    return this.aggregateRecovery();
  }

  clientRecovery() {
    return this.findLeaf(this.clientRecoveryScript);
  }
}

async function saveJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function loadOrCreateState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert(typeof state.clientKeyHex === "string", "state missing clientKeyHex");
    assert(typeof state.nuriServerKeyHex === "string", "state missing nuriServerKeyHex");
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    clientKeyHex: SingleKey.fromRandomBytes().toHex(),
    nuriServerKeyHex: SingleKey.fromRandomBytes().toHex(),
    expectedArkAddress: "",
    expectedBoardingAddress: "",
  };
  await saveJson(statePath, state);
  log("INFO", "STATE_CREATED", { path: statePath, secret: "local_file_not_logged" });
  return state;
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

function findOutputWithScript(tx, scriptHex, wantedVout = undefined) {
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i);
    if (hex.encode(output?.script || new Uint8Array()) === scriptHex) {
      outputs.push({ index: i, amount: output.amount?.toString?.() || String(output.amount || 0) });
    }
  }
  if (Number.isInteger(wantedVout)) {
    return outputs.find((output) => output.index === wantedVout) || null;
  }
  return outputs[0] || null;
}

async function verifyChallengeSignature(identity, pubkey, label, vtxo, scriptHex) {
  const challenge = createHash("sha256")
    .update("nuri-vtxo-safety-proof-v1")
    .update(label)
    .update(vtxo.txid)
    .update(String(vtxo.vout))
    .update(scriptHex)
    .digest();
  const signature = await identity.signMessage(new Uint8Array(challenge), "schnorr");
  return schnorr.verify(signature, new Uint8Array(challenge), pubkey);
}

async function verifyVtxoPolicy(vtxo, context) {
  const {
    aggregateIdentity,
    aggregatePubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv,
    clientDecayCsv,
    clientIdentity,
    clientPubKey,
    expectedScript,
    expectedScriptHex,
    network,
    nuriServerDecay,
    nuriServerPubKey,
  } = context;
  const failures = [];
  if (!vtxo.tapTree) failures.push("missing_tapTree");

  const actualScriptHex = String(vtxo.script || "");
  if (actualScriptHex !== expectedScriptHex) {
    failures.push(`wrong_script:${truncateMiddle(actualScriptHex || "empty", 24)}`);
  }

  let onchainAddress = "";
  let l1Script = "";
  let leafCount = 0;
  if (vtxo.tapTree) {
    try {
      const { decoded, csvLeaves, multisigLeaves } = decodeLeaves(vtxo.tapTree);
      onchainAddress = decoded.onchainAddress(network);
      l1Script = hex.encode(decoded.pkScript);
      leafCount = decoded.scripts.length;
      if (decoded.scripts.length !== 3) failures.push(`leaf_count:${decoded.scripts.length}`);
      if (decoded.scripts.length === 2) failures.push("standard_vtxo_shape");

      const arkadeLeaves = multisigLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return (
          leaf.scriptHex === expectedScript.forfeitScript &&
          pubkeys.length === 2 &&
          sameBytes(pubkeys[0], aggregatePubKey) &&
          sameBytes(pubkeys[1], arkadeServerPubKey)
        );
      });
      if (arkadeLeaves.length !== 1) failures.push(`arkade_leaf_count:${arkadeLeaves.length}`);

      const aggregateRecoveryLeaves = csvLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return (
          leaf.scriptHex === expectedScript.aggregateRecoveryScript &&
          pubkeys.length === 1 &&
          sameBytes(pubkeys[0], aggregatePubKey) &&
          timelockEquals(leaf.decoded?.params?.timelock, arkadeUserExitCsv)
        );
      });
      if (aggregateRecoveryLeaves.length !== 1) {
        failures.push(`aggregate_recovery_leaf_count:${aggregateRecoveryLeaves.length}`);
      }

      const clientRecoveryLeaves = csvLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return (
          leaf.scriptHex === expectedScript.clientRecoveryScript &&
          pubkeys.length === 1 &&
          sameBytes(pubkeys[0], clientPubKey) &&
          timelockEquals(leaf.decoded?.params?.timelock, clientDecayCsv)
        );
      });
      if (clientRecoveryLeaves.length !== 1) {
        failures.push(`client_decay_leaf_count:${clientRecoveryLeaves.length}`);
      }

      const clientLeaves = csvLeaves.filter((leaf) =>
        includesKey(leaf.decoded?.params?.pubkeys || [], clientPubKey),
      );
      const unsafeClientLeaves = clientLeaves.filter(
        (leaf) => !timelockEquals(leaf.decoded?.params?.timelock, clientDecayCsv),
      );
      if (unsafeClientLeaves.length > 0) failures.push("unsafe_client_leaf_present");

      const recoveryLeavesWithArkadeServer = csvLeaves.filter((leaf) =>
        includesKey(leaf.decoded?.params?.pubkeys || [], arkadeServerPubKey),
      );
      if (recoveryLeavesWithArkadeServer.length > 0) failures.push("arkade_key_in_recovery_leaf");

      const directNuriServerLeaves = csvLeaves.filter((leaf) =>
        includesKey(leaf.decoded?.params?.pubkeys || [], nuriServerPubKey),
      );
      if (directNuriServerLeaves.length > 0) failures.push("direct_nuri_server_key_in_leaf");

      if (!timelockGreaterThan(clientDecayCsv, arkadeUserExitCsv)) {
        failures.push("client_only_csv_not_arkade_plus_nuri_server_csv");
      }
    } catch (error) {
      failures.push(`decode_failed:${String(error?.message || error).slice(0, 80)}`);
    }
  }

  const aggregateSignatureOk =
    failures.length === 0 &&
    (await verifyChallengeSignature(
      aggregateIdentity,
      aggregatePubKey,
      "aggregate_recovery",
      vtxo,
      expectedScript.aggregateRecoveryScript,
    ));
  if (!aggregateSignatureOk) failures.push("aggregate_signature_check_failed");

  const clientSignatureOk =
    failures.length === 0 &&
    (await verifyChallengeSignature(
      clientIdentity,
      clientPubKey,
      "client_decay_recovery",
      vtxo,
      expectedScript.clientRecoveryScript,
    ));
  if (!clientSignatureOk) failures.push("client_signature_check_failed");

  return {
    status: failures.length === 0 ? "safe" : "unknown",
    failures,
    onchainAddress,
    l1Script,
    leafCount,
    arkadeUserExitCsv: serializableTimelock(arkadeUserExitCsv),
    nuriServerCsv: serializableTimelock(nuriServerDecay),
    clientRecoveryCsv: serializableTimelock(clientDecayCsv),
    scriptPubkeyHash: l1Script ? sha256Hex(l1Script) : "",
    tapTreeHash: sha256Hex(JSON.stringify(vtxo.tapTree || "")),
  };
}

function classifyExpiry(vtxo, thresholdHours) {
  const expiryMs = Number(vtxo?.virtualStatus?.batchExpiry || 0);
  const nowMs = Date.now();
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) {
    return {
      status: "unknown",
      expiryMs: 0,
      expiresAt: "",
      msRemaining: null,
      thresholdMs: Math.trunc(thresholdHours * 60 * 60 * 1000),
    };
  }
  const thresholdMs = Math.trunc(thresholdHours * 60 * 60 * 1000);
  const msRemaining = expiryMs - nowMs;
  return {
    status: msRemaining <= thresholdMs ? "needs_renewal" : "ok",
    expiryMs,
    expiresAt: new Date(expiryMs).toISOString(),
    msRemaining,
    thresholdMs,
  };
}

function txTypeNeedsVirtualTx(type) {
  return type !== ChainTxType.COMMITMENT && type !== ChainTxType.UNSPECIFIED;
}

async function inspectChainStatuses(chain, onchainProvider) {
  const statuses = [];
  for (const chainTx of chain) {
    if (!txTypeNeedsVirtualTx(chainTx.type)) {
      statuses.push({
        txid: chainTx.txid,
        type: chainTx.type,
        status: "skipped",
        confirmed: false,
      });
      continue;
    }
    try {
      const status = await onchainProvider.getTxStatus(chainTx.txid);
      statuses.push({
        txid: chainTx.txid,
        type: chainTx.type,
        status: status?.confirmed ? "confirmed" : "mempool",
        confirmed: Boolean(status?.confirmed),
        blockHeight: status?.blockHeight ?? null,
        blockTime: status?.blockTime ?? null,
      });
    } catch {
      statuses.push({
        txid: chainTx.txid,
        type: chainTx.type,
        status: "not_found",
        confirmed: false,
      });
    }
  }
  return statuses;
}

function computeNextUnrollStep(chain, statuses) {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const chainTx = chain[i];
    if (!txTypeNeedsVirtualTx(chainTx.type)) continue;
    const status = statuses.find((item) => item.txid === chainTx.txid);
    if (status?.status === "mempool") {
      return { type: "wait", txid: chainTx.txid };
    }
    if (status?.status === "not_found") {
      return { type: "unroll", txid: chainTx.txid, chainType: chainTx.type };
    }
  }
  return { type: "done", txid: "" };
}

function finalizeVirtualTx(psbtBase64, chainType) {
  const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
  if (chainType === ChainTxType.TREE) {
    const input = tx.getInput(0);
    if (!input?.tapKeySig) throw new Error("tree tx missing tapKeySig");
    tx.updateInput(0, {
      finalScriptWitness: [input.tapKeySig],
    });
  } else {
    tx.finalize();
  }
  return tx;
}

async function buildExitDataPackage(vtxo, wallet, expectedScriptHex) {
  const target = { txid: String(vtxo.txid || ""), vout: Number(vtxo.vout || 0) };
  const { chain } = await wallet.indexerProvider.getVtxoChain(target);
  const statuses = await inspectChainStatuses(chain, wallet.onchainProvider);
  const virtualTxids = chain.filter((tx) => txTypeNeedsVirtualTx(tx.type)).map((tx) => tx.txid);
  const virtualTxsResponse =
    virtualTxids.length > 0
      ? await wallet.indexerProvider.getVirtualTxs(virtualTxids)
      : { txs: [] };
  const virtualPsbtByTxid = new Map();
  virtualTxids.forEach((txid, index) => {
    const psbt = virtualTxsResponse.txs[index] || "";
    if (psbt) virtualPsbtByTxid.set(txid, psbt);
  });

  const decodedVirtualTxs = [];
  for (const chainTx of chain) {
    if (!txTypeNeedsVirtualTx(chainTx.type)) continue;
    const psbt = virtualPsbtByTxid.get(chainTx.txid) || "";
    if (!psbt) {
      decodedVirtualTxs.push({
        txid: chainTx.txid,
        type: chainTx.type,
        psbtPresent: false,
        finalized: false,
        error: "missing_virtual_psbt",
      });
      continue;
    }
    try {
      const tx = finalizeVirtualTx(psbt, chainTx.type);
      decodedVirtualTxs.push({
        txid: chainTx.txid,
        type: chainTx.type,
        psbtPresent: true,
        psbtSha256: sha256Hex(psbt),
        finalized: true,
        finalizedTxid: tx.id,
        finalizedHexSha256: sha256Hex(tx.hex),
        expectedScriptOutput: findOutputWithScript(tx, expectedScriptHex),
        targetScriptOutput:
          chainTx.txid === target.txid
            ? findOutputWithScript(tx, expectedScriptHex, target.vout)
            : null,
      });
    } catch (error) {
      decodedVirtualTxs.push({
        txid: chainTx.txid,
        type: chainTx.type,
        psbtPresent: true,
        psbtSha256: sha256Hex(psbt),
        finalized: false,
        error: String(error?.message || error).slice(0, 160),
      });
    }
  }

  const nextStep = computeNextUnrollStep(chain, statuses);
  const nextPsbt = nextStep.type === "unroll" ? virtualPsbtByTxid.get(nextStep.txid) || "" : "";
  let nextUnroll = null;
  if (nextStep.type === "unroll" && nextPsbt) {
    const tx = finalizeVirtualTx(nextPsbt, nextStep.chainType);
    nextUnroll = {
      txid: tx.id,
      hexSha256: sha256Hex(tx.hex),
      expectedScriptOutput: findOutputWithScript(tx, expectedScriptHex),
      rawHex: tx.hex,
    };
  }

  const targetVirtual = decodedVirtualTxs.find((tx) => tx.txid === target.txid);
  const failures = [];
  if (!Array.isArray(chain) || chain.length === 0) failures.push("missing_unroll_chain");
  if (virtualTxids.length !== virtualPsbtByTxid.size) failures.push("missing_virtual_psbt");
  if (!targetVirtual?.targetScriptOutput) failures.push("target_vtxo_script_output_missing");
  if (nextStep.type === "unroll" && !nextUnroll) failures.push("next_unroll_tx_not_buildable");
  if (nextStep.type === "unroll" && nextUnroll && !nextUnroll.expectedScriptOutput) {
    failures.push("next_unroll_tx_expected_script_output_missing");
  }

  const packageCore = {
    format: "nuri-arkade-exit-data-package-v1",
    target,
    builtAt: new Date().toISOString(),
    ready: failures.length === 0,
    failures,
    nextStep,
    nextUnroll,
    chain: chain.map((tx) => ({
      txid: tx.txid,
      type: tx.type,
      expiresAt: tx.expiresAt || "",
      spends: Array.isArray(tx.spends) ? tx.spends : [],
    })),
    statuses,
    virtualTransactions: virtualTxids.map((txid) => ({
      txid,
      psbtBase64: virtualPsbtByTxid.get(txid) || "",
      psbtSha256: virtualPsbtByTxid.get(txid) ? sha256Hex(virtualPsbtByTxid.get(txid)) : "",
    })),
    decodedVirtualTxs,
  };
  return {
    ...packageCore,
    packageHash: sha256Hex(JSON.stringify(packageCore)),
  };
}

async function installPolicyWallet(args, state) {
  const aggregateIdentity = new NuriAggregateIdentity(state.clientKeyHex, state.nuriServerKeyHex);
  const clientIdentity = SingleKey.fromHex(state.clientKeyHex);
  const nuriServerIdentity = SingleKey.fromHex(state.nuriServerKeyHex);

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

  const aggregatePubKey = await aggregateIdentity.xOnlyPublicKey();
  const clientPubKey = await clientIdentity.xOnlyPublicKey();
  const nuriServerPubKey = await nuriServerIdentity.xOnlyPublicKey();
  const arkadeServerPubKey = wallet.arkServerPublicKey;
  const arkadeUserExitCsv = normalizeTimelock(
    wallet.offchainTapscript.options.csvTimelock,
    "Arkade user-exit CSV",
  );
  const nuriServerDecay =
    arkadeUserExitCsv.type === "seconds"
      ? { type: "seconds", value: BigInt(args.nuriDecaySeconds) }
      : { type: "blocks", value: BigInt(args.nuriDecayBlocks) };
  const clientDecayCsv = addSameUnitTimelocks(arkadeUserExitCsv, nuriServerDecay);

  const expectedScript = new NuriServerDecayScript({
    cooperativePubKey: aggregatePubKey,
    clientPubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv,
    clientDecayCsv,
  });
  const boardingArkadeCsv = normalizeTimelock(
    wallet.boardingTapscript.options.csvTimelock,
    "Arkade boarding CSV",
  );
  const boardingClientDecayCsv = addSameUnitTimelocks(boardingArkadeCsv, nuriServerDecay);
  const expectedBoardingScript = new NuriServerDecayScript({
    cooperativePubKey: aggregatePubKey,
    clientPubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv: boardingArkadeCsv,
    clientDecayCsv: boardingClientDecayCsv,
  });
  const expectedScriptHex = hex.encode(expectedScript.pkScript);
  const expectedBoardingScriptHex = hex.encode(expectedBoardingScript.pkScript);
  wallet.offchainTapscript = expectedScript;
  wallet.boardingTapscript = expectedBoardingScript;
  wallet.getWalletScripts = async function getServerDecayWalletScripts() {
    return [expectedScriptHex];
  };
  wallet.getScriptMap = async function getServerDecayScriptMap() {
    return new Map([[expectedScriptHex, expectedScript]]);
  };
  wallet.getVtxos = async function getServerDecayVtxos() {
    const { vtxos } = await wallet.indexerProvider.getVtxos({
      scripts: [expectedScriptHex],
    });
    return (Array.isArray(vtxos) ? vtxos : []).map((vtxo) => ({
      ...vtxo,
      forfeitTapLeafScript: expectedScript.forfeit(),
      intentTapLeafScript: expectedScript.forfeit(),
      tapTree: vtxo.tapTree || expectedScript.encode(),
      script: expectedScriptHex,
      contractScript: expectedScriptHex,
    }));
  };
  try {
    await wallet._vtxoManager?.dispose?.();
  } catch {}
  wallet._vtxoManager = undefined;
  wallet._vtxoManagerInitializing = undefined;
  wallet._contractManager = undefined;
  wallet._contractManagerInitializing = undefined;

  return {
    aggregateIdentity,
    aggregatePubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv,
    clientDecayCsv,
    clientIdentity,
    clientPubKey,
    expectedBoardingScript,
    expectedBoardingScriptHex,
    expectedScript,
    expectedScriptHex,
    nuriServerDecay,
    nuriServerPubKey,
    wallet,
  };
}

function filterVtxos(vtxos, outpoint) {
  const list = Array.isArray(vtxos) ? vtxos : [];
  if (!outpoint) return list;
  const wanted = parseOutpoint(outpoint);
  const selected = list.filter(
    (vtxo) => String(vtxo.txid || "") === wanted.txid && Number(vtxo.vout || 0) === wanted.vout,
  );
  assert(selected.length > 0, `outpoint not found: ${outpoint}`);
  return selected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  log("INFO", "VERSION_MATRIX", versionMatrixFields());
  if (!globalThis.EventSource) globalThis.EventSource = EventSource;

  const state = await loadOrCreateState(args.statePath);
  const setup = await installPolicyWallet(args, state);
  const {
    aggregateIdentity,
    aggregatePubKey,
    arkadeServerPubKey,
    arkadeUserExitCsv,
    clientDecayCsv,
    clientIdentity,
    clientPubKey,
    expectedBoardingScript,
    expectedBoardingScriptHex,
    expectedScript,
    expectedScriptHex,
    nuriServerDecay,
    nuriServerPubKey,
    wallet,
  } = setup;

  try {
    const arkAddress = await wallet.getAddress();
    const boardingAddress = await wallet.getBoardingAddress();
    const expectedArkAddress = expectedScript
      .address(wallet.network.hrp, wallet.arkServerPublicKey)
      .encode();
    const expectedBoardingAddress = expectedBoardingScript.onchainAddress(wallet.network);
    const walletScripts = await wallet.getWalletScripts();
    assert(arkAddress === expectedArkAddress, "wallet default Ark address is not recovery script");
    assert(
      boardingAddress === expectedBoardingAddress,
      "wallet boarding address is not recovery script",
    );
    assert(
      walletScripts.length === 1 && walletScripts[0] === expectedScriptHex,
      "wallet default script set is not recovery-only",
    );
    const l1Address = expectedScript.onchainAddress(wallet.network);
    log("INFO", "SAFETY_PROOF_CONTEXT", {
      type: SERVER_DECAY_CONTRACT_TYPE,
      arkade_address: truncateMiddle(arkAddress, 54),
      boarding_address: boardingAddress,
      l1_address: truncateMiddle(l1Address, 54),
      arkade_user_exit_csv: formatTimelock(arkadeUserExitCsv),
      nuri_server_csv: formatTimelock(nuriServerDecay),
      client_recovery_csv: formatTimelock(clientDecayCsv),
      script: truncateMiddle(expectedScriptHex, 34),
      boarding_script: truncateMiddle(expectedBoardingScriptHex, 34),
      wallet_scripts: walletScripts.length,
    });

    const allVtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    const selectedVtxos = filterVtxos(allVtxos, args.outpoint);
    const skippedSpent = selectedVtxos.filter((vtxo) => vtxo?.isSpent);
    const skippedUnrolled = selectedVtxos.filter((vtxo) => !vtxo?.isSpent && vtxo?.isUnrolled);
    for (const vtxo of skippedUnrolled) {
      log("INFO", "VTXO_SKIPPED_ALREADY_UNROLLED", {
        outpoint: vtxoOutpoint(vtxo),
        value: Number(vtxo.value || 0),
        state: String(vtxo?.virtualStatus?.state || "unknown"),
        reason: "exit_data_package_already_past_unroll_stage",
      });
    }
    const vtxos = selectedVtxos.filter((vtxo) => !vtxo?.isSpent && !vtxo?.isUnrolled);
    if (vtxos.length === 0) {
      const noActiveReportCore = {
        format: "nuri-arkade-vtxo-safety-proof-v1",
        createdAt: new Date().toISOString(),
        nodeUrl: args.nodeUrl,
        arkAddress,
        boardingAddress,
        expectedL1Address: l1Address,
        expectedScriptHash: sha256Hex(expectedScriptHex),
        thresholdHours: args.renewalThresholdHours,
        summary: {
          total: 0,
          safe: 0,
          needsRenewal: 0,
          unknown: 0,
          skippedSpent: skippedSpent.length,
          skippedUnrolled: skippedUnrolled.length,
          status: "no_active_vtxos_to_package",
        },
        skipped: {
          spent: skippedSpent.map((vtxo) => vtxoOutpoint(vtxo)),
          unrolled: skippedUnrolled.map((vtxo) => vtxoOutpoint(vtxo)),
        },
        records: [],
      };
      const noActiveReport = {
        ...noActiveReportCore,
        reportHash: sha256Hex(JSON.stringify(noActiveReportCore)),
      };
      if (!args.noWrite) {
        await saveJson(args.outPath, noActiveReport);
      }
      log("ERROR", "NO_ACTIVE_VTXOS_TO_PACKAGE", {
        total_seen: Array.isArray(allVtxos) ? allVtxos.length : 0,
        selected: selectedVtxos.length,
        skipped_spent: skippedSpent.length,
        skipped_unrolled: skippedUnrolled.length,
        reason: "need_unspent_not_unrolled_vtxo",
        report: args.noWrite ? "not_written" : args.outPath,
      });
      process.exitCode = 1;
      return;
    }

    const records = [];
    for (const vtxo of vtxos) {
      const policy = await verifyVtxoPolicy(vtxo, {
        aggregateIdentity,
        aggregatePubKey,
        arkadeServerPubKey,
        arkadeUserExitCsv,
        clientDecayCsv,
        clientIdentity,
        clientPubKey,
        expectedScript,
        expectedScriptHex,
        network: wallet.network,
        nuriServerDecay,
        nuriServerPubKey,
      });
      const expiry = classifyExpiry(vtxo, args.renewalThresholdHours);
      let exitPackage = null;
      const exitFailures = [];
      if (policy.status === "safe" && !vtxo.isUnrolled) {
        try {
          exitPackage = await buildExitDataPackage(vtxo, wallet, expectedScriptHex);
        } catch (error) {
          exitFailures.push(String(error?.message || error).slice(0, 180));
        }
      } else if (vtxo.isUnrolled) {
        exitFailures.push("already_unrolled");
      } else {
        exitFailures.push("policy_not_safe");
      }

      const record = {
        outpoint: vtxoOutpoint(vtxo),
        valueSats: Number(vtxo.value || 0),
        state: String(vtxo?.virtualStatus?.state || "unknown"),
        spent: Boolean(vtxo?.isSpent),
        unrolled: Boolean(vtxo?.isUnrolled),
        policyStatus: policy.status,
        safetyStatus:
          policy.status === "safe" && exitPackage?.ready && expiry.status !== "unknown"
            ? expiry.status === "needs_renewal"
              ? "needs_renewal"
              : "safe"
            : "unknown",
        policy,
        expiry,
        exitDataPackageReady: Boolean(exitPackage?.ready),
        exitDataPackageHash: exitPackage?.packageHash || "",
        exitDataPackage: exitPackage,
        exitFailures,
      };
      records.push(record);
      log(record.safetyStatus === "unknown" ? "ERROR" : "INFO", "VTXO_SAFETY_RESULT", {
        outpoint: record.outpoint,
        value: record.valueSats,
        state: record.state,
        policy: record.policyStatus,
        exit_data: record.exitDataPackageReady ? "ready" : "missing",
        expiry: expiry.status,
        safety: record.safetyStatus,
        package: truncateMiddle(record.exitDataPackageHash, 18),
        failures:
          [...policy.failures, ...exitFailures, ...(exitPackage?.failures || [])].join(",") ||
          "none",
      });
    }

    const safeCount = records.filter((record) => record.safetyStatus === "safe").length;
    const renewalCount = records.filter((record) => record.safetyStatus === "needs_renewal").length;
    const unknownCount = records.filter((record) => record.safetyStatus === "unknown").length;
    const reportCore = {
      format: "nuri-arkade-vtxo-safety-proof-v1",
      createdAt: new Date().toISOString(),
      nodeUrl: args.nodeUrl,
      arkAddress,
      boardingAddress,
      expectedL1Address: l1Address,
      expectedScriptHash: sha256Hex(expectedScriptHex),
      thresholdHours: args.renewalThresholdHours,
      summary: {
        total: records.length,
        safe: safeCount,
        needsRenewal: renewalCount,
        unknown: unknownCount,
      },
      records,
    };
    const report = {
      ...reportCore,
      reportHash: sha256Hex(JSON.stringify(reportCore)),
    };
    if (!args.noWrite) {
      await saveJson(args.outPath, report);
    }
    const verdict = unknownCount === 0 ? "PASS" : "FAIL";
    log(verdict === "PASS" ? "INFO" : "ERROR", "SUMMARY", {
      verdict,
      total: records.length,
      safe: safeCount,
      needs_renewal: renewalCount,
      unknown: unknownCount,
      report: args.noWrite ? "not_written" : args.outPath,
      report_hash: truncateMiddle(report.reportHash, 18),
    });
    if (unknownCount > 0) process.exitCode = 1;
  } finally {
    await wallet.dispose?.();
  }
}

main().catch((error) => {
  log("ERROR", "CHECK_FAILED", { err: String(error?.message || error).slice(0, 240) });
  process.exitCode = 1;
});
