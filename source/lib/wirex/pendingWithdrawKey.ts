// The Keychain entry that records a withdrawal past its point of no return.
// Wallet-scoped, so no static wipe list can name it — the reset flows resolve
// the address first and pass the key in, exactly as they do for the account
// email. Kept here rather than in WirexService so a wipe does not have to
// import the service (and its whole graph) to delete one key.
export function pendingWithdrawKeyFor(wallet: string): string {
  return `wirex:withdraw:pending:v1:${wallet.toLowerCase()}`;
}
