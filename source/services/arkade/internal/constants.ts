// Internal arkade constants shared by prod-tier and debug-tier code.
export const ARKADE_LN_CREATE_TIMEOUT_MS = 30_000;
export const ARKADE_CHAIN_SWAP_CLAIM_TIMEOUT_MS = 180_000;
export const ARKADE_NODE_INFO_TIMEOUT_MS = 8_000;

// The boarding floor lives in ./boardingMinimum, which reads it from the active
// node's info and falls back to 330 (the node lowered `utxoMinAmount` from 3,000).

// Minimum spendable amount worth recovering. Below this floor, leftover vtxos
// are dust the server refuses to co-sign ("not cooperatively spendable") and
// that costs more than its value to exit on-chain.
export const ARKADE_RECOVERABLE_UNLOCK_MIN_SATS = 333;
