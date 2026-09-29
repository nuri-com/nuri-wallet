// The gas limit a server-built swap call is broadcast with.
//
// Two numbers exist, and each has already failed on its own:
//   - the provider's advisory (LI.FI's transactionRequest.gasLimit) was too low
//     for OKX-routed EURC→USDC on 2026-09-27: 2,434,500 advised, ~3,138,000
//     needed, and the inner swap ran out of gas ("adaptor call failed");
//   - our own estimate was too low on 2026-09-21 (sk_38670dfb): 967,818
//     estimated against a route LI.FI had priced at 2,574,900.
// The larger of the two covers both. Unused gas is refunded, so the only cost
// of the higher limit is the balance needed to authorise it.
export function swapGasLimit(advised: bigint | null | undefined, estimated: bigint): bigint {
  if (advised == null || advised <= 0n) return estimated;
  return advised > estimated ? advised : estimated;
}
