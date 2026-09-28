/**
 * Pure encoding contract retained from #1163; no WalletConnect runtime is enabled.
 * PayTarget.amount is already the exact base-units integer used by its QR.
 */
export function walletConnectUnits(amount: string | null): bigint | null {
  if (amount === null || !/^\d+$/.test(amount)) return null;
  const units = BigInt(amount);
  return units > 0n && units < 2n ** 256n ? units : null;
}

/** ERC-20 transfer(address,uint256), without re-scaling the target amount. */
export function erc20TransferCalldata(token: string, to: string, units: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error("erc20TransferCalldata: malformed address");
  }
  if (units <= 0n || units >= 2n ** 256n) throw new Error("erc20TransferCalldata: invalid uint256");
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${units.toString(16).padStart(64, "0")}`;
}
