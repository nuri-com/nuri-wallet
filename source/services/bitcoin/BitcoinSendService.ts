// Single entry point for "send Bitcoin".
//
// Delegates to the arkade BtcL2Provider, which owns the send mechanism and the
// post-send refresh emit. Onchain sends are *not* routed here — spending the
// MuSig2 balance is `services/bitcoin/OnchainSendService.ts`.

import { payArkadeLightningInvoice } from "../arkade/ArkadeLightningSendService";
import { getBtcL2Provider } from "./providers/registry";

type ArkadeLightningPayResult = Awaited<ReturnType<typeof payArkadeLightningInvoice>>;

// The bolt11/lnurl kinds pay over the Arkade Intents send corridor. Receiving
// over Lightning has no counterpart yet — no solver serves that direction — so
// the receive sheet still offers onchain rails only.
export type BitcoinSendTarget =
  | { kind: "bolt11"; invoice: string }
  | { kind: "lnurl"; lnurl: string; amountSats: number }
  | { kind: "bitcoin_onchain"; address: string; amountSats: number }
  | { kind: "ark_send"; address: string; amountSats: number };

export type BitcoinSendResult = {
  kind: BitcoinSendTarget["kind"];
  /** Onchain txid for bitcoin_onchain; offboard funding txid for lightning. */
  txid?: string;
  /** Lightning payment hash when applicable. */
  paymentHash?: string;
  raw?: ArkadeLightningPayResult | string;
};

export async function sendBitcoin(
  target: BitcoinSendTarget,
  // `mode` retained for call-site compatibility but ignored — arkade is the
  // only wallet path here. Onchain sends bypass this wrapper entirely
  // (`sendBitcoinOnchainFromMusig2` in OnchainSendService).
  _opts: { mode?: "arkade" } = {},
): Promise<BitcoinSendResult> {
  return getBtcL2Provider().send(target);
}
