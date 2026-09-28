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
  TxWeightEstimator,
  Unroll,
  VtxoScript,
  Wallet,
  contractHandlers,
  networks,
  timelockToSequence,
} from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { EventSource } from "eventsource";
import {
  ARKADE_CONTRACT_CONFIG,
  NURI_SERVER_CSV_POLICY,
  versionMatrixFields,
} from "./arkade-version-matrix.mjs";

const SRC = "scripts/arkade-batch-e2e.mjs";
const CONTRACT_TYPE = ARKADE_CONTRACT_CONFIG.nuri_contract_type;
const STRICT_LIVE_PROFILE = "nuri-arkade-mainnet-onchain-strict-v1";
const BITCOIN_DUST_SATS = 546;
const DEFAULT_NODE_URL = "https://arkade.computer";
const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".codex",
  "memories",
  "nuri-arkade-batch-e2e-mainnet.json",
);
const PLACEHOLDER_XONLY_HEX = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PLACEHOLDER_XONLY = hex.decode(PLACEHOLDER_XONLY_HEX);

let lastLogAt = Date.now();

function shortTime(date = new Date()) {
  return date.toISOString().slice(11, 23);
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

function formatLogValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Uint8Array) return truncateMiddle(hex.encode(value), 24);
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.replace(/\s+/g, "_");
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

