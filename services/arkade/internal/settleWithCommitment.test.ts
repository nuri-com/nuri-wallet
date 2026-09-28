import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the event enum is used from the SDK, which vitest cannot transform.
vi.mock("@arkade-os/sdk", () => ({
  SettlementEventType: { TreeSigningStarted: "TREE_SIGNING_STARTED" },
}));

import { getPendingBatchCommitmentTx, setPendingBatchCommitmentTx } from "./batchCommitment";
import { settleWithBatchCommitment } from "./settleWithCommitment";

const COMMITMENT = "cHNidP8BANkCAAAA";

beforeEach(() => {
  setPendingBatchCommitmentTx("");
});

describe("settleWithBatchCommitment", () => {
  it("arms the commitment for the signer session while the round runs", async () => {
    let seenDuringRound: string | null = null;

    await settleWithBatchCommitment({
      settle: async (_params, onEvent) => {
        onEvent?.({ type: "TREE_SIGNING_STARTED", unsignedCommitmentTx: COMMITMENT });
        seenDuringRound = getPendingBatchCommitmentTx();
        return "txid-1";
      },
    });

    expect(seenDuringRound).toBe(COMMITMENT);
  });

  // The slot is module-level: the next tree session reads whatever is left in
  // it, so this round's commitment must not outlive this round.
  it("clears it after the round settles", async () => {
    await settleWithBatchCommitment({
      settle: async (_params, onEvent) => {
        onEvent?.({ type: "TREE_SIGNING_STARTED", unsignedCommitmentTx: COMMITMENT });
        return "txid-1";
      },
    });

    expect(getPendingBatchCommitmentTx()).toBeNull();
  });

  it("clears it when the round throws", async () => {
    await expect(
      settleWithBatchCommitment({
        settle: async (_params, onEvent) => {
          onEvent?.({ type: "TREE_SIGNING_STARTED", unsignedCommitmentTx: COMMITMENT });
          throw new Error("session-init refused");
        },
      }),
    ).rejects.toThrow(/session-init refused/);

    expect(getPendingBatchCommitmentTx()).toBeNull();
  });

  it("leaves nothing behind for a later session either way", async () => {
    await settleWithBatchCommitment({
      settle: async (_params, onEvent) => {
        onEvent?.({ type: "TREE_SIGNING_STARTED", unsignedCommitmentTx: COMMITMENT });
        return "txid-1";
      },
    });

    // A second round that never reaches TreeSigningStarted must not inherit the
    // first one's commitment.
    let seenInSecondRound: string | null = "unset";
    await settleWithBatchCommitment({
      settle: async () => {
        seenInSecondRound = getPendingBatchCommitmentTx();
        return "txid-2";
      },
    });

    expect(seenInSecondRound).toBeNull();
  });

  it("ignores events that are not the tree-signing start", async () => {
    await settleWithBatchCommitment({
      settle: async (_params, onEvent) => {
        onEvent?.({ type: "BATCH_STARTED", unsignedCommitmentTx: COMMITMENT });
        expect(getPendingBatchCommitmentTx()).toBeNull();
        return "txid-1";
      },
    });
  });
});
