/**
 * CheckSequenceVerify (CSV) Type Definitions
 *
 * These types support the deadman switch functionality where UTXOs
 * become spendable with a single key after a certain number of blocks.
 */

export interface CSVConfig {
  csvBlocks: number; // Number of blocks for timelock (52500 in mainnet config)
}

export interface UTXO {
  txid: string;
  vout: number;
  value: number; // in satoshis
  address?: string;
  scriptPubkey?: string;
  confirmationBlock?: number;
  isConfirmed: boolean;
  status?: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface CheckSequenceVerifyStatus {
  isLocked: boolean; // Still requires 2-of-2 multisig
  isDeadmanSwitchActive: boolean; // Can spend with single key
  requiredSignatures: 1 | 2; // Number of signatures needed
  confirmationBlock: number | null; // Block where UTXO was confirmed
  currentBlock: number; // Current blockchain height
  csvUnlockBlock: number | null; // Block when deadman switch activates
  blocksRemaining: number; // Blocks until single-key spendable
  hoursRemaining: number; // Estimated hours (10 min/block)
  daysRemaining: number; // Estimated days
}

export interface UTXOWithCSV extends UTXO {
  csvStatus: CheckSequenceVerifyStatus;
}

export interface CSVBalanceBreakdown {
  total: number;
  multisigOnly: number; // Requires 2 signatures
  deadmanAvailable: number; // Can use 1 signature (CSV expired)
  unconfirmed: number; // Still in mempool

  utxoCounts: {
    total: number;
    multisigOnly: number;
    deadmanAvailable: number;
    unconfirmed: number;
  };

  // Additional useful info
  percentageRecoverable: number;
  nextUnlockIn?: {
    blocks: number;
    hours: number;
    utxo: UTXOWithCSV | null;
  };
}