function parseArgs(argv) {
  const args = {
    mode: "offline",
    nodeUrl: DEFAULT_NODE_URL,
    esploraUrl: DEFAULT_ESPLORA_URL,
    statePath: DEFAULT_STATE_PATH,
    artifactPath: "",
    returnAddress: "",
    boardingSats: 4000,
    anchorReserveSats: 4000,
    timeoutMs: 240000,
    csvBlocks: 1,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--mode") {
      args.mode = String(next || "");
      i += 1;
    } else if (arg === "--node") {
      args.nodeUrl = String(next || "");
      i += 1;
    } else if (arg === "--esplora") {
      args.esploraUrl = String(next || "");
      i += 1;
    } else if (arg === "--state") {
      args.statePath = String(next || "");
      i += 1;
    } else if (arg === "--artifact") {
      args.artifactPath = String(next || "");
      i += 1;
    } else if (arg === "--return-address") {
      args.returnAddress = String(next || "");
      i += 1;
    } else if (arg === "--boarding-sats") {
      args.boardingSats = Number(next || 0);
      i += 1;
    } else if (arg === "--anchor-reserve-sats") {
      args.anchorReserveSats = Number(next || 0);
      i += 1;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(next || 0);
      i += 1;
    } else if (arg === "--csv") {
      args.csvBlocks = Number(next || 0);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["offline", "real", "strict-live", "return-remainder"].includes(args.mode)) {
    throw new Error("--mode must be offline, real, strict-live, or return-remainder");
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  if (!Number.isInteger(args.csvBlocks) || args.csvBlocks <= 0) {
    throw new Error("--csv must be a positive block count");
  }
  if (!Number.isInteger(args.boardingSats) || args.boardingSats <= 0) {
    throw new Error("--boarding-sats must be a positive sat amount");
  }
  if (!Number.isInteger(args.anchorReserveSats) || args.anchorReserveSats <= 0) {
    throw new Error("--anchor-reserve-sats must be a positive sat amount");
  }
  args.strictLive = args.mode === "strict-live";
  args.returnOnly = args.mode === "return-remainder";
  args.oneFundingAddress = args.strictLive;
  if ((args.strictLive || args.returnOnly) && !args.returnAddress) {
    throw new Error("--return-address is required for strict-live and return-remainder");
  }
  if (!args.artifactPath) {
    args.artifactPath = args.returnOnly
      ? `${args.statePath}.return-remainder-proof.json`
      : `${args.statePath}.strict-live-proof.json`;
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/arkade-batch-e2e.mjs --mode offline
  node scripts/arkade-batch-e2e.mjs --mode real
  node scripts/arkade-batch-e2e.mjs --mode strict-live
  node scripts/arkade-batch-e2e.mjs --mode return-remainder

Options:
  --mode offline|real|strict-live Default: offline
  --node URL                 Default: ${DEFAULT_NODE_URL}
  --esplora URL              Default: ${DEFAULT_ESPLORA_URL}
  --state PATH               Default: ${DEFAULT_STATE_PATH}
  --artifact PATH            Default: <state>.strict-live-proof.json
  --return-address ADDRESS   Required for strict-live
  --boarding-sats N          Default: 4000
  --anchor-reserve-sats N    Default: 4000
  --timeout-ms N             Default: 240000
  --csv N                    Nuri recovery CSV blocks. Default: 1
`);
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
    pubKey: PLACEHOLDER_XONLY,
    serverPubKey: PLACEHOLDER_XONLY,
    csvTimelock: timelock,
  });
  return Number(serialized.csvTimelock || 0);
}

function sequenceToArkadeTimelock(sequence) {
  const parsed = DefaultContractHandler.deserializeParams({
    pubKey: PLACEHOLDER_XONLY_HEX,
    serverPubKey: PLACEHOLDER_XONLY_HEX,
    csvTimelock: String(sequence),
  });
  return parsed.csvTimelock;
}

function assertXOnly(pubkey, field) {
  assert(pubkey instanceof Uint8Array && pubkey.length === 32, `${field} must be 32 bytes`);
}

function assertCsvBlocks(timelock, field) {
  const blocks = getBlockCsvValue(timelock);
  assert(blocks > 0, `${field} must be a positive block timelock`);
  return blocks;
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
    const aggregated = musig2.keyAggregate(this.sortedKeys);
    this.aggregatedPk33 = aggregated.aggPublicKey.toBytes(true);
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
    if (!inputIndexes && signed === 0) {
      throw new Error("No inputs signed");
    }
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

function makeLiveSource(name) {
  const waiters = [];
  const queue = [];
  let started = false;
  let closed = false;
  return {
    emit(event) {
      if (!started || closed) return false;
      if (waiters.length > 0) {
        waiters.shift()({ value: event, done: false });
      } else {
        queue.push(event);
      }
      return true;
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
    },
    stream() {
      return (async function* liveStream() {
        started = true;
        info("offline_stream", "consumer_started", { name });
        while (!closed) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          const next = await new Promise((resolve) => waiters.push(resolve));
          if (next.done) return;
          yield next.value;
        }
      })();
    },
  };
}

function primeAsyncIterable(iterable, name) {
  const queue = [];
  const waiters = [];
  let done = false;
  let failure = null;
  const flush = () => {
    while (waiters.length > 0 && queue.length > 0) {
      waiters.shift().resolve({ value: queue.shift(), done: false });
    }
    if ((done || failure) && waiters.length > 0) {
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        if (failure) waiter.reject(failure);
        else waiter.resolve({ value: undefined, done: true });
      }
    }
  };
  info("prime_stream", "pump_started", { name });
  (async () => {
    try {
      for await (const event of iterable) {
        queue.push(event);
        flush();
      }
      done = true;
      flush();
    } catch (error) {
      failure = error;
      flush();
    }
  })();

  const iterator = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift(), done: false });
      }
      if (failure) return Promise.reject(failure);
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

async function firstEvent(iterable, timeoutMs) {
  return withTimeout(
    timeoutMs,
    (async () => {
      for await (const event of iterable) return event;
      return null;
    })(),
    "first_event",
  );
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

function errorText(error, max = 240) {
  return String(error?.message || error || "unknown_error")
    .replace(/\s+/g, "_")
    .slice(0, max);
}

function decodeRawTransaction(txHex) {
  return btc.Transaction.fromRaw(hex.decode(txHex));
}

function txVersion(tx) {
  return Number(tx?.version ?? tx?.opts?.version ?? 0);
}

function isAlreadyBroadcastTransactionError(error) {
  return /code.{0,12}-27|already_in_utxo_set|already in (block|utxo)|Transaction_outputs_already/i.test(
    errorText(error, 1800),
  );
}

async function txVisibility(onchainProvider, txid) {
  try {
    const status = await onchainProvider.getTxStatus(txid);
    return status?.confirmed ? `confirmed:${status.blockHeight || "unknown"}` : "mempool";
  } catch (error) {
    return `missing:${errorText(error)}`;
  }
}

function forceIntegerFeeRate(onchainProvider, label) {
  const getFeeRate = onchainProvider.getFeeRate.bind(onchainProvider);
  onchainProvider.getFeeRate = async () => {
    const rawFeeRate = await getFeeRate();
    const feeRate = Math.max(1, Math.ceil(Number(rawFeeRate || 1)));
    if (feeRate !== rawFeeRate) {
      info("real_fee", "rounded", {
        label,
        raw: rawFeeRate,
        safe: feeRate,
      });
    }
    return feeRate;
  };
}

async function proveBatchStreamRace() {
  const cold = makeLiveSource("cold_lazy");
  const coldStream = cold.stream();
  const coldDelivered = cold.emit({ type: "batch_started", id: "cold_missed" });
  const coldEvent = await firstEvent(coldStream, 100).catch(() => null);
  cold.close();
  assert(coldDelivered === false, "cold stream unexpectedly accepted pre-consumer event");
  assert(!coldEvent, "cold stream caught a pre-consumer event");
  info("offline_stream", "cold_race_reproduced", {
    pre_consumer_event: "missed",
    expected: "missed",
  });

  const hot = makeLiveSource("hot_primed");
  const primedStream = primeAsyncIterable(hot.stream(), "hot_primed");
  await sleep(0);
  const hotDelivered = hot.emit({ type: "batch_started", id: "hot_caught" });
  const hotEvent = await firstEvent(primedStream, 1000);
  hot.close();
  assert(hotDelivered === true, "primed stream did not accept event");
  assert(hotEvent?.type === "batch_started", "primed stream did not catch batch_started");
  info("offline_stream", "primed_stream_proved", {
    event: hotEvent.type,
    id: hotEvent.id,
    expected: "caught",
  });
}

async function randomXOnlyIdentity() {
  const identity = SingleKey.fromRandomBytes();
  return {
    identity,
    xonly: await identity.xOnlyPublicKey(),
  };
}

async function buildOfflineContract(csvBlocks) {
  const cooperative = await randomXOnlyIdentity();
  const client = await randomXOnlyIdentity();
  const server = await randomXOnlyIdentity();
  const script = new NuriClientRecoveryScript({
    cooperativePubKey: cooperative.xonly,
    clientPubKey: client.xonly,
    serverPubKey: server.xonly,
    csvTimelock: { type: "blocks", value: BigInt(csvBlocks) },
  });
  return {
    script,
    cooperativePubKey: cooperative.xonly,
    clientPubKey: client.xonly,
    serverPubKey: server.xonly,
    csvBlocks,
    network: networks.bitcoin,
  };
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
    clientXonly: hex.encode(clientPubKey),
    cooperativeXonly: hex.encode(cooperativePubKey),
    serverXonly: hex.encode(serverPubKey),
  };
}

async function proveOfflineRecoveryContract(csvBlocks) {
  registerNuriClientRecoveryContract();
  const proof = await buildOfflineContract(csvBlocks);
  const result = verifyClientRecoveryTapTree({
    tapTree: proof.script.encode(),
    cooperativePubKey: proof.cooperativePubKey,
    clientPubKey: proof.clientPubKey,
    serverPubKey: proof.serverPubKey,
    csvBlocks: proof.csvBlocks,
    network: proof.network,
  });
  info("offline_contract", "client_recovery_proved", {
    verdict: result.verdict,
    leaves: result.leafCount,
    csv_leaves: result.csvLeaves,
    forfeit_leaves: result.forfeitLeaves,
    l1_exit: truncateMiddle(result.l1ExitAddress, 32),
    script: truncateMiddle(result.scriptPubKey, 28),
  });
  return result;
}

async function proveAggregateIdentitySigning() {
  const client = SingleKey.fromRandomBytes();
  const nuriServer = SingleKey.fromRandomBytes();
  const identity = new LocalAggregateIdentity(client.toHex(), nuriServer.toHex());
  const msg32 = sha256Bytes(new TextEncoder().encode("nuri-arkade-aggregate-proof"));
  const sig = await identity.signMessage(msg32, "schnorr");
  const ok = schnorr.verify(sig, msg32, await identity.xOnlyPublicKey());
  assert(ok, "aggregate identity signature did not verify");
  info("offline_aggregate", "cosign_proved", {
    verdict: "pass",
    client_pk: truncateMiddle(hex.encode(identity.clientPk33), 18),
    nuri_server_pk: truncateMiddle(hex.encode(identity.nuriServerPk33), 18),
    aggregate_pk: truncateMiddle(hex.encode(identity.aggregatedPk33), 18),
  });
}

async function runOffline(args) {
  info("main", "offline_start", { mode: "offline", csv: args.csvBlocks });
  await proveBatchStreamRace();
  await proveAggregateIdentitySigning();
  const proof = await proveOfflineRecoveryContract(args.csvBlocks);
  info("main", "final", {
    mode: "offline",
    verdict: "pass",
    stream: "primed",
    contract: CONTRACT_TYPE,
    client_csv_leaf: "pass",
    forfeit_leaf: "pass",
    old_format: "absent",
    l1_exit: truncateMiddle(proof.l1ExitAddress, 32),
  });
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
    version: 2,
    createdAt: new Date().toISOString(),
    account: "nuri-arkade-batch-e2e-mainnet",
    clientKeyHex: client.toHex(),
    nuriServerKeyHex: nuriServer.toHex(),
    expectedBoardingAddress: "",
    expectedArkAddress: "",
    expectedClientAnchorAddress: "",
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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

function createStrictLiveProof(args) {
  return {
    schemaVersion: 1,
    profile: STRICT_LIVE_PROFILE,
    mode: args.mode,
    strictLive: args.strictLive,
    verdict: "running",
    startedAt: new Date().toISOString(),
    completedAt: "",
    versions: {
      ...versionMatrixFields(),
      bitcoinTransactionVersion: "decoded-from-live-transactions",
      fallbackPolicy: args.strictLive ? "fail" : "warn",
    },
    endpoints: {
      arkadeNodeUrl: args.nodeUrl,
      esploraUrl: args.esploraUrl,
    },
    funding: {
      oneFundingAddress: args.oneFundingAddress,
      requestedBoardingSats: args.boardingSats,
      requestedAnchorReserveSats: args.anchorReserveSats,
      returnAddress: args.returnAddress,
    },
    statePath: args.statePath,
    addresses: {},
    balances: {},
    proof: {},
    onboarding: {},
    unroll: {},
    spend: {},
    error: null,
  };
}

async function saveProofArtifact(artifactPath, proof) {
  if (!artifactPath) return;
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  info("strict_artifact", "saved", {
    path: artifactPath,
    verdict: proof.verdict,
  });
}

async function installClientRecoveryWallet(wallet, clientIdentity, csvBlocksOverride) {
  registerNuriClientRecoveryContract();
  const cooperativePubKey = await wallet.identity.xOnlyPublicKey();
  const clientPubKey = await clientIdentity.xOnlyPublicKey();
  const serverPubKey = wallet.arkServerPublicKey;
  assertXOnly(serverPubKey, "wallet.arkServerPublicKey");
  const defaultTimelock = wallet.offchainTapscript?.options?.csvTimelock;
  const csvTimelock = csvBlocksOverride
    ? { type: "blocks", value: BigInt(csvBlocksOverride) }
    : defaultTimelock;
  const csvBlocks = assertCsvBlocks(csvTimelock, "csvTimelock");
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
  info("real_contract", "installed", {
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

function patchArkProvider(provider) {
  if (!provider || provider.__nuriBatchE2ePatched) return;
  provider.__nuriBatchE2ePatched = true;
  provider.__nuriStreamReadyPromise = null;

  const originalGetEventStream = provider.getEventStream?.bind(provider);
  if (originalGetEventStream) {
    provider.getEventStream = (signal, topics = []) => {
      info("real_stream", "prime", { topics: topics.join(",") || "none" });
      let resolveReady;
      provider.__nuriStreamReadyPromise = new Promise((resolve) => {
        resolveReady = resolve;
      });
      const source = originalGetEventStream(signal, topics);
      const readySource = (async function* streamReadyMarker() {
        for await (const event of source) {
          if (event?.type === "stream_started") {
            info("real_stream", "ready", {
              event: "stream_started",
              id: truncateMiddle(event?.id || "", 24),
            });
            resolveReady?.();
          }
          yield event;
        }
      })();
      return primeAsyncIterable(readySource, "real_batch_stream");
    };
  }

  const originalRegisterIntent = provider.registerIntent?.bind(provider);
  if (originalRegisterIntent) {
    provider.registerIntent = async (intent) => {
      const started = Date.now();
      try {
        if (provider.__nuriStreamReadyPromise) {
          info("real_stream", "wait_before_register", {
            timeout: "120000ms",
            expected_next: "register_after_stream_started",
          });
          await withTimeout(
            120000,
            provider.__nuriStreamReadyPromise,
            "stream_ready_before_register",
          );
        }
        const id = await originalRegisterIntent(intent);
        api("registerIntent", "post", {
          status: "ok",
          dur: `${Date.now() - started}ms`,
          intent_id: truncateMiddle(id, 24),
        });
        return id;
      } catch (err) {
        api("registerIntent", "post", {
          status: "error",
          dur: `${Date.now() - started}ms`,
          err: truncateMiddle(err?.message || err, 80),
        });
        throw err;
      }
    };
  }

  const originalConfirmRegistration = provider.confirmRegistration?.bind(provider);
  if (originalConfirmRegistration) {
    provider.confirmRegistration = async (intentId) => {
      const started = Date.now();
      try {
        const value = await originalConfirmRegistration(intentId);
        api("batchAck", "post", {
          status: "ok",
          dur: `${Date.now() - started}ms`,
          intent_id: truncateMiddle(intentId, 24),
        });
        return value;
      } catch (err) {
        api("batchAck", "post", {
          status: "error",
          dur: `${Date.now() - started}ms`,
          intent_id: truncateMiddle(intentId, 24),
          err: truncateMiddle(err?.message || err, 80),
        });
        throw err;
      }
    };
  }
}

function patchBatchHandler(wallet) {
  if (!wallet || wallet.__nuriBatchHandlerPatched) return;
  wallet.__nuriBatchHandlerPatched = true;
  const originalCreateBatchHandler = wallet.createBatchHandler?.bind(wallet);
  if (!originalCreateBatchHandler) return;
  wallet.createBatchHandler = (intentId, inputs, expectedRecipients, session) => {
    const intentHash = hex.encode(sha256Bytes(new TextEncoder().encode(String(intentId))));
    info("real_batch", "handler_created", {
      intent_id: truncateMiddle(intentId, 24),
      intent_hash: truncateMiddle(intentHash, 24),
      inputs: Array.isArray(inputs) ? inputs.length : 0,
      recipients: Array.isArray(expectedRecipients) ? expectedRecipients.length : 0,
      session: session ? 1 : 0,
    });
    const handler = originalCreateBatchHandler(intentId, inputs, expectedRecipients, session);
    const originalOnBatchStarted = handler.onBatchStarted?.bind(handler);
    if (originalOnBatchStarted) {
      handler.onBatchStarted = async (event) => {
        const hashes = Array.isArray(event?.intentIdHashes) ? event.intentIdHashes : [];
        const match = hashes.includes(intentHash);
        info("real_batch", "batch_started_match", {
          batch: truncateMiddle(event?.id || "", 24),
          intent_hash: truncateMiddle(intentHash, 24),
          hashes: hashes.length,
          match: match ? 1 : 0,
        });
        const result = await originalOnBatchStarted(event);
        info("real_batch", "batch_started_decision", {
          batch: truncateMiddle(event?.id || "", 24),
          skip: result?.skip ? 1 : 0,
          expected_next: result?.skip ? "wait_for_matching_batch" : "tree_signing_started",
        });
        return result;
      };
    }
    return handler;
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
  };
}

function assertOnchainAddress(address, network, field) {
  try {
    btc.Address(network).decode(address);
  } catch {
    throw new Error(`${field}_invalid`);
  }
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

function vtxoTxid(vtxo) {
  return String(vtxo?.txid || vtxo?.outpoint?.txid || "");
}

function vtxoVout(vtxo) {
  return Math.max(0, Math.trunc(Number(vtxo?.vout ?? vtxo?.outpoint?.vout ?? 0)));
}

async function pollVtxos(wallet, timeoutMs) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    info("real_indexer", "poll_vtxos", {
      attempt,
      vtxos: vtxos.length,
      elapsed: `${Date.now() - started}ms`,
    });
    if (vtxos.length > 0) return vtxos;
    await sleep(Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 20))));
  }
  throw new Error(`vtxo_poll_timeout_after_${timeoutMs}ms`);
}

async function pollBoardingConfirmed(wallet, minSats, timeoutMs) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const [balance, boardingUtxos] = await Promise.all([
      wallet.getBalance(),
      wallet.getBoardingUtxos(),
    ]);
    const confirmed = Number(balance?.boarding?.confirmed || 0);
    info("strict_funding", "poll_boarding", {
      attempt,
      confirmed_sats: confirmed,
      utxos: boardingUtxos.length,
      required_sats: minSats,
      elapsed: `${Date.now() - started}ms`,
    });
    if (confirmed >= minSats && boardingUtxos.length > 0) return boardingUtxos;
    await sleep(Math.min(10000, Math.max(2000, Math.floor(timeoutMs / 20))));
  }
  throw new Error(`boarding_confirmation_timeout_after_${timeoutMs}ms`);
}

async function pollUnrolledVtxo(wallet, txid, timeoutMs) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    const match = vtxos.find((vtxo) => vtxoTxid(vtxo) === txid && vtxo?.isUnrolled);
    info("real_indexer", "poll_unrolled", {
      attempt,
      txid: truncateMiddle(txid, 24),
      found: match ? 1 : 0,
      elapsed: `${Date.now() - started}ms`,
    });
    if (match) return match;
    await sleep(Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 20))));
  }
  throw new Error(`unrolled_vtxo_timeout_after_${timeoutMs}ms`);
}

async function waitForCsvReady(wallet, txid, csvBlocks, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [status, tip] = await Promise.all([
      wallet.onchainProvider.getTxStatus(txid).catch(() => null),
      wallet.onchainProvider.getChainTip(),
    ]);
    const confirmedHeight = Number(status?.blockHeight || 0);
    const tipHeight = Number(tip?.height || 0);
    const remaining = Math.max(0, confirmedHeight + csvBlocks - tipHeight);
    info("real_csv", "wait", {
      txid: truncateMiddle(txid, 24),
      confirmed: status?.confirmed ? 1 : 0,
      confirmed_height: confirmedHeight || "n/a",
      tip: tipHeight || "n/a",
      csv_blocks: csvBlocks,
      remaining,
    });
    if (status?.confirmed && remaining <= 0) return;
    await sleep(10000);
  }
  throw new Error(`csv_wait_timeout_after_${timeoutMs}ms`);
}

async function broadcastUnrollPackage(clientAnchorWallet, tx) {
  const [parentHex, childHex] = await clientAnchorWallet.bumpP2A(tx);
  const parentBytes = hex.decode(parentHex);
  const childBytes = hex.decode(childHex);
  const parentTx = decodeRawTransaction(parentHex);
  const childTx = decodeRawTransaction(childHex);
  info("real_unroll", "package_built", {
    parent_txid: truncateMiddle(parentTx.id, 24),
    child_txid: truncateMiddle(childTx.id, 24),
    parent_bitcoin_tx_version: txVersion(parentTx),
    child_bitcoin_tx_version: txVersion(childTx),
    parent_bytes: parentBytes.length,
    child_bytes: childBytes.length,
    parent_matches_step: parentTx.id === tx.id ? 1 : 0,
  });

  let response = null;
  try {
    response = await clientAnchorWallet.provider.broadcastTransaction(parentHex, childHex);
    info("real_unroll", "package_broadcast", {
      status: "ok",
      parent_txid: truncateMiddle(parentTx.id, 24),
      child_txid: truncateMiddle(childTx.id, 24),
      parent_bitcoin_tx_version: txVersion(parentTx),
      child_bitcoin_tx_version: txVersion(childTx),
      response: JSON.stringify(response).slice(0, 1200),
    });
  } catch (error) {
    response = { error: errorText(error, 1800) };
    warn("real_unroll", "package_broadcast", {
      status: "failed",
      parent_txid: truncateMiddle(parentTx.id, 24),
      child_txid: truncateMiddle(childTx.id, 24),
      parent_bitcoin_tx_version: txVersion(parentTx),
      child_bitcoin_tx_version: txVersion(childTx),
      error: response.error,
    });
  }

  await sleep(2000);
  const [parentStatus, childStatus] = await Promise.all([
    txVisibility(clientAnchorWallet.provider, parentTx.id),
    txVisibility(clientAnchorWallet.provider, childTx.id),
  ]);
  info("real_unroll", "package_visibility", {
    parent_txid: truncateMiddle(parentTx.id, 24),
    parent: parentStatus,
    child_txid: truncateMiddle(childTx.id, 24),
    child: childStatus,
  });
  if (!parentStatus.startsWith("mempool") && !parentStatus.startsWith("confirmed")) {
    throw new Error(`unroll_parent_not_visible:${parentStatus}`);
  }
  if (!childStatus.startsWith("mempool") && !childStatus.startsWith("confirmed")) {
    throw new Error(`unroll_child_not_visible:${childStatus}`);
  }
  return { parentTxid: parentTx.id, childTxid: childTx.id, response };
}

async function runUnrollToL1(wallet, clientAnchorWallet, candidate, timeoutMs) {
  const txid = vtxoTxid(candidate);
  const vout = vtxoVout(candidate);
  const anchorBalance = await clientAnchorWallet.getBalance().catch(() => 0);
  info("real_unroll", "anchor_balance", {
    address: clientAnchorWallet.address,
    sats: Number(anchorBalance || 0),
  });
  if (Number(anchorBalance || 0) <= 0) {
    warn("real_unroll", "anchor_funding_required", {
      address: clientAnchorWallet.address,
      instruction: "send_onchain_bitcoin_for_p2a_fee_then_rerun",
    });
    return null;
  }

  const session = await Unroll.Session.create(
    { txid, vout },
    clientAnchorWallet,
    clientAnchorWallet.provider,
    wallet.indexerProvider,
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const step = await withTimeout(Math.min(timeoutMs, 120000), session.next(), "unroll_next");
    const stepName =
      step.type === Unroll.StepType.UNROLL
        ? "unroll"
        : step.type === Unroll.StepType.WAIT
          ? "wait"
          : "done";
    info("real_unroll", "step", {
      step: stepName,
      txid: truncateMiddle(step?.tx?.id || step?.txid || step?.vtxoTxid || txid, 24),
    });
    if (step.type === Unroll.StepType.UNROLL) {
      await withTimeout(
        Math.min(timeoutMs, 120000),
        broadcastUnrollPackage(clientAnchorWallet, step.tx),
        "unroll_broadcast",
      );
      return pollUnrolledVtxo(wallet, txid, timeoutMs);
    }
    if (step.type === Unroll.StepType.WAIT) {
      await withTimeout(Math.min(timeoutMs, 120000), step.do(), "unroll_wait");
      continue;
    }
    return pollUnrolledVtxo(wallet, txid, timeoutMs);
  }
  throw new Error(`unroll_timeout_after_${timeoutMs}ms`);
}

async function fundBoardingFromCoordinator(
  args,
  wallet,
  clientAnchorWallet,
  boardingAddress,
  proof,
) {
  const coins = await clientAnchorWallet.getCoins();
  const confirmedSats = coins
    .filter((coin) => coin?.status?.confirmed)
    .reduce((sum, coin) => sum + Number(coin.value || 0), 0);
  const totalSats = coins.reduce((sum, coin) => sum + Number(coin.value || 0), 0);
  const minimumBeforeFee = args.boardingSats + args.anchorReserveSats;
  proof.funding.fundingAddress = clientAnchorWallet.address;
  proof.funding.coordinatorConfirmedSats = confirmedSats;
  proof.funding.coordinatorTotalSats = totalSats;
  proof.funding.boardingAddress = boardingAddress;

  if (confirmedSats < minimumBeforeFee) {
    warn("strict_funding", "one_address_funding_required", {
      funding_address: clientAnchorWallet.address,
      return_address: args.returnAddress,
      confirmed_sats: confirmedSats,
      total_sats: totalSats,
      minimum_before_fee_sats: minimumBeforeFee,
      instruction: "fund_one_address_then_rerun_same_command",
    });
    proof.verdict = "funding_required";
    proof.completedAt = new Date().toISOString();
    return null;
  }

  const rawFeeRate = Number(await clientAnchorWallet.provider.getFeeRate());
  const feeRate = Math.max(
    OnchainWallet.MIN_FEE_RATE || 1,
    Number.isFinite(rawFeeRate) ? Math.ceil(rawFeeRate) : 1,
  );
  let estimate;
  try {
    estimate = clientAnchorWallet.estimateFeesAndSelectCoins(
      coins.filter((coin) => coin?.status?.confirmed),
      args.boardingSats,
      feeRate,
      boardingAddress,
    );
  } catch (error) {
    warn("strict_funding", "fanout_fee_estimate_failed", {
      funding_address: clientAnchorWallet.address,
      confirmed_sats: confirmedSats,
      error: errorText(error),
    });
    proof.verdict = "funding_required";
    proof.completedAt = new Date().toISOString();
    return null;
  }
  const estimatedChangeSats = Number(estimate.changeAmount || 0n);
  proof.funding.estimatedFanoutFeeSats = Number(estimate.fee || 0);
  proof.funding.estimatedCoordinatorChangeSats = estimatedChangeSats;
  if (estimatedChangeSats < args.anchorReserveSats) {
    warn("strict_funding", "one_address_more_funding_required", {
      funding_address: clientAnchorWallet.address,
      return_address: args.returnAddress,
      confirmed_sats: confirmedSats,
      estimated_fee_sats: Number(estimate.fee || 0),
      estimated_change_sats: estimatedChangeSats,
      reserve_required_sats: args.anchorReserveSats,
      instruction: "add_sats_to_same_funding_address_then_rerun",
    });
    proof.verdict = "funding_required";
    proof.completedAt = new Date().toISOString();
    return null;
  }

  info("strict_funding", "fanout_attempt", {
    from: clientAnchorWallet.address,
    to: boardingAddress,
    amount_sats: args.boardingSats,
    confirmed_sats: confirmedSats,
    reserve_sats: args.anchorReserveSats,
    estimated_fee_sats: Number(estimate.fee || 0),
  });
  const fanoutTxid = await withTimeout(
    args.timeoutMs,
    clientAnchorWallet.send({
      address: boardingAddress,
      amount: args.boardingSats,
    }),
    "strict_funding_fanout",
  );
  proof.funding.fanoutTxid = fanoutTxid;
  info("strict_funding", "fanout_broadcast", {
    txid: truncateMiddle(fanoutTxid, 32),
    amount_sats: args.boardingSats,
    expected_next: "boarding_confirmation",
  });
  return pollBoardingConfirmed(wallet, args.boardingSats, args.timeoutMs);
}

async function completeClientCsvSpend(
  wallet,
  clientIdentity,
  clientAddress,
  txid,
  csvBlocks,
  timeoutMs,
) {
  await waitForCsvReady(wallet, txid, csvBlocks, timeoutMs);
  const originalIdentity = wallet.identity;
  try {
    wallet.identity = clientIdentity;
    info("real_spend", "client_only_attempt", {
      txid: truncateMiddle(txid, 24),
      destination: clientAddress,
      server: "not_used",
    });
    const signedTx = await buildClientCsvSpendTransaction(wallet, [txid], clientAddress);
    const spendTxid = signedTx.id;
    try {
      await withTimeout(
        timeoutMs,
        wallet.onchainProvider.broadcastTransaction(signedTx.hex),
        "client_csv_spend",
      );
    } catch (error) {
      if (!isAlreadyBroadcastTransactionError(error)) throw error;
      const visibility = await txVisibility(wallet.onchainProvider, spendTxid);
      if (!visibility.startsWith("mempool") && !visibility.startsWith("confirmed")) {
        throw error;
      }
      info("real_spend", "client_only_resume", {
        txid: truncateMiddle(spendTxid, 32),
        visibility,
        signer: "client_only",
        server: "not_used",
      });
    }
    info("real_spend", "client_only_broadcast", {
      txid: truncateMiddle(spendTxid, 32),
      signer: "client_only",
      server: "not_used",
    });
    return spendTxid;
  } finally {
    wallet.identity = originalIdentity;
  }
}

async function buildClientCsvSpendTransaction(wallet, vtxoTxids, outputAddress) {
  const vtxos = (await wallet.getVtxos({ withUnrolled: true })).filter((vtxo) =>
    vtxoTxids.includes(vtxo.txid),
  );
  if (vtxos.length === 0) {
    throw new Error("No vtxos to complete unroll");
  }

  const inputs = [];
  let totalAmount = 0n;
  const txWeightEstimator = TxWeightEstimator.create();
  for (const vtxo of vtxos) {
    if (!vtxo.isUnrolled) {
      throw new Error(`Vtxo ${vtxo.txid}:${vtxo.vout} is not fully unrolled`);
    }
    const decoded = VtxoScript.decode(vtxo.tapTree);
    const exit = decoded.exitPaths()[0];
    if (!exit) {
      throw new Error(`no available exit path found for vtxo ${vtxo.txid}:${vtxo.vout}`);
    }
    const spendingLeaf = decoded.findLeaf(hex.encode(exit.script));
    totalAmount += BigInt(vtxo.value);
    inputs.push({
      txid: vtxo.txid,
      index: vtxo.vout,
      tapLeafScript: [spendingLeaf],
      sequence: timelockToSequence(exit.params.timelock),
      witnessUtxo: {
        amount: BigInt(vtxo.value),
        script: decoded.pkScript,
      },
      sighashType: btc.SigHash.DEFAULT,
    });
    txWeightEstimator.addTapscriptInput(
      64,
      spendingLeaf[1].length,
      btc.TaprootControlBlock.encode(spendingLeaf[0]).length,
    );
  }

  const tx = new Transaction({ version: 2 });
  for (const input of inputs) {
    tx.addInput(input);
  }
  txWeightEstimator.addOutputAddress(outputAddress, wallet.network);
  let feeRate = await wallet.onchainProvider.getFeeRate();
  if (!feeRate || feeRate < Wallet.MIN_FEE_RATE) {
    feeRate = Wallet.MIN_FEE_RATE;
  }
  const feeAmount = txWeightEstimator.vsize().fee(BigInt(feeRate));
  if (feeAmount > totalAmount) {
    throw new Error("fee amount is greater than the total amount");
  }
  const sendAmount = totalAmount - feeAmount;
  if (sendAmount < BigInt(BITCOIN_DUST_SATS)) {
    throw new Error("send amount is less than dust amount");
  }
  tx.addOutputAddress(outputAddress, sendAmount);
  const signedTx = await wallet.identity.sign(tx);
  signedTx.finalize();
  return signedTx;
}

async function returnCoordinatorRemainder(args, clientAnchorWallet, proof) {
  if (!(args.strictLive || args.returnOnly) || !args.returnAddress) return null;
  const coins = await clientAnchorWallet.getCoins();
  const totalSats = coins.reduce((sum, coin) => sum + Number(coin.value || 0), 0);
  if (totalSats <= BITCOIN_DUST_SATS) {
    info("strict_return", "coordinator_remainder_skipped", {
      sats: totalSats,
      reason: "below_dust_or_empty",
    });
    proof.funding.returnRemainder = { skipped: true, sats: totalSats };
    return null;
  }

  const rawFeeRate = Number(await clientAnchorWallet.provider.getFeeRate());
  const feeRate = Math.max(
    OnchainWallet.MIN_FEE_RATE || 1,
    Number.isFinite(rawFeeRate) ? Math.ceil(rawFeeRate) : 1,
  );
  let amount = 0;
  let selectedFee = 0;
  for (let candidate = totalSats; candidate >= BITCOIN_DUST_SATS; candidate -= 1) {
    try {
      const estimate = clientAnchorWallet.estimateFeesAndSelectCoins(
        coins,
        candidate,
        feeRate,
        args.returnAddress,
      );
      const selectedSats = estimate.inputs.reduce((sum, coin) => sum + Number(coin.value || 0), 0);
      const fee = Number(estimate.fee || 0);
      if (selectedSats >= candidate + fee) {
        amount = candidate;
        selectedFee = fee;
        break;
      }
    } catch {}
  }
  if (amount < BITCOIN_DUST_SATS) {
    info("strict_return", "coordinator_remainder_skipped", {
      sats: totalSats,
      reason: "remainder_below_dust_after_fee",
    });
    proof.funding.returnRemainder = { skipped: true, sats: totalSats };
    return null;
  }

  info("strict_return", "coordinator_remainder_attempt", {
    from: clientAnchorWallet.address,
    to: args.returnAddress,
    amount_sats: amount,
    total_sats: totalSats,
    estimated_fee_sats: selectedFee,
    fee_rate: feeRate,
  });
  const txid = await withTimeout(
    args.timeoutMs,
    clientAnchorWallet.send({
      address: args.returnAddress,
      amount,
      feeRate,
    }),
    "strict_return_remainder",
  );
  proof.funding.returnRemainder = { txid, amountSats: amount };
  info("strict_return", "coordinator_remainder_broadcast", {
    txid: truncateMiddle(txid, 32),
    amount_sats: amount,
    destination: args.returnAddress,
  });
  return txid;
}

async function createRealWallet(args, state) {
  if (!globalThis.EventSource) {
    globalThis.EventSource = EventSource;
  }
  const identity = new LocalAggregateIdentity(state.clientKeyHex, state.nuriServerKeyHex);
  const clientIdentity = SingleKey.fromHex(state.clientKeyHex);
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: args.nodeUrl,
    esploraUrl: args.esploraUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });
  forceIntegerFeeRate(wallet.onchainProvider, "wallet_onchain_provider");
  patchArkProvider(wallet.arkProvider);
  patchBatchHandler(wallet);
  const contract = await installClientRecoveryWallet(wallet, clientIdentity, args.csvBlocks);
  return { wallet, clientIdentity, contract, aggregateIdentity: identity };
}

async function runReal(args) {
  const proofSummary = createStrictLiveProof(args);
  info("main", "real_start", {
    node: args.nodeUrl,
    esplora: args.esploraUrl,
    state: args.statePath,
    strict_live_profile: args.strictLive ? STRICT_LIVE_PROFILE : "off",
  });
  const state = await loadOrCreateState(args.statePath);
  const { wallet, clientIdentity, contract, aggregateIdentity } = await createRealWallet(
    args,
    state,
  );
  try {
    if (args.returnAddress) {
      assertOnchainAddress(args.returnAddress, wallet.network, "return_address");
    }
    const arkAddress = await wallet.getAddress();
    const boardingAddress = await wallet.getBoardingAddress();
    const clientAnchorWallet = await OnchainWallet.create(
      clientIdentity,
      wallet.networkName,
      wallet.onchainProvider,
    );
    await guardFixedAddress(args.statePath, state, "expectedArkAddress", arkAddress, "ark");
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
      "expectedClientAnchorAddress",
      clientAnchorWallet.address,
      "client_anchor",
    );
    proofSummary.versions.bitcoinNetwork = wallet.networkName;
    proofSummary.addresses = {
      ark: arkAddress,
      boarding: boardingAddress,
      fundingCoordinator: clientAnchorWallet.address,
      anchor: clientAnchorWallet.address,
      returnAddress: args.returnAddress || "",
    };
    info("strict_versions", "matrix", {
      profile: args.strictLive ? STRICT_LIVE_PROFILE : "real-live",
      ...versionMatrixFields({
        arkadeCsv: contract?.csvBlocks ? `${contract.csvBlocks}_blocks` : undefined,
        nuriCsv: NURI_SERVER_CSV_POLICY,
        bitcoinTxVersion: "decoded_live_transactions",
      }),
      bitcoin_network: wallet.networkName,
      bitcoin_tx_version_source: "decoded_live_transactions",
      fallback_policy: args.strictLive ? "fail" : "warn",
    });
    const balance = await wallet.getBalance();
    const anchorBalance = await clientAnchorWallet.getBalance().catch(() => 0);
    proofSummary.balances.wallet = summarizeBalance(balance);
    proofSummary.balances.fundingCoordinatorSats = Number(anchorBalance || 0);
    info("fixed_account", "proof", {
      client_pk: truncateMiddle(hex.encode(aggregateIdentity.clientPk33), 18),
      nuri_server_pk: truncateMiddle(hex.encode(aggregateIdentity.nuriServerPk33), 18),
      aggregate_pk: truncateMiddle(hex.encode(aggregateIdentity.aggregatedPk33), 18),
      csv_blocks: contract.csvBlocks,
    });
    info("real_wallet", "addresses_ready", {
      ark: truncateMiddle(arkAddress, 36),
      boarding: boardingAddress,
      client_anchor: clientAnchorWallet.address,
      state: args.statePath,
    });
    info("real_wallet", "balance", summarizeBalance(balance));
    info("real_wallet", "anchor_balance", {
      address: clientAnchorWallet.address,
      sats: Number(anchorBalance || 0),
    });

    let vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
    if (vtxos.length === 0) {
      let boardingUtxos = await wallet.getBoardingUtxos();
      info("real_wallet", "boarding_utxos", {
        count: boardingUtxos.length,
        sats: boardingUtxos.reduce((sum, utxo) => sum + Number(utxo.value || 0), 0),
      });
      if (boardingUtxos.length === 0 && args.oneFundingAddress) {
        const fundedBoardingUtxos = await fundBoardingFromCoordinator(
          args,
          wallet,
          clientAnchorWallet,
          boardingAddress,
          proofSummary,
        );
        if (!fundedBoardingUtxos) return;
        boardingUtxos = fundedBoardingUtxos;
      }
      if (boardingUtxos.length === 0) {
        warn("real_wallet", "funding_required", {
          boarding_address: boardingAddress,
          anchor_address: clientAnchorWallet.address,
          instruction: "fund_boarding_and_anchor_then_rerun_same_command",
          state: args.statePath,
        });
        proofSummary.verdict = "funding_required";
        proofSummary.completedAt = new Date().toISOString();
        return;
      }

      const infoResponse = await wallet.arkProvider.getInfo();
      info("real_onboard", "attempt", {
        boarding_utxos: boardingUtxos.length,
        timeout: `${args.timeoutMs}ms`,
      });
      const ramps = new Ramps(wallet);
      const arkTxid = await withTimeout(
        args.timeoutMs,
        ramps.onboard(infoResponse.fees, boardingUtxos, undefined, (event) => {
          info("real_batch", "event", {
            type: event?.type || "unknown",
            id: truncateMiddle(event?.id || event?.txid || "", 24),
          });
        }),
        "real_onboard",
      );
      info("real_onboard", "complete", { ark_txid: truncateMiddle(arkTxid, 32) });
      proofSummary.onboarding = {
        arkTxid,
        boardingUtxos: boardingUtxos.length,
        boardingSats: boardingUtxos.reduce((sum, utxo) => sum + Number(utxo.value || 0), 0),
      };
      vtxos = await pollVtxos(wallet, args.timeoutMs);
    }

    const candidate = vtxos.find((vtxo) => vtxo?.tapTree) || vtxos[0];
    assert(candidate?.tapTree, "real vtxo missing tapTree");
    const proof = verifyClientRecoveryTapTree({
      tapTree: candidate.tapTree,
      cooperativePubKey: contract.cooperativePubKey,
      clientPubKey: contract.clientPubKey,
      serverPubKey: contract.serverPubKey,
      csvBlocks: contract.csvBlocks,
      network: wallet.network,
    });
    info("real_proof", "client_recovery_vtxo_verified", {
      verdict: proof.verdict,
      vtxos: vtxos.length,
      txid: truncateMiddle(vtxoTxid(candidate), 24),
      vout: vtxoVout(candidate),
      l1_exit: truncateMiddle(proof.l1ExitAddress, 36),
      script: truncateMiddle(proof.scriptPubKey, 28),
      client_csv_leaf: "pass",
      forfeit_leaf: "pass",
      old_format: "absent",
    });
    proofSummary.proof = {
      verdict: proof.verdict,
      vtxoTxid: vtxoTxid(candidate),
      vout: vtxoVout(candidate),
      l1ExitAddress: proof.l1ExitAddress,
      scriptPubKey: proof.scriptPubKey,
      clientCsvLeaf: "pass",
      forfeitLeaf: "pass",
      oldFormat: "absent",
    };
    if (args.strictLive && candidate?.isUnrolled) {
      const existingUnrollStatus = await txVisibility(wallet.onchainProvider, vtxoTxid(candidate));
      if (
        !existingUnrollStatus.startsWith("mempool") &&
        !existingUnrollStatus.startsWith("confirmed")
      ) {
        throw new Error(`strict_live_unroll_not_visible:${existingUnrollStatus}`);
      }
      info("strict_resume", "existing_unroll_verified", {
        txid: truncateMiddle(vtxoTxid(candidate), 24),
        status: existingUnrollStatus,
        reason: "resume_after_command_restart",
      });
    }
    const unrolled = candidate?.isUnrolled
      ? candidate
      : await runUnrollToL1(wallet, clientAnchorWallet, candidate, args.timeoutMs);
    if (!unrolled) {
      if (args.strictLive) throw new Error("strict_live_unroll_not_completed");
      return;
    }
    const exitTxid = vtxoTxid(unrolled) || vtxoTxid(candidate);
    proofSummary.unroll = {
      txid: exitTxid,
      reusedExisting: candidate?.isUnrolled ? 1 : 0,
    };
    const spendTxid = await completeClientCsvSpend(
      wallet,
      clientIdentity,
      args.returnAddress || clientAnchorWallet.address,
      exitTxid,
      contract.csvBlocks,
      args.timeoutMs,
    );
    proofSummary.spend = {
      txid: spendTxid,
      destination: args.returnAddress || clientAnchorWallet.address,
      signer: "client_only",
    };
    const returnRemainderTxid = await returnCoordinatorRemainder(
      args,
      clientAnchorWallet,
      proofSummary,
    );
    proofSummary.verdict = "pass";
    proofSummary.completedAt = new Date().toISOString();
    info("main", "final", {
      mode: args.mode,
      verdict: "pass",
      contract: CONTRACT_TYPE,
      l1_exit: truncateMiddle(proof.l1ExitAddress, 36),
      one_key_csv: "pass",
      unroll_txid: truncateMiddle(exitTxid, 24),
      spend_txid: truncateMiddle(spendTxid, 24),
      return_remainder_txid: truncateMiddle(returnRemainderTxid || "", 24),
    });
  } catch (error) {
    proofSummary.verdict = "fail";
    proofSummary.completedAt = new Date().toISOString();
    proofSummary.error = {
      message: errorText(error, 1800),
    };
    throw error;
  } finally {
    await wallet.dispose?.();
    info("real_wallet", "disposed", { status: "ok" });
    await saveProofArtifact(args.artifactPath, proofSummary);
  }
}

async function runReturnRemainder(args) {
  const proofSummary = createStrictLiveProof(args);
  info("main", "return_remainder_start", {
    node: args.nodeUrl,
    esplora: args.esploraUrl,
    state: args.statePath,
    return_address: args.returnAddress,
  });
  const state = await loadOrCreateState(args.statePath);
  const { wallet, clientIdentity } = await createRealWallet(args, state);
  try {
    assertOnchainAddress(args.returnAddress, wallet.network, "return_address");
    const clientAnchorWallet = await OnchainWallet.create(
      clientIdentity,
      wallet.networkName,
      wallet.onchainProvider,
    );
    proofSummary.versions.bitcoinNetwork = wallet.networkName;
    proofSummary.addresses = {
      fundingCoordinator: clientAnchorWallet.address,
      anchor: clientAnchorWallet.address,
      returnAddress: args.returnAddress,
    };
    const txid = await returnCoordinatorRemainder(args, clientAnchorWallet, proofSummary);
    proofSummary.verdict = txid ? "pass" : "skipped";
    proofSummary.completedAt = new Date().toISOString();
    info("main", "return_remainder_final", {
      verdict: proofSummary.verdict,
      txid: truncateMiddle(txid || "", 24),
    });
  } catch (error) {
    proofSummary.verdict = "fail";
    proofSummary.completedAt = new Date().toISOString();
    proofSummary.error = {
      message: errorText(error, 1800),
    };
    throw error;
  } finally {
    await wallet.dispose?.();
    info("real_wallet", "disposed", { status: "ok" });
    await saveProofArtifact(args.artifactPath, proofSummary);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.mode === "offline") await runOffline(args);
  else if (args.mode === "return-remainder") await runReturnRemainder(args);
  else await runReal(args);
}

main().catch((err) => {
  errorLog("main", "failed", {
    err: truncateMiddle(err?.stack || err?.message || err, 180),
  });
  process.exitCode = 1;
});
