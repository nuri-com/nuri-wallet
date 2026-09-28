import {
  VtxoScript,
  contractHandlers,
  type Contract,
  type ContractHandler,
  type PathContext,
  type PathSelection,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { bytesToHex, hexToBytes } from "../../lib/bytes";
import { secp256k1 } from "../../lib/crypto";
import {
  addArkadeTimelocks,
  arkadeTimelockToSequence,
  buildArkadeServerDecayClientProof,
  buildArkadeServerDecayLeaves,
  buildArkadeServerDecayVtxoScript,
  sequenceToArkadeTimelock,
  validateArkadeServerDecayPolicyParams,
  type ArkadeServerDecayClientRecoveryProof,
  type ArkadeServerDecayPolicyParams,
  type ArkadeServerDecayProofNetwork,
} from "./ArkadeServerDecayPolicy";
import { NURI_CONTRACT_TYPE } from "./ArkadeVersion";

export const ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE = NURI_CONTRACT_TYPE;

export type ArkadeClientRecoveryContractParams = ArkadeServerDecayPolicyParams;
export type ArkadeClientRecoveryProofNetwork = ArkadeServerDecayProofNetwork;
export type ArkadeClientRecoveryProofRecoveryData =
  ArkadeServerDecayClientRecoveryProof["recoveryData"];
export type ArkadeClientRecoveryProof = ArkadeServerDecayClientRecoveryProof;

const REQUIRED_SERIALIZED_FIELDS = [
  "aggregatePubKey",
  "clientPubKey",
  "nuriServerPubKey",
  "arkadeServerPubKey",
  "arkadeCsvTimelock",
  "nuriServerCsvTimelock",
] as const;

const REJECTED_SERIALIZED_FIELDS = ["cooperativePubKey", "serverPubKey", "csvTimelock"] as const;

type ArkadeClientRecoveryOptions = ArkadeClientRecoveryContractParams & {
  pubKey: Uint8Array;
  serverPubKey: Uint8Array;
  csvTimelock: ArkadeClientRecoveryContractParams["arkadeCsvTimelock"];
};

type AnyArkadeClientRecoveryContractParams = ArkadeClientRecoveryContractParams;
type AnyArkadeClientRecoveryVtxoScript = ArkadeClientRecoveryVtxoScript;

type CsvPathContext = PathContext & {
  blockHeight?: unknown;
  vtxo?: {
    status?: {
      block_height?: unknown;
      blockHeight?: unknown;
      block_time?: unknown;
      blockTime?: unknown;
    };
  };
};

function isCsvSpendable(context: PathContext, sequence: number): boolean {
  const csvContext = context as CsvPathContext;
  const vtxo = csvContext.vtxo;
  if (!vtxo) return false;
  const timelock = sequenceToArkadeTimelock(sequence);
  if (timelock.type === "blocks") {
    const currentHeight = Number(csvContext.blockHeight);
    const vtxoHeight = Number(vtxo?.status?.block_height ?? vtxo?.status?.blockHeight);
    if (!Number.isFinite(currentHeight) || !Number.isFinite(vtxoHeight)) return false;
    return currentHeight - vtxoHeight >= Number(timelock.value);
  }
  const blockTime = Number(vtxo?.status?.block_time ?? vtxo?.status?.blockTime);
  if (!Number.isFinite(blockTime)) return false;
  return Number(context.currentTime || 0) / 1000 - blockTime >= Number(timelock.value);
}

function serializeTimelock(timelock: RelativeTimelock): string {
  return String(arkadeTimelockToSequence(timelock));
}

function deserializeTimelock(params: Record<string, string>, field: string): RelativeTimelock {
  const sequence = Number(params[field] || 0);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(`${field} must be a positive sequence`);
  }
  return sequenceToArkadeTimelock(sequence);
}

function hasSerializedField(params: Record<string, string>, field: string): boolean {
  return typeof params[field] === "string" && params[field].trim().length > 0;
}

