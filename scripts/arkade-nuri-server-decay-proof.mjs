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
import { hex } from "@scure/base";
import {
  CSVMultisigTapscript,
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
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { EventSource } from "eventsource";
import {
  ARKADE_CONTRACT_CONFIG,
  NURI_SERVER_CSV_POLICY,
  versionMatrixFields,
} from "./arkade-version-matrix.mjs";

const SRC = "scripts/arkade-nuri-server-decay-proof.mjs";
const SERVER_DECAY_CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-server-decay-proof-mainnet.json",
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
    onboard: false,
    broadcastUnroll: false,
    outpoint: "",
    feeKey: "fee",
    nuriDecaySeconds: NURI_SERVER_CSV_POLICY.value,
    nuriDecayBlocks: 1,
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
    } else if (arg === "--onboard") {
      args.onboard = true;
    } else if (arg === "--broadcast-unroll") {
      args.broadcastUnroll = true;
    } else if (arg === "--outpoint") {
      args.outpoint = String(next || "");
      i += 1;
    } else if (arg === "--fee-key") {
      args.feeKey = String(next || "");
      i += 1;
    } else if (arg === "--nuri-decay-seconds") {
      args.nuriDecaySeconds = Number(next || 0);
      i += 1;
    } else if (arg === "--nuri-decay-blocks") {
      args.nuriDecayBlocks = Number(next || 0);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.feeKey !== "fee" && args.feeKey !== "client") {
    throw new Error("--fee-key must be fee or client");
  }
  if (!Number.isInteger(args.nuriDecaySeconds) || args.nuriDecaySeconds <= 0) {
    throw new Error("--nuri-decay-seconds must be positive");
  }
  if (!Number.isInteger(args.nuriDecayBlocks) || args.nuriDecayBlocks <= 0) {
    throw new Error("--nuri-decay-blocks must be positive");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-nuri-server-decay-proof.mjs
  node scripts/arkade-nuri-server-decay-proof.mjs --onboard
  node scripts/arkade-nuri-server-decay-proof.mjs --broadcast-unroll --outpoint <txid:vout>

Proves the desired server-decay policy:
  - Arkade path: Nuri aggregate(client+server) + Arkade server
  - L1 Nuri-server-available path: Nuri aggregate(client+server) + Arkade CSV
  - L1 Nuri-server-gone path: Nuri client + Arkade CSV + Nuri server CSV

Defaults:
  --nuri-decay-seconds ${NURI_SERVER_CSV_POLICY.value}  Nuri server CSV when Arkade CSV is seconds-based
  --nuri-decay-blocks 1     Nuri server CSV when Arkade CSV is block-based

Options:
  --state PATH              Default: ${DEFAULT_STATE_PATH}
  --node URL                Default: ${DEFAULT_NODE_URL}
  --esplora URL             Default: ${DEFAULT_ESPLORA_URL}
  --onboard                 Onboard confirmed boarding funds into the custom VTXO
  --broadcast-unroll        Verify/broadcast selected VTXO unroll package
  --outpoint <txid:vout>    Exact VTXO to unroll
  --fee-key fee|client      Anchor fee key from state. Default: fee`);
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

async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function loadOrCreateState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert(typeof state.clientKeyHex === "string", "state missing clientKeyHex");
    assert(typeof state.nuriServerKeyHex === "string", "state missing nuriServerKeyHex");
    if (!state.feeKeyHex) {
      state.feeKeyHex = SingleKey.fromRandomBytes().toHex();
      await saveState(statePath, state);
    }
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    clientKeyHex: SingleKey.fromRandomBytes().toHex(),
    nuriServerKeyHex: SingleKey.fromRandomBytes().toHex(),
    feeKeyHex: SingleKey.fromRandomBytes().toHex(),
    expectedArkAddress: "",
    expectedBoardingAddress: "",
  };
  await saveState(statePath, state);
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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function verifyChallengeSignature(identity, pubkey, label, vtxo, scriptHex) {
  const challenge = createHash("sha256")
    .update("nuri-server-decay-proof-v1")
    .update(label)
    .update(vtxo.txid)
    .update(String(vtxo.vout))
    .update(scriptHex)
    .digest();
  const signature = await identity.signMessage(new Uint8Array(challenge), "schnorr");
  return schnorr.verify(signature, new Uint8Array(challenge), pubkey);
}

async function checkVtxo(vtxo, context) {
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
    nuriServerDecay,
    nuriServerPubKey,
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
      if (decoded.scripts.length !== 3) failures.push(`leaf_count:${decoded.scripts.length}`);
      if (decoded.scripts.length === 2) failures.push("standard_vtxo_shape");

      const forfeitLeaves = multisigLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return (
          leaf.scriptHex === expectedScript.forfeitScript &&
          pubkeys.length === 2 &&
          sameBytes(pubkeys[0], aggregatePubKey) &&
          sameBytes(pubkeys[1], arkadeServerPubKey)
        );
      });
      if (forfeitLeaves.length !== 1) failures.push(`arkade_leaf_count:${forfeitLeaves.length}`);

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

      const clientLeaves = csvLeaves.filter((leaf) => {
        const pubkeys = leaf.decoded?.params?.pubkeys || [];
        return includesKey(pubkeys, clientPubKey);
      });
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

  const pass = failures.length === 0;
  log(pass ? "INFO" : "ERROR", pass ? "SERVER_DECAY_VTXO_PASS" : "SERVER_DECAY_VTXO_FAIL", {
    outpoint: vtxoOutpoint(vtxo),
    value: vtxo.value,
    state: vtxo.virtualStatus?.state || "unknown",
    spent: vtxo.isSpent || false,
    unrolled: vtxo.isUnrolled || false,
    arkade_path: "nuri_aggregate_plus_arkade_server",
    nuri_server_available_path: "nuri_aggregate_after_arkade_csv",
    nuri_server_gone_path: "nuri_client_after_arkade_csv_plus_nuri_server_csv",
    l1: truncateMiddle(onchainAddress, 42),
    l1_script: truncateMiddle(l1Script, 34),
    arkade_user_exit_csv: formatTimelock(arkadeUserExitCsv),
    nuri_server_csv: formatTimelock(nuriServerDecay),
    arkade_plus_nuri_server_csv: formatTimelock(clientDecayCsv),
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
    assert(selected, `requested outpoint did not pass server-decay proof: ${requestedOutpoint}`);
    return selected;
  }
  assert(candidates.length > 0, "no recoverable unspent VTXO available to unroll");
  if (candidates.length > 1) {
    throw new Error("multiple recoverable VTXOs found; pass --outpoint <txid:vout>");
  }
  return candidates[0];
}

async function broadcastUnrollProof({ args, state, wallet, selectedVtxo, expectedScriptHex }) {
  const feeKeyHex = args.feeKey === "client" ? String(state.clientKeyHex) : String(state.feeKeyHex);
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
    assert(output, "existing unroll tx does not contain expected server-decay L1 script");
    log("INFO", "UNROLL_EXISTING_TX_SCRIPT_PASS", {
      checked_vtxo: vtxoOutpoint(selectedVtxo),
      unroll_parent_txid: step.txid,
      existing_tx_visible: "pass",
      l1_script_match: "pass",
      output_index: output.index,
      output_amount: output.amount,
    });
    return true;
  }

  assert(step.type === Unroll.StepType.UNROLL, `unexpected unroll step ${stepType || step.type}`);
  const expectedOutput = findOutputWithScript(step.tx, expectedScriptHex);
  assert(expectedOutput, "unroll tx does not contain expected server-decay L1 script");

  const [parentHex, childHex] = await bumper.bumpP2A(step.tx);
  const parentTx = txFromHex(parentHex);
  const childTx = txFromHex(childHex);
  const parentTxid = parentTx.id;
  const childTxid = childTx.id;
  log("INFO", "UNROLL_PACKAGE_BUILT", {
    checked_vtxo: vtxoOutpoint(selectedVtxo),
    unroll_parent_txid: parentTxid,
    anchor_child_txid: childTxid,
    l1_script_match_prebroadcast: "pass",
    expected_next: "broadcast_unroll_package",
  });

  try {
    const response = await bumper.provider.broadcastTransaction(parentHex, childHex);
    log("INFO", "UNROLL_PACKAGE_BROADCAST_OK", {
      checked_vtxo: vtxoOutpoint(selectedVtxo),
      unroll_parent_txid: parentTxid,
      anchor_child_txid: childTxid,
      response: truncateMiddle(JSON.stringify(response), 180),
      expected_next: "verify_node_visibility",
    });
  } catch (error) {
    log("ERROR", "UNROLL_PACKAGE_BROADCAST_FAIL", {
      checked_vtxo: vtxoOutpoint(selectedVtxo),
      unroll_parent_txid: parentTxid,
      anchor_child_txid: childTxid,
      err: truncateMiddle(String(error?.message || error), 180),
    });
    throw error;
  }

  await sleepMs(2000);
  const parentAccepted = await assertNodeKnowsTx(wallet.onchainProvider, parentTxid);
  const childAccepted = await assertNodeKnowsTx(wallet.onchainProvider, childTxid);
  const parentOutput = findOutputWithScript(parentTx, expectedScriptHex);
  const accepted = parentAccepted && childAccepted && !!parentOutput;

  log(
    accepted ? "INFO" : "ERROR",
    accepted ? "UNROLL_PACKAGE_VISIBLE_PASS" : "UNROLL_PACKAGE_VISIBLE_FAIL",
    {
      checked_vtxo: vtxoOutpoint(selectedVtxo),
      unroll_parent_txid: parentTxid,
      anchor_child_txid: childTxid,
      node_accept_parent: parentAccepted ? "pass" : "fail",
      node_accept_child: childAccepted ? "pass" : "fail",
      l1_script_match: parentOutput ? "pass" : "fail",
      output_index: parentOutput?.index ?? "",
      output_amount: parentOutput?.amount ?? "",
    },
  );
  return accepted;
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

async function onboardConfirmedBoarding(wallet) {
  const boardingUtxos = await wallet.getBoardingUtxos();
  const confirmed = boardingUtxos.filter((utxo) => utxo?.status?.confirmed);
  log("INFO", "BOARDING_UTXOS", {
    total: boardingUtxos.length,
    confirmed: confirmed.length,
    confirmed_sats: confirmed.reduce((sum, utxo) => sum + Number(utxo.value || 0), 0),
  });
  if (confirmed.length === 0) return false;
  const infoResponse = await wallet.arkProvider.getInfo();
  const ramps = new Ramps(wallet);
  const arkTxid = await ramps.onboard(infoResponse.fees, confirmed, undefined, (event) => {
    log("INFO", "ONBOARD_EVENT", {
      type: event?.type || "unknown",
      id: truncateMiddle(event?.id || event?.txid || "", 24),
    });
  });
  log("INFO", "ONBOARD_BROADCAST", { ark_txid: truncateMiddle(arkTxid, 32) });
  return true;
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

    if (!state.expectedArkAddress) {
      state.expectedArkAddress = arkAddress;
      state.expectedBoardingAddress = boardingAddress;
      await saveState(args.statePath, state);
    }
    if (state.expectedArkAddress !== arkAddress) {
      throw new Error(
        `arkade_address_drift expected=${state.expectedArkAddress} got=${arkAddress}`,
      );
    }

    const feeAddress = (
      await OnchainWallet.create(
        SingleKey.fromHex(String(state.feeKeyHex || state.clientKeyHex)),
        wallet.networkName,
        wallet.onchainProvider,
      )
    ).address;

    log("INFO", "EXPECTED_SERVER_DECAY_POLICY", {
      arkade_address: truncateMiddle(arkAddress, 54),
      boarding_address: boardingAddress,
      fee_address: feeAddress,
      l1_address: truncateMiddle(l1Address, 54),
      arkade_path: "nuri_aggregate_client_plus_server_plus_arkade_server",
      nuri_server_available_path: "nuri_aggregate_client_plus_server_after_arkade_csv",
      nuri_server_gone_path: "nuri_client_after_arkade_csv_plus_nuri_server_csv",
      arkade_user_exit_csv: formatTimelock(arkadeUserExitCsv),
      nuri_server_csv: formatTimelock(nuriServerDecay),
      arkade_plus_nuri_server_csv: formatTimelock(clientDecayCsv),
      nuri_aggregate_pk: truncateMiddle(hex.encode(aggregateIdentity.aggregatedPk33), 18),
      nuri_aggregate_meaning: "nuri_client_plus_nuri_server",
      nuri_client_pk: truncateMiddle(hex.encode(clientPubKey), 18),
      nuri_server_pk: truncateMiddle(hex.encode(nuriServerPubKey), 18),
      arkade_server_pk: truncateMiddle(hex.encode(arkadeServerPubKey), 18),
      script: truncateMiddle(expectedScriptHex, 34),
    });
    log("INFO", "RECOVERY_DEFAULT_ADDRESS_PASS", {
      type: SERVER_DECAY_CONTRACT_TYPE,
      arkade_address: truncateMiddle(arkAddress, 54),
      boarding_address: boardingAddress,
      offchain_script: truncateMiddle(expectedScriptHex, 34),
      boarding_script: truncateMiddle(expectedBoardingScriptHex, 34),
      wallet_scripts: walletScripts.length,
    });

    if (args.onboard) {
      await onboardConfirmedBoarding(wallet);
    }

    const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    if (vtxos.length === 0) {
      log("ERROR", "NO_VTXOS_FOUND", {
        reason: "fund_boarding_or_onboard_first",
        boarding_address: boardingAddress,
        rerun: "node_scripts/arkade-nuri-server-decay-proof.mjs_--onboard",
      });
      process.exitCode = 1;
      return;
    }

    let passCount = 0;
    let checkedCount = 0;
    let skippedSpentCount = 0;
    const candidates = [];
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
      if (pass) {
        passCount += 1;
        if (!vtxo.isUnrolled) candidates.push(vtxo);
      }
    }

    const verdict = checkedCount > 0 && passCount === checkedCount ? "PASS" : "FAIL";
    log(verdict === "PASS" ? "INFO" : "ERROR", "SUMMARY", {
      verdict,
      pass: passCount,
      checked: checkedCount,
      skipped_spent: skippedSpentCount,
      total_seen: vtxos.length,
      arkade_path: "nuri_aggregate_client_plus_server_plus_arkade_server",
      nuri_server_available_path: "nuri_aggregate_client_plus_server_after_arkade_csv",
      nuri_server_gone_path: "nuri_client_after_arkade_csv_plus_nuri_server_csv",
    });
    if (verdict !== "PASS") {
      process.exitCode = 1;
      return;
    }

    if (args.broadcastUnroll) {
      const selectedVtxo = selectBroadcastVtxo(candidates, args.outpoint);
      const unrollOk = await broadcastUnrollProof({
        args,
        state,
        wallet,
        selectedVtxo,
        expectedScriptHex,
      });
      if (!unrollOk) process.exitCode = 1;
    }
  } finally {
    await wallet.dispose?.();
  }
}

main().catch((error) => {
  log("ERROR", "CHECK_FAILED", { err: String(error?.message || error).slice(0, 240) });
  process.exitCode = 1;
});
