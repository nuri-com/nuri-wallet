// The manual-settle hand-off, in one place that can be tested.
//
// A settle joins a batch round, and the cosigner re-derives that round's tree
// messages from its commitment transaction — which only ever surfaces on the
// settle event stream. So the commitment has to be parked in a module-level
// slot for the signer session to pick up, and that slot is shared by every
// later round: leaving this one's commitment armed hands it to an unrelated
// operation. Arming and clearing therefore belong to the same function.
import { SettlementEventType } from "@arkade-os/sdk";
import { clearPendingBatchCommitmentTx, setPendingBatchCommitmentTx } from "./batchCommitment";

type SettleEvent = { type?: unknown; unsignedCommitmentTx?: unknown };

type SettleableWallet = {
  settle: (params?: undefined, eventCallback?: (event: SettleEvent) => void) => Promise<unknown>;
};

/**
 * Run `wallet.settle`, parking the batch commitment for the signer session and
 * clearing it afterwards — on success and on failure alike.
 */
export async function settleWithBatchCommitment(wallet: SettleableWallet): Promise<unknown> {
  try {
    return await wallet.settle(undefined, (event) => {
      if (event?.type === SettlementEventType.TreeSigningStarted) {
        setPendingBatchCommitmentTx(String(event.unsignedCommitmentTx || ""));
      }
    });
  } finally {
    clearPendingBatchCommitmentTx();
  }
}