function assertXOnlyPubKey(value: Uint8Array, field: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${field} must be a 32-byte x-only pubkey`);
  }
  try {
    secp256k1.Point.fromHex(`02${bytesToHex(value)}`);
  } catch (evenError) {
    try {
      secp256k1.Point.fromHex(`03${bytesToHex(value)}`);
    } catch {
      const detail = evenError instanceof Error ? evenError.message : "unknown";
      throw new Error(`${field} invalid public key point: ${detail}`);
    }
  }
}

export function getArkadeClientRecoveryContractParamDiagnostics(
  params: Record<string, string> | null | undefined,
): {
  schema: "current_v1" | "rejected" | "unknown";
  missingFields: string[];
  rejectedFields: string[];
  presentFields: string[];
} {
  const safeParams = params || {};
  const presentFields = Object.keys(safeParams).sort();
  const missingFields = REQUIRED_SERIALIZED_FIELDS.filter(
    (field) => !hasSerializedField(safeParams, field),
  );
  const rejectedFields = REJECTED_SERIALIZED_FIELDS.filter((field) =>
    hasSerializedField(safeParams, field),
  );
  return {
    schema:
      missingFields.length === 0
        ? "current_v1"
        : rejectedFields.length > 0
          ? "rejected"
          : "unknown",
    missingFields,
    rejectedFields,
    presentFields,
  };
}

export function validateSerializedArkadeClientRecoveryContractParams(
  params: Record<string, string> | null | undefined,
): asserts params is Record<string, string> {
  const diagnostics = getArkadeClientRecoveryContractParamDiagnostics(params);
  if (diagnostics.missingFields.length <= 0) return;
  throw new Error(
    [
      `${ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE} contract params validation failed`,
      `schema=${diagnostics.schema}`,
      `missing=${diagnostics.missingFields.join(",")}`,
      `rejectedFields=${diagnostics.rejectedFields.join(",") || "none"}`,
      `present=${diagnostics.presentFields.join(",") || "none"}`,
      `expected=${REQUIRED_SERIALIZED_FIELDS.join(",")}`,
    ].join(" "),
  );
}

export class ArkadeClientRecoveryVtxoScript extends VtxoScript {
  readonly options: ArkadeClientRecoveryOptions;
  readonly arkadePathScript: string;
  readonly aggregateRecoveryScript: string;
  readonly clientRecoveryScript: string;

  constructor(params: ArkadeClientRecoveryContractParams) {
    validateArkadeServerDecayPolicyParams(params);
    assertXOnlyPubKey(params.aggregatePubKey, "aggregatePubKey");
    assertXOnlyPubKey(params.clientPubKey, "clientPubKey");
    assertXOnlyPubKey(params.nuriServerPubKey, "nuriServerPubKey");
    assertXOnlyPubKey(params.arkadeServerPubKey, "arkadeServerPubKey");
    const leaves = buildArkadeServerDecayLeaves(params);

    super([leaves.arkadePathScript, leaves.aggregateRecoveryScript, leaves.clientRecoveryScript]);

    this.options = {
      ...params,
      pubKey: params.aggregatePubKey,
      serverPubKey: params.arkadeServerPubKey,
      csvTimelock: params.arkadeCsvTimelock,
    };
    this.arkadePathScript = bytesToHex(leaves.arkadePathScript);
    this.aggregateRecoveryScript = bytesToHex(leaves.aggregateRecoveryScript);
    this.clientRecoveryScript = bytesToHex(leaves.clientRecoveryScript);
  }

  arkadePath() {
    return this.findLeaf(this.arkadePathScript);
  }

  forfeit() {
    return this.arkadePath();
  }

  get exitScript(): string {
    // SDK 0.4.x boarding scans decode `boardingTapscript.exitScript`
    // directly. Our exit path is the aggregate CSV recovery leaf, so expose
    // the same CSVMultisigTapscript-encoded hex shape as DefaultVtxo.Script.
    return this.aggregateRecoveryScript;
  }

  exit() {
    return this.aggregateRecovery();
  }

  aggregateRecovery() {
    return this.findLeaf(this.aggregateRecoveryScript);
  }

  clientRecovery() {
    return this.findLeaf(this.clientRecoveryScript);
  }
}

export const ArkadeClientRecoveryContractHandler: ContractHandler<
  AnyArkadeClientRecoveryContractParams,
  AnyArkadeClientRecoveryVtxoScript
> = {
  type: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,

  // The wallet's own default contract, not an escrow: generic coin selection
  // must be allowed to pick its VTXOs. Absent this, the SDK reads the missing
  // probe as "not generically spendable" and gates every VTXO on this script,
  // so `getBalance().available` is 0 and no send can fund itself.
  isGenericallySpendable(): boolean {
    return true;
  },

  createScript(params: Record<string, string>): AnyArkadeClientRecoveryVtxoScript {
    return new ArkadeClientRecoveryVtxoScript(this.deserializeParams(params));
  },

  serializeParams(params: AnyArkadeClientRecoveryContractParams): Record<string, string> {
    validateArkadeServerDecayPolicyParams(params);
    const clientCsvTimelock = addArkadeTimelocks(
      params.arkadeCsvTimelock,
      params.nuriServerCsvTimelock,
    );
    return {
      aggregatePubKey: bytesToHex(params.aggregatePubKey),
      clientPubKey: bytesToHex(params.clientPubKey),
      nuriServerPubKey: bytesToHex(params.nuriServerPubKey),
      arkadeServerPubKey: bytesToHex(params.arkadeServerPubKey),
      arkadeCsvTimelock: serializeTimelock(params.arkadeCsvTimelock),
      nuriServerCsvTimelock: serializeTimelock(params.nuriServerCsvTimelock),
      clientCsvTimelock: serializeTimelock(clientCsvTimelock),
    };
  },

  deserializeParams(params: Record<string, string>): ArkadeClientRecoveryContractParams {
    validateSerializedArkadeClientRecoveryContractParams(params);
    const out = {
      aggregatePubKey: hexToBytes(params.aggregatePubKey),
      clientPubKey: hexToBytes(params.clientPubKey),
      nuriServerPubKey: hexToBytes(params.nuriServerPubKey),
      arkadeServerPubKey: hexToBytes(params.arkadeServerPubKey),
      arkadeCsvTimelock: deserializeTimelock(params, "arkadeCsvTimelock"),
      nuriServerCsvTimelock: deserializeTimelock(params, "nuriServerCsvTimelock"),
    };
    validateArkadeServerDecayPolicyParams(out);
    return out;
  },

  selectPath(
    script: AnyArkadeClientRecoveryVtxoScript,
    _contract: Contract,
    context: PathContext,
  ): PathSelection | null {
    if (context.collaborative) {
      return { leaf: script.arkadePath() };
    }
    const aggregateSequence = arkadeTimelockToSequence(script.options.arkadeCsvTimelock);
    const clientSequence = arkadeTimelockToSequence(
      addArkadeTimelocks(script.options.arkadeCsvTimelock, script.options.nuriServerCsvTimelock),
    );
    if (isCsvSpendable(context, clientSequence)) {
      return { leaf: script.clientRecovery(), sequence: clientSequence };
    }
    if (isCsvSpendable(context, aggregateSequence)) {
      return { leaf: script.aggregateRecovery(), sequence: aggregateSequence };
    }
    return null;
  },

  getAllSpendingPaths(
    script: AnyArkadeClientRecoveryVtxoScript,
    _contract: Contract,
    context: PathContext,
  ): PathSelection[] {
    const paths: PathSelection[] = [];
    if (context.collaborative) {
      paths.push({ leaf: script.arkadePath() });
    }
    const aggregateSequence = arkadeTimelockToSequence(script.options.arkadeCsvTimelock);
    const clientSequence = arkadeTimelockToSequence(
      addArkadeTimelocks(script.options.arkadeCsvTimelock, script.options.nuriServerCsvTimelock),
    );
    paths.push({ leaf: script.aggregateRecovery(), sequence: aggregateSequence });
    paths.push({ leaf: script.clientRecovery(), sequence: clientSequence });
    return paths;
  },

  getSpendablePaths(
    script: AnyArkadeClientRecoveryVtxoScript,
    contract: Contract,
    context: PathContext,
  ): PathSelection[] {
    return this.getAllSpendingPaths(script, contract, context).filter((path: PathSelection) => {
      if (!path.sequence) return context.collaborative;
      return isCsvSpendable(context, Number(path.sequence));
    });
  },
};

export function registerArkadeClientRecoveryContractHandler(): void {
  if (contractHandlers.has(ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE)) {
    contractHandlers.unregister(ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE);
  }
  contractHandlers.register(ArkadeClientRecoveryContractHandler);
}

export function serializeArkadeClientRecoveryContractParams(
  params: ArkadeClientRecoveryContractParams,
): Record<string, string> {
  return ArkadeClientRecoveryContractHandler.serializeParams(params);
}

export function buildArkadeClientRecoveryProof(
  params: ArkadeClientRecoveryContractParams & {
    network?: string | null;
  },
): ArkadeClientRecoveryProof {
  return buildArkadeServerDecayClientProof(params);
}

export {
  arkadeTimelockToSequence,
  buildArkadeServerDecayVtxoScript as buildArkadeClientRecoveryVtxoScript,
};
