import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { Estimator, type FeeInfo } from "@arkade-os/sdk";

/**
 * `Ramps.offboard(address, feeInfo, amount)` treats `amount` as what LEAVES the
 * wallet and pays the onchain output fee out of it (`amount -= outputFee` in
 * SDK 0.4.38 before it builds the destination output), so the receiver gets
 * less than the caller asked for. Every caller here means the RECEIVER amount —
 * a SwapKit deposit is rejected or under-credited when it lands short — so the
 * fee is added back on with the SDK's own estimator and the same feeInfo the
 * offboard will use. The fee depends on the amount only through its varint
 * length, so one re-evaluation at the grossed-up figure settles it.
 */
export function grossUpOffboardSats(
  receiverSats: number,
  address: string,
  feeInfo: FeeInfo,
): number {
  const estimator = new Estimator(feeInfo?.intentFee ?? {});
  // Mainnet only: every offboard destination this app produces is a mainnet
  // address, and the send is refused earlier if it is not decodable.
  const script = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address)));
  let total = BigInt(receiverSats);
  for (let round = 0; round < 2; round++) {
    const fee = BigInt(estimator.evalOnchainOutput({ amount: total, script }).satoshis);
    const next = BigInt(receiverSats) + fee;
    if (next === total) break;
    total = next;
  }
  return Number(total);
}
