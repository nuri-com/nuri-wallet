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

type SettleableWallet<P> = {
  settle: (params?: P, eventCallback?: (event: SettleEvent) => void) => Promise<unknown>;
};

/**
 * Run `wallet.settle` (all coins, or the explicit `params`), parking the batch commitment for the signer session and
 * clearing it afterwards — on success and on failure alike.
 */
export async function settleWithBatchCommitment<P = undefined>(
  wallet: SettleableWallet<P>,
  params?: P,
): Promise<unknown> {
  try {
    return await wallet.settle(params, (event) => {
      if (event?.type === SettlementEventType.TreeSigningStarted) {
        setPendingBatchCommitmentTx(String(event.unsignedCommitmentTx || ""));
      }
    });
  } finally {
    clearPendingBatchCommitmentTx();
  }
}
