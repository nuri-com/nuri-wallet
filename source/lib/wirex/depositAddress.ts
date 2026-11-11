// lib/wirex/depositAddress.ts
//
// The card deposit address is `wallet_address` from the server's GET /wallet.
// The app derives the Kernel address the EOA must own locally
// (deriveWirexKernelAddress) and compares the two before wallet → card money
// goes there (#1899). Pure decision only — derivation, memo and reporting live
// in WirexAccountService.
import { isValidEvmAddress } from "../validation";

/** Server address is a valid EVM address AND equals the locally derived one. */
export function depositAddressMatches(
  serverAddress: string | null,
  expected: string | null,
): boolean {
  return Boolean(
    serverAddress &&
      expected &&
      isValidEvmAddress(serverAddress) &&
      serverAddress.trim().toLowerCase() === expected.trim().toLowerCase(),
  );
}

/**
 * Where wallet → card money may go. Observe mode passes the server address
 * through unchanged (today's behaviour); enforce mode only hands it out once it
 * is verified, and refuses (null) on a mismatch or while verification is
 * unresolved.
 */
export function resolveDepositAddress(opts: {
  serverAddress: string | null;
  expected: string | null;
  enforce: boolean;
}): string | null {
  const { serverAddress, expected, enforce } = opts;
  if (!enforce) return serverAddress;
  return depositAddressMatches(serverAddress, expected) ? serverAddress : null;
}
