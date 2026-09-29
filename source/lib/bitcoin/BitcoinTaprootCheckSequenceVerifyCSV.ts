// lib/bitcoin/BitcoinTaprootCheckSequenceVerifyCSV.ts
// Helper for building CSV (CheckSequenceVerify) tapscript leaves for Bitcoin recovery
import * as btc from "@scure/btc-signer";
import {
  BIP68_LOCKTIME_DISABLE_FLAG,
  BIP68_SEQUENCE_MAX,
  bip68SequenceFromTimelock,
  type Bip68Timelock,
} from "./csv";

// @scure/btc-signer ships only mainnet (NETWORK) and testnet (TEST_NETWORK).
// Regtest params per Bitcoin Core: bech32 "bcrt", pubKeyHash 0x6f, scriptHash 0xc4, wif 0xef.
const REGTEST_NETWORK: typeof btc.NETWORK = {
  bech32: "bcrt",
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

/**
 * Builds a CSV tapscript leaf for time-locked recovery
 * Script: <userKey> CHECKSIGVERIFY <csvSequence> CHECKSEQUENCEVERIFY
 *
 * This allows the user's key to spend after the relative timelock has elapsed
 * without requiring the co-signer (recovery mechanism)
 *
 * @param userXOnly - User's x-only public key (32 bytes)
 * @param csvSequence - BIP68 sequence: a raw block count, or a seconds
 *   timelock carrying the type flag (see `bip68SequenceFromTimelock`)
 * @returns Tapscript leaf object with script and version
 */
export function buildCsvLeaf(
  userXOnly: Uint8Array,
  csvSequence: number,
): { script: Uint8Array; leafVersion: 0xc0 } {
  if (userXOnly.length !== 32) {
    throw new Error(`Invalid userXOnly length: expected 32 bytes, got ${userXOnly.length}`);
  }

  if (!Number.isInteger(csvSequence) || csvSequence <= 0) {
    throw new Error(`Invalid csvSequence: must be positive integer, got ${csvSequence}`);
  }

  // A leaf whose sequence disables the relative timelock, or overflows what
  // BIP68 can express, is unspendable — reject it before it becomes an address
  if ((csvSequence & BIP68_LOCKTIME_DISABLE_FLAG) !== 0 || csvSequence > BIP68_SEQUENCE_MAX) {
    throw new Error(`Invalid csvSequence: not a BIP68 relative timelock, got ${csvSequence}`);
  }

  // Build the CSV script: <userKey> CHECKSIGVERIFY <csvSequence> CHECKSEQUENCEVERIFY
  // This matches the descriptor: and_v(v:pk(userKey),older(csvSequence))
  // Note: @scure/btc-signer accepts numbers directly or as BigInt
  const csvScript = btc.Script.encode([
    userXOnly, // 32-byte x-only pubkey
    "CHECKSIGVERIFY", // Verify signature (will abort if invalid)
    csvSequence, // Push CSV sequence as number (library handles encoding)
    "CHECKSEQUENCEVERIFY", // Check sequence (relative timelock)
  ]);

  // Return tapscript leaf with version 0xc0 (tapscript version)
  return {
    script: csvScript,
    leafVersion: 0xc0 as const,
  };
}

/**
 * Creates a P2TR address with CSV recovery capability
 *
 * @param internalKey - MuSig2 aggregated internal key P (32 bytes x-only)
 * @param userXOnly - User's x-only public key for CSV recovery (32 bytes)
 * @param csvSequence - BIP68 sequence for the CSV timelock
 * @param network - Bitcoin network ('main', 'testnet', 'regtest')
 * @returns P2TR output with address, scriptPubKey, and taproot details
 */
export function makeP2TRWithCSV(
  internalKey: Uint8Array,
  userXOnly: Uint8Array,
  csvSequence: number,
  network: "main" | "testnet" | "regtest" = "main",
): ReturnType<typeof btc.p2tr> {
  // Build the CSV leaf
  const leaf = buildCsvLeaf(userXOnly, csvSequence);

  // Determine network configuration
  let btcNetwork: typeof btc.NETWORK;
  switch (network) {
    case "testnet":
      btcNetwork = btc.TEST_NETWORK;
      break;
    case "regtest":
      btcNetwork = REGTEST_NETWORK;
      break;
    default:
      btcNetwork = btc.NETWORK; // mainnet
  }

  // Create P2TR with CSV script tree
  // IMPORTANT: allowUnknownOutputs=true to accept custom leaf
  const p2tr = btc.p2tr(internalKey, [leaf], btcNetwork, /*allowUnknownOutputs=*/ true);

  // p2tr now contains:
  // - address: the bech32m taproot address
  // - script: scriptPubKey (34 bytes: 0x5120 + Q)
  // - tapMerkleRoot: computed merkle root
  // - tapLeafScript: array with control blocks and scripts
  // - tweakedPubkey: Q (tweaked with merkle root)
  // - tapInternalKey: P (untweaked)

  return p2tr;
}

/**
 * Same P2TR, but from an Arkade relative timelock instead of a raw sequence —
 * the co-signer states its CSV policy as {type, value}, not as BIP68 bits.
 */
export function makeP2TRWithTimelock(
  internalKey: Uint8Array,
  userXOnly: Uint8Array,
  timelock: Bip68Timelock,
  network: "main" | "testnet" | "regtest" = "main",
): ReturnType<typeof btc.p2tr> {
  return makeP2TRWithCSV(internalKey, userXOnly, bip68SequenceFromTimelock(timelock), network);
}

/**
 * Extracts x-only key from compressed public key
 * @param compressed - 33-byte compressed public key (02/03 prefix)
 * @returns 32-byte x-only key
 */
export function toXOnly(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) {
    throw new Error(`Invalid compressed key length: expected 33, got ${compressed.length}`);
  }
  if (compressed[0] !== 0x02 && compressed[0] !== 0x03) {
    throw new Error(
      `Invalid compressed key prefix: expected 02 or 03, got ${compressed[0].toString(16)}`,
    );
  }
  return compressed.slice(1);
}
