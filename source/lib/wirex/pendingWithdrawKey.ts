// The Keychain entry that records a withdrawal past its point of no return.
// Wallet-scoped, so no static wipe list can name it — the reset flows resolve
// the address first and pass the key in, exactly as they do for the account
// email. Kept here rather than in WirexService so a wipe does not have to
// import the service (and its whole graph) to delete one key.
export function pendingWithdrawKeyFor(wallet: string): string {
  return `wirex:withdraw:pending:v1:${wallet.toLowerCase()}`;
}

// The record of a direct onchain withdrawal's signed final step (#1956). Unlike
// the hosted marker it is NOT wiped by logout or reset: the signed transaction
// may still land whatever the device forgets, so only the chain releases it.
// Native wipes reset only the servers they name, and the web wipe keeps every
// key under this prefix.
export const DIRECT_WITHDRAW_KEY_PREFIX = "wirex:withdraw:direct:v1:";

export function directWithdrawKeyFor(wallet: string): string {
  return `${DIRECT_WITHDRAW_KEY_PREFIX}${wallet.toLowerCase()}`;
}
