// CSV (Check Sequence Verify) utilities — extracted from BitcoinCheckSequenceVerifyCSVRecoveryScreen
import type { RelativeTimelock } from "@arkade-os/sdk";
import type { CheckSequenceVerifyStatus, UTXO } from "../../types/BitcoinCheckSequenceVerifyCSV";
import type { ArkadeRelativeTimelock } from "../../services/arkade/ArkadeApiService";
import { bytesToHex } from "../bytes";

// BIP68 relative-timelock encoding. The Arkade SDK carries the value as a
// bigint, the co-signer JSON as a plain number — both are accepted here.
export type Bip68Timelock = RelativeTimelock | ArkadeRelativeTimelock;

const BIP68_LOCKTIME_GRANULARITY = 9;
const BIP68_LOCKTIME_MASK = 0x0000ffff;
const BIP68_LOCKTIME_TYPE_FLAG = 1 << 22;
const BIP68_SECONDS_MOD = 1 << BIP68_LOCKTIME_GRANULARITY;
const BIP68_SECONDS_MAX = BIP68_LOCKTIME_MASK << BIP68_LOCKTIME_GRANULARITY;
export const BIP68_LOCKTIME_DISABLE_FLAG = 1 << 31;
// Largest sequence BIP68 can express: the seconds type flag plus a full value.
export const BIP68_SEQUENCE_MAX = BIP68_LOCKTIME_TYPE_FLAG | BIP68_LOCKTIME_MASK;

export function assertBip68Timelock(timelock: Bip68Timelock, field: string): void {
  if (!timelock || (timelock.type !== "blocks" && timelock.type !== "seconds")) {
    throw new Error(`${field} must be a block or seconds timelock`);
  }
  const value = Number(timelock.value);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive timelock`);
  }
}

export function bip68SequenceFromTimelock(timelock: Bip68Timelock): number {
  assertBip68Timelock(timelock, "timelock");
  const value = Number(timelock.value);
  if (timelock.type === "seconds") {
    if (value > BIP68_SECONDS_MAX || value % BIP68_SECONDS_MOD !== 0) {
      throw new Error("timelock seconds must fit BIP68 seconds granularity");
    }
    return BIP68_LOCKTIME_TYPE_FLAG | (value >> BIP68_LOCKTIME_GRANULARITY);
  }
  if (value > BIP68_LOCKTIME_MASK) {
    throw new Error("timelock blocks must fit BIP68");
  }
  return value;
}

/**
 * The same encoding, but null instead of a throw when BIP68 cannot express the
 * value. Rejecting stays the rule — the sequence sits IN the script, so a
 * silently truncated timelock would derive an address nobody else agrees on,
 * and the Arkade SDK refuses a non-512-aligned seconds timelock just as this
 * does. Callers that can degrade (publish nothing, fall back to a confirmed
 * default) take this one so an unencodable co-signer policy stops at the value
 * instead of aborting the whole hydrate around it.
 */
export function tryBip68SequenceFromTimelock(timelock: Bip68Timelock): number | null {
  try {
    return bip68SequenceFromTimelock(timelock);
  } catch {
    return null;
  }
}

export function timelockFromBip68Sequence(sequence: number): RelativeTimelock {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`invalid BIP68 sequence: ${sequence}`);
  }
  if (sequence & BIP68_LOCKTIME_DISABLE_FLAG) {
    throw new Error(`invalid BIP68 sequence: ${sequence}`);
  }
  const value = sequence & BIP68_LOCKTIME_MASK;
  if (sequence & BIP68_LOCKTIME_TYPE_FLAG) {
    return { type: "seconds", value: BigInt(value << BIP68_LOCKTIME_GRANULARITY) };
  }
  return { type: "blocks", value: BigInt(value) };
}

export function calculateCSVStatus(
  utxo: UTXO,
  currentBlock: number,
  csvBlocks: number,
): CheckSequenceVerifyStatus {
  if (!utxo.isConfirmed || !utxo.confirmationBlock) {
    return {
      isLocked: true,
      isDeadmanSwitchActive: false,
      requiredSignatures: 2,
      confirmationBlock: null,
      currentBlock,
      csvUnlockBlock: null,
      blocksRemaining: Number.POSITIVE_INFINITY,
      hoursRemaining: Number.POSITIVE_INFINITY,
      daysRemaining: Number.POSITIVE_INFINITY,
    };
  }

  const csvUnlockBlock = utxo.confirmationBlock + csvBlocks;
  const blocksRemaining = Math.max(0, csvUnlockBlock - currentBlock);
  const isDeadmanSwitchActive = currentBlock >= csvUnlockBlock;
  const hoursRemaining = (blocksRemaining * 10) / 60;
  const daysRemaining = hoursRemaining / 24;

  return {
    isLocked: !isDeadmanSwitchActive,
    isDeadmanSwitchActive,
    requiredSignatures: isDeadmanSwitchActive ? 1 : 2,
    confirmationBlock: utxo.confirmationBlock,
    currentBlock,
    csvUnlockBlock,
    blocksRemaining,
    hoursRemaining,
    daysRemaining,
  };
}

export function parseOlderBlocks(descriptor?: string | null): number | null {
  if (!descriptor) return null;
  const match = descriptor.match(/older\((\d+)\)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function scriptHexFromTweakedPubkey(tweaked: Uint8Array): string {
  const script = new Uint8Array(34);
  script[0] = 0x51;
  script[1] = 0x20;
  script.set(tweaked, 2);
  return bytesToHex(script);
}
