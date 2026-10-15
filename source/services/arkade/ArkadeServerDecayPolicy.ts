import * as btc from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import {
  CSVMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { bytesToHex, taggedHash } from "../../lib/crypto";
import { assertBip68Timelock, bip68SequenceFromTimelock } from "../../lib/bitcoin/csv";

// The BIP68 math lives in lib/bitcoin/csv; kept exported under the original
// names so every existing importer keeps working.
export {
  bip68SequenceFromTimelock as arkadeTimelockToSequence,
  timelockFromBip68Sequence as sequenceToArkadeTimelock,
} from "../../lib/bitcoin/csv";

const REGTEST_NETWORK = { ...btc.TEST_NETWORK, bech32: "bcrt" } satisfies typeof btc.NETWORK;

export type ArkadeServerDecayProofNetwork = "main" | "testnet" | "regtest";

export type ArkadeServerDecayPolicyParams = {
  aggregatePubKey: Uint8Array;
  clientPubKey: Uint8Array;
  nuriServerPubKey: Uint8Array;
  arkadeServerPubKey: Uint8Array;
  arkadeCsvTimelock: RelativeTimelock;
  nuriServerCsvTimelock: RelativeTimelock;
};

export type ArkadeServerDecayClientRecoveryData = {
  tapLeafScript: unknown;
  userXOnly: Uint8Array;
  csvSequence: number;
  tapInternalKey: Uint8Array;
  tapMerkleRoot?: Uint8Array;
  tweakedPubkey: Uint8Array;
};

export type ArkadeServerDecayClientRecoveryProof = {
  address: string;
  csvSequence: number;
  csvTimelock: RelativeTimelock;
  network: ArkadeServerDecayProofNetwork;
  scriptPubKeyHex: string;
  userXOnlyHex: string;
  tapInternalKeyHex: string;
  tweakedPubkeyHex: string;
  tapMerkleRootHex: string;
  recoveryData: ArkadeServerDecayClientRecoveryData;
};

export type ArkadeServerDecayPolicyVerification = {
  pass: boolean;
  failures: string[];
  contractMode: string;
  address: string;
  scriptPubKeyHex: string;
  aggregateRecoveryCsvSequence: string;
  clientRecoveryCsvSequence: string;
  arkadeCsvLabel: string;
  nuriServerCsvLabel: string;
  clientRecoveryCsvLabel: string;
  arkadePathMatch: boolean;
  aggregateRecoveryPathMatch: boolean;
  clientRecoveryPathMatch: boolean;
  unsafeClientOnlyBeforeNuriServerCsv: boolean;
  directNuriServerKeyInLeaf: boolean;
  clientProof: ArkadeServerDecayClientRecoveryProof | null;
  detail: string;
};

type DecodedLeaf = {
  script: Uint8Array;
  leaf: unknown;
};

function assertXOnlyPubkey(pubkey: Uint8Array, field: string): void {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) {
    throw new Error(`${field} must be 32 bytes`);
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function includesKey(pubkeys: Uint8Array[], expected: Uint8Array): boolean {
  return pubkeys.some((pubkey) => sameBytes(pubkey, expected));
}

function decodedLeafPubkeys(leaf: unknown): Uint8Array[] {
  const pubkeys = (leaf as { params?: { pubkeys?: unknown } } | null)?.params?.pubkeys;
  if (!Array.isArray(pubkeys)) return [];
  return pubkeys.filter((pubkey: unknown): pubkey is Uint8Array => pubkey instanceof Uint8Array);
}

export function formatArkadeTimelock(timelock: RelativeTimelock | null | undefined): string {
  if (!timelock) return "n/a";
  const value = typeof timelock.value === "bigint" ? timelock.value : BigInt(timelock.value);
  return `${value.toString()}_${timelock.type}`;
}

export function addArkadeTimelocks(
  left: RelativeTimelock,
  right: RelativeTimelock,
): RelativeTimelock {
  assertBip68Timelock(left, "leftTimelock");
  assertBip68Timelock(right, "rightTimelock");
  if (left.type !== right.type) {
    throw new Error(`timelock units must match left=${left.type} right=${right.type}`);
  }
  return {
    type: left.type,
    value: BigInt(left.value) + BigInt(right.value),
  };
}

function sameTimelock(left: RelativeTimelock | undefined, right: RelativeTimelock): boolean {
  if (!left) return false;
  return left.type === right.type && BigInt(left.value) === BigInt(right.value);
}

function greaterTimelock(left: RelativeTimelock, right: RelativeTimelock): boolean {
  return left.type === right.type && BigInt(left.value) > BigInt(right.value);
}

export function normalizeProofNetwork(network?: string | null): ArkadeServerDecayProofNetwork {
  if (network === "testnet") return "testnet";
  if (network === "regtest") return "regtest";
  return "main";
}

function networkToScure(network: ArkadeServerDecayProofNetwork): typeof btc.NETWORK {
  if (network === "testnet") return btc.TEST_NETWORK;
  if (network === "regtest") return REGTEST_NETWORK;
  return btc.NETWORK;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function tapBranchHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const ordered = compareBytes(left, right) <= 0 ? [left, right] : [right, left];
  const data = new Uint8Array(64);
  data.set(ordered[0], 0);
  data.set(ordered[1], 32);
  return taggedHash("TapBranch", data);
}

function bytesFromUnknown(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error(`${field} must be bytes`);
}

function tapTreeBytesFromUnknown(tapTree: unknown): Uint8Array {
  return bytesFromUnknown(tapTree, "tapTree");
}

function tapLeafInternalKey(entry: unknown): Uint8Array {
  if (!Array.isArray(entry) || !entry[0]) {
    throw new Error("tapLeafScript entry missing");
  }
  return bytesFromUnknown((entry[0] as { internalKey?: unknown }).internalKey, "tapInternalKey");
}

function tapMerkleRootFromLeafEntry(entry: unknown, script: Uint8Array): Uint8Array | undefined {
  if (!Array.isArray(entry) || !entry[0]) return undefined;
  const control = entry[0] as { version?: unknown; merklePath?: unknown };
  const version = Number(control.version);
  const leafVersion = Number.isFinite(version) ? version & 0xfe : 0xc0;
  let root = tapLeafHash(script, leafVersion);
  const merklePath = Array.isArray(control.merklePath) ? control.merklePath : [];
  for (const sibling of merklePath) {
    const siblingBytes = bytesFromUnknown(sibling, "tapMerklePath");
    if (siblingBytes.length !== 32) {
      throw new Error("tap merkle path sibling must be 32 bytes");
    }
    root = tapBranchHash(root, siblingBytes);
  }
  return root;
}

export function validateArkadeServerDecayPolicyParams(params: ArkadeServerDecayPolicyParams): void {
  assertXOnlyPubkey(params.aggregatePubKey, "aggregatePubKey");
  assertXOnlyPubkey(params.clientPubKey, "clientPubKey");
  assertXOnlyPubkey(params.nuriServerPubKey, "nuriServerPubKey");
  assertXOnlyPubkey(params.arkadeServerPubKey, "arkadeServerPubKey");
  assertBip68Timelock(params.arkadeCsvTimelock, "arkadeCsvTimelock");
  assertBip68Timelock(params.nuriServerCsvTimelock, "nuriServerCsvTimelock");
  addArkadeTimelocks(params.arkadeCsvTimelock, params.nuriServerCsvTimelock);
}

export function clientRecoveryCsvTimelock(params: ArkadeServerDecayPolicyParams): RelativeTimelock {
  validateArkadeServerDecayPolicyParams(params);
  return addArkadeTimelocks(params.arkadeCsvTimelock, params.nuriServerCsvTimelock);
}

export function buildArkadeServerDecayLeaves(params: ArkadeServerDecayPolicyParams): {
  arkadePathScript: Uint8Array;
  aggregateRecoveryScript: Uint8Array;
  clientRecoveryScript: Uint8Array;
  clientRecoveryTimelock: RelativeTimelock;
} {
  validateArkadeServerDecayPolicyParams(params);
  const clientTimelock = clientRecoveryCsvTimelock(params);
  return {
    arkadePathScript: MultisigTapscript.encode({
      pubkeys: [params.aggregatePubKey, params.arkadeServerPubKey],
    }).script,
    aggregateRecoveryScript: CSVMultisigTapscript.encode({
      timelock: params.arkadeCsvTimelock,
      pubkeys: [params.aggregatePubKey],
    }).script,
    clientRecoveryScript: CSVMultisigTapscript.encode({
      timelock: clientTimelock,
      pubkeys: [params.clientPubKey],
    }).script,
    clientRecoveryTimelock: clientTimelock,
  };
}

export function buildArkadeServerDecayVtxoScript(
  params: ArkadeServerDecayPolicyParams,
): VtxoScript {
  const leaves = buildArkadeServerDecayLeaves(params);
  return new VtxoScript([
    leaves.arkadePathScript,
    leaves.aggregateRecoveryScript,
    leaves.clientRecoveryScript,
  ]);
}

export function buildArkadeServerDecayClientProof(
  params: ArkadeServerDecayPolicyParams & { network?: string | null },
): ArkadeServerDecayClientRecoveryProof {
  const leaves = buildArkadeServerDecayLeaves(params);
  const proofNetwork = normalizeProofNetwork(params.network);
  // Build the expected VTXO through the same SDK construction as the real
  // contract. VtxoScript uses the unspendable internal key and the SDK tree;
  // reconstructing it with the aggregate as a scure P2TR internal key produced
  // a different output and made every verification fail (#1624).
  const script = buildArkadeServerDecayVtxoScript(params);
  const address = script.onchainAddress(networkToScure(proofNetwork));
  if (!address) throw new Error("failed to create arkade server-decay address");

  const selectedTapLeaf = script.findLeaf(bytesToHex(leaves.clientRecoveryScript));
  if (!selectedTapLeaf) throw new Error("failed to locate client server-decay tap leaf");

  const tweakedPubkey = script.tweakedPublicKey;
  if (!(tweakedPubkey instanceof Uint8Array) || tweakedPubkey.length !== 32) {
    throw new Error("failed to derive server-decay tweaked pubkey");
  }
  const tapMerkleRoot = tapMerkleRootFromLeafEntry(selectedTapLeaf, leaves.clientRecoveryScript);
  if (!tapMerkleRoot) throw new Error("failed to derive server-decay tap merkle root");
  const csvSequence = bip68SequenceFromTimelock(leaves.clientRecoveryTimelock);
  const tapInternalKey = new Uint8Array(btc.TAPROOT_UNSPENDABLE_KEY);

  return {
    address,
    csvSequence,
    csvTimelock: leaves.clientRecoveryTimelock,
    network: proofNetwork,
    scriptPubKeyHex: bytesToHex(script.pkScript),
    userXOnlyHex: bytesToHex(params.clientPubKey),
    tapInternalKeyHex: bytesToHex(tapInternalKey),
    tweakedPubkeyHex: bytesToHex(tweakedPubkey),
    tapMerkleRootHex: bytesToHex(tapMerkleRoot),
    recoveryData: {
      tapLeafScript: [selectedTapLeaf],
      userXOnly: params.clientPubKey,
      csvSequence,
      tapInternalKey,
      tapMerkleRoot,
      tweakedPubkey,
    },
  };
}

function decodeVtxoLeaves(tapTree: unknown): {
  decoded: VtxoScript;
  csvLeaves: DecodedLeaf[];
  multisigLeaves: DecodedLeaf[];
  scripts: Uint8Array[];
} {
  const decoded = VtxoScript.decode(tapTreeBytesFromUnknown(tapTree));
  const scripts = Array.isArray(decoded.scripts)
    ? decoded.scripts.filter((script): script is Uint8Array => script instanceof Uint8Array)
    : [];
  const csvLeaves: DecodedLeaf[] = [];
  const multisigLeaves: DecodedLeaf[] = [];
  for (const script of scripts) {
    try {
      csvLeaves.push({ script, leaf: CSVMultisigTapscript.decode(script) });
      continue;
    } catch {}
    try {
      multisigLeaves.push({ script, leaf: MultisigTapscript.decode(script) });
    } catch {}
  }
  return { decoded, csvLeaves, multisigLeaves, scripts };
}

export function verifyArkadeServerDecayVtxoPolicy(args: {
  tapTree: unknown;
  params: ArkadeServerDecayPolicyParams;
  network: unknown;
  proofNetwork?: string | null;
}): ArkadeServerDecayPolicyVerification {
  validateArkadeServerDecayPolicyParams(args.params);
  const clientTimelock = clientRecoveryCsvTimelock(args.params);
  const expectedProof = buildArkadeServerDecayClientProof({
    ...args.params,
    network: args.proofNetwork,
  });
  const { decoded, csvLeaves, multisigLeaves, scripts } = decodeVtxoLeaves(args.tapTree);
  const address = String(decoded.onchainAddress(args.network as typeof btc.NETWORK) || "");
  const scriptPubKeyHex = bytesToHex(decoded.pkScript);

  const arkadeLeaves = multisigLeaves.filter(({ leaf }) => {
    const pubkeys = decodedLeafPubkeys(leaf);
    return (
      pubkeys.length === 2 &&
      sameBytes(pubkeys[0], args.params.aggregatePubKey) &&
      sameBytes(pubkeys[1], args.params.arkadeServerPubKey)
    );
  });
  const aggregateRecoveryLeaves = csvLeaves.filter(({ leaf }) => {
    const pubkeys = decodedLeafPubkeys(leaf);
    return (
      pubkeys.length === 1 &&
      sameBytes(pubkeys[0], args.params.aggregatePubKey) &&
      sameTimelock(
        (leaf as { params?: { timelock?: RelativeTimelock } }).params?.timelock,
        args.params.arkadeCsvTimelock,
      )
    );
  });
  const clientRecoveryLeaves = csvLeaves.filter(({ leaf }) => {
    const pubkeys = decodedLeafPubkeys(leaf);
    return (
      pubkeys.length === 1 &&
      sameBytes(pubkeys[0], args.params.clientPubKey) &&
      sameTimelock(
        (leaf as { params?: { timelock?: RelativeTimelock } }).params?.timelock,
        clientTimelock,
      )
    );
  });
  const unsafeClientLeaves = csvLeaves.filter(({ leaf }) => {
    const pubkeys = decodedLeafPubkeys(leaf);
    const timelock = (leaf as { params?: { timelock?: RelativeTimelock } }).params?.timelock;
    return (
      pubkeys.length === 1 &&
      sameBytes(pubkeys[0], args.params.clientPubKey) &&
      timelock &&
      !sameTimelock(timelock, clientTimelock)
    );
  });
  const directNuriServerLeaves = csvLeaves.filter(({ leaf }) =>
    includesKey(decodedLeafPubkeys(leaf), args.params.nuriServerPubKey),
  );
  const recoveryLeavesWithArkadeServer = csvLeaves.filter(({ leaf }) =>
    includesKey(decodedLeafPubkeys(leaf), args.params.arkadeServerPubKey),
  );
  const clientLeaf = clientRecoveryLeaves[0] || null;
  const actualLeaf = clientLeaf ? decoded.findLeaf(bytesToHex(clientLeaf.script)) : null;
  const actualTapMerkleRoot =
    actualLeaf && clientLeaf
      ? tapMerkleRootFromLeafEntry(actualLeaf, clientLeaf.script)
      : undefined;
  const actualTapMerkleRootHex = actualTapMerkleRoot ? bytesToHex(actualTapMerkleRoot) : "";
  const actualProof =
    actualLeaf &&
    actualTapMerkleRoot &&
    clientLeaf &&
    address &&
    scriptPubKeyHex &&
    scriptPubKeyHex === expectedProof.scriptPubKeyHex
      ? ({
          ...expectedProof,
          address,
          scriptPubKeyHex,
          tapMerkleRootHex: actualTapMerkleRootHex,
          recoveryData: {
            tapLeafScript: [actualLeaf],
            userXOnly: new Uint8Array(args.params.clientPubKey),
            csvSequence: expectedProof.csvSequence,
            tapInternalKey: tapLeafInternalKey(actualLeaf),
            tapMerkleRoot: actualTapMerkleRoot,
            tweakedPubkey: decoded.tweakedPublicKey,
          },
        } satisfies ArkadeServerDecayClientRecoveryProof)
      : null;
  const failures: string[] = [];
  if (scripts.length !== 3) failures.push(`leaf_count=${scripts.length}`);
  if (arkadeLeaves.length !== 1) failures.push(`arkade_leaf=${arkadeLeaves.length}`);
  if (aggregateRecoveryLeaves.length !== 1) {
    failures.push(`aggregate_recovery_leaf=${aggregateRecoveryLeaves.length}`);
  }
  if (clientRecoveryLeaves.length !== 1) {
    failures.push(`client_decay_leaf=${clientRecoveryLeaves.length}`);
  }
  if (unsafeClientLeaves.length > 0) failures.push("unsafe_client_leaf=1");
  if (directNuriServerLeaves.length > 0) failures.push("direct_nuri_server_key_in_leaf");
  if (recoveryLeavesWithArkadeServer.length > 0) failures.push("arkade_key_in_recovery_leaf");
  if (!greaterTimelock(clientTimelock, args.params.arkadeCsvTimelock)) {
    failures.push("client_only_csv_not_arkade_plus_nuri_server_csv");
  }
  if (scriptPubKeyHex !== expectedProof.scriptPubKeyHex) failures.push("script_pubkey_mismatch");
  if (!actualProof) failures.push("client_proof_missing");

  const aggregateCsv = aggregateRecoveryLeaves[0]?.leaf as
    | { params?: { timelock?: RelativeTimelock } }
    | undefined;
  const clientCsv = clientRecoveryLeaves[0]?.leaf as
    | { params?: { timelock?: RelativeTimelock } }
    | undefined;
  const contractMode = failures.length ? "server_decay_mismatch" : "nuri_server_decay_recovery";
  const detail = [
    `contract=${contractMode}`,
    `arkade_leaf=${arkadeLeaves.length}`,
    `aggregate_recovery_leaf=${aggregateRecoveryLeaves.length}`,
    `client_decay_leaf=${clientRecoveryLeaves.length}`,
    `csv_leaves=${csvLeaves.length}`,
    `leaf_count=${scripts.length}`,
    `script_match=${scriptPubKeyHex === expectedProof.scriptPubKeyHex ? 1 : 0}`,
    `arkade_csv=${formatArkadeTimelock(args.params.arkadeCsvTimelock)}`,
    `nuri_server_csv=${formatArkadeTimelock(args.params.nuriServerCsvTimelock)}`,
    `client_csv=${formatArkadeTimelock(clientTimelock)}`,
    `failures=${failures.join(",") || "none"}`,
  ].join(" ");

  return {
    pass: failures.length === 0,
    failures,
    contractMode,
    address,
    scriptPubKeyHex,
    aggregateRecoveryCsvSequence: aggregateCsv?.params?.timelock
      ? String(bip68SequenceFromTimelock(aggregateCsv.params.timelock))
      : "",
    clientRecoveryCsvSequence: clientCsv?.params?.timelock
      ? String(bip68SequenceFromTimelock(clientCsv.params.timelock))
      : "",
    arkadeCsvLabel: formatArkadeTimelock(args.params.arkadeCsvTimelock),
    nuriServerCsvLabel: formatArkadeTimelock(args.params.nuriServerCsvTimelock),
    clientRecoveryCsvLabel: formatArkadeTimelock(clientTimelock),
    arkadePathMatch: arkadeLeaves.length === 1,
    aggregateRecoveryPathMatch: aggregateRecoveryLeaves.length === 1,
    clientRecoveryPathMatch: clientRecoveryLeaves.length === 1,
    unsafeClientOnlyBeforeNuriServerCsv: unsafeClientLeaves.length > 0,
    directNuriServerKeyInLeaf: directNuriServerLeaves.length > 0,
    clientProof: actualProof,
    detail,
  };
}
