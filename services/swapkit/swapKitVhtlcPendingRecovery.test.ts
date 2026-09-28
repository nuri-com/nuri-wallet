import { secp256k1 } from "@noble/curves/secp256k1";
import { CSVMultisigTapscript, Transaction, VHTLC, buildOffchainTx } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { vhtlcScriptClass } from "./vhtlcScriptVersion";
import {
  arkTxidCreditedAtScript,
  decideVhtlcSpend,
  finalizePendingVhtlcSpends,
  planVhtlcSpend,
  recoverSpentVhtlcVtxos,
  resolveVhtlcAddressVtxos,
  vhtlcCheckpointUnrollCandidates,
  vhtlcGetPendingTxMessage,
  vhtlcIntentProofJobs,
  type VhtlcAddressVtxo,
  type VhtlcPendingTx,
} from "./swapKitVhtlcPendingRecovery";

/**
 * Finishing an offchain VHTLC spend that was submitted but never finalized.
 *
 * `submitTx` → sign checkpoints → `finalizeTx` is not atomic, so an interruption
 * in that window leaves a pending tx at the ASP while the VHTLC VTXO already
 * reads as spent, and the retry that follows says "VHTLC is already spent". The
 * ASP still holds the tx and its checkpoints, so this recovery asks for them and
 * re-signs. These tests pin that request shape and the signing that follows,
 * using a real VHTLC script and real checkpoint transactions.
 */
describe("vhtlcIntentProofJobs", () => {
  const vhtlc = new (vhtlcScriptClass(1))({
    sender: xOnlyKey("11"),
    receiver: xOnlyKey("22"),
    server: xOnlyKey("33"),
    preimageHash: hex.decode("44".repeat(20)),
    refundLocktime: 1784471181n,
    unilateralClaimDelay: { type: "blocks", value: 100n },
    unilateralRefundDelay: { type: "blocks", value: 102n },
    unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
  });

  it("puts an anchor job first, then one job per coin", () => {
    const jobs = vhtlcIntentProofJobs([
      {
        txid: "aa".repeat(32),
        vout: 0,
        value: 1000n,
        tapTree: vhtlc.encode(),
        intentTapLeafScript: vhtlc.claim(),
      },
      {
        txid: "bb".repeat(32),
        vout: 1,
        value: 1000n,
        tapTree: vhtlc.encode(),
        intentTapLeafScript: vhtlc.claim(),
      },
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.index)).toEqual([0, 1, 2]);
    expect(hex.encode(jobs[0]?.lookupScript as Uint8Array)).toBe(
      hex.encode(jobs[1]?.lookupScript as Uint8Array),
    );
  });

  it("has no jobs to sign for an empty coin list", () => {
    expect(vhtlcIntentProofJobs([])).toEqual([]);
  });
});

describe("resolveVhtlcAddressVtxos", () => {
  const vtxo = (isSpent: boolean, txid: string): VhtlcAddressVtxo => ({
    txid,
    vout: 0,
    value: 6392,
    isSpent,
  });

  it("stops retrying as soon as the address is indexed, spent or not", async () => {
    const wait = vi.fn(async () => undefined);
    const queryVtxos = vi.fn(async () => [vtxo(true, "aa".repeat(32))]);

    const { seen, spendable } = await resolveVhtlcAddressVtxos({
      queryVtxos,
      retryAttempts: 10,
      retryDelayMs: 3000,
      wait,
    });

    expect(queryVtxos).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(spendable).toEqual([]);
  });

  it("retries while the lockup is not indexed yet", async () => {
    const wait = vi.fn(async () => undefined);
    let calls = 0;
    const queryVtxos = vi.fn(async () => (++calls < 3 ? [] : [vtxo(false, "bb".repeat(32))]));

    const { spendable } = await resolveVhtlcAddressVtxos({
      queryVtxos,
      retryAttempts: 5,
      retryDelayMs: 3000,
      wait,
    });

    expect(queryVtxos).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(spendable).toHaveLength(1);
  });
});

describe("planVhtlcSpend", () => {
  const vtxo = (isSpent: boolean, txid: string): VhtlcAddressVtxo => ({
    txid,
    vout: 0,
    value: 6392,
    isSpent,
  });

  // Review finding on #1450: recovery used to run only when NOTHING was
  // spendable, so a crash that left one input pending while another coin stayed
  // unspent was "recovered" by spending the other one and returning success.
  it("recovers the spent subset even when another coin is still spendable", () => {
    const plan = planVhtlcSpend([vtxo(true, "aa".repeat(32)), vtxo(false, "bb".repeat(32))]);
    expect(plan.outcome).toBe("recover-then-spend");
    expect(plan.toRecover.map((entry) => entry.txid)).toEqual(["aa".repeat(32)]);
    expect(plan.toSpend.map((entry) => entry.txid)).toEqual(["bb".repeat(32)]);
  });

  it("recovers only, when every coin reads spent", () => {
    const plan = planVhtlcSpend([vtxo(true, "aa".repeat(32))]);
    expect(plan.outcome).toBe("recover-only");
    expect(plan.toSpend).toEqual([]);
  });

  it("spends without recovery when nothing is pending", () => {
    const plan = planVhtlcSpend([vtxo(false, "bb".repeat(32))]);
    expect(plan.outcome).toBe("spend");
    expect(plan.toRecover).toEqual([]);
  });

  it("reports an address that is not indexed yet", () => {
    expect(planVhtlcSpend([]).outcome).toBe("not-indexed");
  });
});

describe("decideVhtlcSpend", () => {
  const vtxo = (isSpent: boolean, txid: string): VhtlcAddressVtxo => ({
    txid,
    vout: 0,
    value: 6392,
    isSpent,
  });
  const plan = (spent: VhtlcAddressVtxo[], unspent: VhtlcAddressVtxo[]) =>
    planVhtlcSpend([...spent, ...unspent]);

  // Review finding on #1450: with a mixed address, a failed recovery still let
  // the remaining coins be spent, so the action reported success with a pending
  // input left behind.
  it("fails closed instead of spending the rest when the recovery did not complete", () => {
    const decision = decideVhtlcSpend({
      plan: plan([vtxo(true, "aa".repeat(32))], [vtxo(false, "bb".repeat(32))]),
      recovery: { txid: null, failed: true },
    });
    expect(decision).toEqual({ kind: "abort-recovery-failed" });
  });

  it("spends the rest once the spent subset is recovered", () => {
    const decision = decideVhtlcSpend({
      plan: plan([vtxo(true, "aa".repeat(32))], [vtxo(false, "bb".repeat(32))]),
      recovery: { txid: "dd".repeat(32), failed: false },
    });
    expect(decision).toEqual({ kind: "spend-remaining" });
  });

  it("returns the recovered txid when there was nothing else to spend", () => {
    const decision = decideVhtlcSpend({
      plan: plan([vtxo(true, "aa".repeat(32))], []),
      recovery: { txid: "dd".repeat(32), failed: false },
    });
    expect(decision).toEqual({ kind: "return-recovered", txid: "dd".repeat(32) });
  });

  // Review finding on #1450: if finalizeTx succeeded and the process died before
  // the journal was completed, only a submitted marker remained. Rejecting there
  // loses a claim that actually went through.
  it("reports the journaled txid when the inputs are spent and nothing is pending", () => {
    const decision = decideVhtlcSpend({
      plan: plan([vtxo(true, "aa".repeat(32))], []),
      recovery: { txid: null, failed: false },
      previouslySubmittedArkTxid: "dd".repeat(32),
    });
    expect(decision).toEqual({ kind: "return-previous", txid: "dd".repeat(32) });
  });

  it("rejects an address whose spent coins have nothing pending and no journaled txid", () => {
    const decision = decideVhtlcSpend({
      plan: plan([vtxo(true, "aa".repeat(32))], []),
      recovery: { txid: null, failed: false },
    });
    expect(decision).toEqual({ kind: "rejected-already-spent" });
  });

  it("waits for the lockup when nothing is indexed yet", () => {
    expect(
      decideVhtlcSpend({
        plan: planVhtlcSpend([]),
        recovery: { txid: null, failed: false },
      }),
    ).toEqual({ kind: "deliver-unindexed" });
  });
});

describe("recoverSpentVhtlcVtxos", () => {
  const script = new (vhtlcScriptClass(1))({
    sender: xOnlyKey("11"),
    receiver: xOnlyKey("22"),
    server: xOnlyKey("33"),
    preimageHash: hex.decode("44".repeat(20)),
    refundLocktime: 1784471181n,
    unilateralClaimDelay: { type: "blocks", value: 100n },
    unilateralRefundDelay: { type: "blocks", value: 102n },
    unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
  });
  const coin: VhtlcAddressVtxo = { txid: "cc".repeat(32), vout: 3, value: 6392, isSpent: true };
  const toCoin = (vtxo: VhtlcAddressVtxo) => ({
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapTree: script.encode(),
    intentTapLeafScript: script.claim(),
  });

  it("reports a failed recovery rather than pretending nothing was pending", async () => {
    const provider = {
      getPendingTxs: vi.fn(async () => {
        throw new Error("asp unreachable");
      }),
      finalizeTx: vi.fn(async () => undefined),
    };

    const outcome = await recoverSpentVhtlcVtxos({
      provider,
      spentCoins: [coin],
      unrollCandidates: [],
      toCoin,
      sign: async (tx) => tx,
    });

    expect(outcome).toEqual({ txid: null, failed: true });
  });

  it("counts nothing pending as a clean outcome", async () => {
    const outcome = await recoverSpentVhtlcVtxos({
      provider: { getPendingTxs: vi.fn(async () => []), finalizeTx: vi.fn() },
      spentCoins: [coin],
      unrollCandidates: [],
      toCoin,
      sign: async (tx) => tx,
    });
    expect(outcome).toEqual({ txid: null, failed: false });
  });

  it("does not ask the ASP without a spent coin", async () => {
    const getPendingTxs = vi.fn();
    const outcome = await recoverSpentVhtlcVtxos({
      provider: { getPendingTxs, finalizeTx: vi.fn() },
      spentCoins: [],
      unrollCandidates: [],
      toCoin: () => {
        throw new Error("must not be called");
      },
      sign: async (tx) => tx,
    });
    expect(outcome).toEqual({ txid: null, failed: false });
    expect(getPendingTxs).not.toHaveBeenCalled();
  });
});

describe("recoverSpentVhtlcVtxos (fail closed)", () => {
  it("treats a pending tx it cannot bind as a failed recovery, not a clean one", async () => {
    const outcome = await recoverSpentVhtlcVtxos({
      provider: {
        getPendingTxs: vi.fn(async () => [{ arkTxid: "aa".repeat(32), signedCheckpointTxs: [] }]),
        finalizeTx: vi.fn(),
      },
      spentCoins: [{ txid: "cc".repeat(32), vout: 3, value: 6392, isSpent: true }],
      unrollCandidates: [],
      toCoin: (vtxo) => ({
        txid: vtxo.txid,
        vout: vtxo.vout,
        value: vtxo.value,
        tapTree: new Uint8Array([1, 2, 3]),
        intentTapLeafScript: undefined,
      }),
      sign: async (tx) => tx,
    });
    expect(outcome).toEqual({ txid: null, failed: true });
  });
});

describe("vhtlcCheckpointUnrollCandidates", () => {
  it("decodes the ASP's checkpoint tapscript into one candidate", () => {
    const encoded = CSVMultisigTapscript.encode({
      timelock: { type: "blocks", value: 144n },
      pubkeys: [new Uint8Array(32), new Uint8Array(32)],
    });
    expect(vhtlcCheckpointUnrollCandidates(hex.encode(encoded.script))).toHaveLength(1);
  });

  it("has no candidate for an empty tapscript", () => {
    expect(vhtlcCheckpointUnrollCandidates("")).toEqual([]);
  });
});

describe("arkTxidCreditedAtScript", () => {
  const indexer = (vtxos: Array<{ txid: string }>) => ({
    getVtxos: vi.fn(async () => ({ vtxos })),
  });

  it("finds the txid among the destination's vtxos", async () => {
    await expect(
      arkTxidCreditedAtScript({
        indexerProvider: indexer([{ txid: "dd".repeat(32) }]),
        arkTxid: "dd".repeat(32),
        outputScriptHex: "00",
      }),
    ).resolves.toBe(true);
  });

  it("reports no credit when the destination has no such txid", async () => {
    await expect(
      arkTxidCreditedAtScript({
        indexerProvider: indexer([{ txid: "ee".repeat(32) }]),
        arkTxid: "dd".repeat(32),
        outputScriptHex: "00",
      }),
    ).resolves.toBe(false);
  });

  it("never asks for an empty txid", async () => {
    const provider = indexer([]);
    await expect(
      arkTxidCreditedAtScript({ indexerProvider: provider, arkTxid: "", outputScriptHex: "00" }),
    ).resolves.toBe(false);
    expect(provider.getVtxos).not.toHaveBeenCalled();
  });
});

describe("vhtlcGetPendingTxMessage", () => {
  it("asks for the pending txs of the proof inputs without an expiry", () => {
    expect(vhtlcGetPendingTxMessage()).toEqual({ type: "get-pending-tx", expire_at: 0 });
  });
});

describe("finalizePendingVhtlcSpends", () => {
  const script = new (vhtlcScriptClass(1))({
    sender: xOnlyKey("11"),
    receiver: xOnlyKey("22"),
    server: xOnlyKey("33"),
    preimageHash: hex.decode("44".repeat(20)),
    refundLocktime: 1784471181n,
    unilateralClaimDelay: { type: "blocks", value: 100n },
    unilateralRefundDelay: { type: "blocks", value: 102n },
    unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
  });
  const coin = {
    txid: "cc".repeat(32),
    vout: 3,
    value: 6392,
    tapTree: script.encode(),
    intentTapLeafScript: script.claim(),
  };
  // Real checkpoints, built the way the ASP builds them: only then can the module
  // bind them to the coin (the SDK's own check compares the txid against the
  // checkpoint it would have built locally).
  const unrollScript = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: 144n },
    pubkeys: [new Uint8Array(32), new Uint8Array(32)],
  });
  const destinationScript = hex.decode(`0014${"22".repeat(20)}`);
  const checkpointTxFor = (args: { txid?: string; vout?: number; value?: number }) => {
    const input = {
      txid: args.txid ?? coin.txid,
      vout: args.vout ?? coin.vout,
      value: args.value ?? coin.value,
      tapLeafScript: script.claim(),
      tapTree: script.encode(),
    };
    const output = { amount: BigInt(input.value), script: destinationScript };
    const { checkpoints } = buildOffchainTx([input], [output], unrollScript);
    const [checkpoint] = checkpoints;
    if (!checkpoint) throw new Error("no checkpoint built for the test coin");
    return base64.encode(checkpoint.toPSBT());
  };
  const checkpointTx = () => checkpointTxFor({});
  /**
   * Signs by appending one marker output per signed input, so the assertions can
   * tell a signed transaction from the one that came back from the ASP.
   */
  const signer = vi.fn(async (tx: Transaction, inputIndexes?: number[]) => {
    const clone = Transaction.fromPSBT(tx.toPSBT());
    for (let i = 0; i < (inputIndexes ?? []).length; i += 1) {
      clone.addOutput({ script: script.pkScript, amount: 546n });
    }
    return clone;
  });

  const provider = (pendingTxs: VhtlcPendingTx[]) => ({
    getPendingTxs: vi.fn(async () => pendingTxs),
    finalizeTx: vi.fn(async () => undefined),
  });

  it("asks the ASP with a get-pending-tx proof over the VHTLC coins", async () => {
    const p = provider([]);
    await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });

    const [intent] = p.getPendingTxs.mock.calls[0] as unknown as [
      { proof: string; message: { type: string; expire_at: number } },
    ];
    expect(intent.message).toEqual({ type: "get-pending-tx", expire_at: 0 });
    expect(base64.decode(intent.proof).length).toBeGreaterThan(0);
    // Anchor input 0 shares the coin's script, so the signer is asked for both.
    expect(signer.mock.calls[0]?.[1]).toEqual([0, 1]);
  });

  it("re-signs a checkpoint that provably belongs to the coin, and finalizes that tx", async () => {
    const p = provider([{ arkTxid: "dd".repeat(32), signedCheckpointTxs: [checkpointTx()] }]);
    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });

    expect(finalized).toEqual(["dd".repeat(32)]);
    expect(blocked).toEqual([]);
    expect(p.finalizeTx).toHaveBeenCalledTimes(1);
    const [arkTxid, checkpoints] = p.finalizeTx.mock.calls[0] as unknown as [string, string[]];
    expect(arkTxid).toBe("dd".repeat(32));
    expect(checkpoints).toHaveLength(1);
    // The checkpoint was signed with the caller's signer on input 0 only, which
    // is what the marker output counts.
    const signedCheckpoint = Transaction.fromPSBT(base64.decode(checkpoints[0] as string));
    const originalCheckpoint = Transaction.fromPSBT(base64.decode(checkpointTx()));
    expect(signedCheckpoint.outputsLength).toBe(originalCheckpoint.outputsLength + 1);
  });

  // Codex finding on #1450: the field checks above cannot see version, locktime
  // or the input sequence, and those change what the signature commits to.
  it("blocks a checkpoint whose input sequence was changed", async () => {
    const tampered = Transaction.fromPSBT(base64.decode(checkpointTx()));
    tampered.updateInput(0, { sequence: 0xfffffffe });
    const p = provider([
      { arkTxid: "dd".repeat(32), signedCheckpointTxs: [base64.encode(tampered.toPSBT())] },
    ]);

    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });

    expect(blocked).toEqual(["dd".repeat(32)]);
    expect(finalized).toEqual([]);
    expect(p.finalizeTx).not.toHaveBeenCalled();
  });

  // Review finding on #1450 (round 4): the recovered txid must be durable BEFORE
  // finalization, otherwise a crash or a lost finalize response leaves a pending
  // tx with no handle.
  it("journals the recovered txid before it finalizes it", async () => {
    const p = provider([{ arkTxid: "dd".repeat(32), signedCheckpointTxs: [checkpointTx()] }]);
    const order: string[] = [];
    const journal = vi.fn(async () => {
      order.push("journal");
    });
    p.finalizeTx.mockImplementation(async () => {
      order.push("finalize");
    });

    const { finalized } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
      onSubmittedArkTxid: journal,
    });

    expect(journal).toHaveBeenCalledWith("dd".repeat(32));
    expect(order).toEqual(["journal", "finalize"]);
    expect(finalized).toEqual(["dd".repeat(32)]);
  });

  // Review finding on #1450: the ASP picks what it sends back, so a checkpoint
  // for a different spend must never reach the signer.
  it("refuses a checkpoint built for a different outpoint and reports it blocked", async () => {
    const substituted = checkpointTxFor({ vout: 7 });
    const p = provider([{ arkTxid: "ee".repeat(32), signedCheckpointTxs: [substituted] }]);
    const localSigner = vi.fn(async (tx: Transaction, inputIndexes?: number[]) => {
      const clone = Transaction.fromPSBT(tx.toPSBT());
      for (let i = 0; i < (inputIndexes ?? []).length; i += 1) {
        clone.addOutput({ script: script.pkScript, amount: 546n });
      }
      return clone;
    });

    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: localSigner,
      unrollCandidates: [unrollScript],
    });

    expect(finalized).toEqual([]);
    expect(blocked).toEqual(["ee".repeat(32)]);
    expect(p.finalizeTx).not.toHaveBeenCalled();
    // Only the proof was signed; the substituted checkpoint never was.
    expect(localSigner).toHaveBeenCalledTimes(1);
  });

  it("refuses a checkpoint locking a different amount", async () => {
    const substituted = checkpointTxFor({ value: 5000 });
    const p = provider([{ arkTxid: "ef".repeat(32), signedCheckpointTxs: [substituted] }]);

    const { blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });

    expect(blocked).toEqual(["ef".repeat(32)]);
    expect(p.finalizeTx).not.toHaveBeenCalled();
  });

  it("does nothing when the ASP has no pending tx (the spend completed)", async () => {
    const p = provider([]);
    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });
    expect(finalized).toEqual([]);
    expect(blocked).toEqual([]);
    expect(p.finalizeTx).not.toHaveBeenCalled();
  });

  // Review finding on #1450 (P1): a pending tx with nothing to sign used to be
  // skipped, which let the caller spend the rest and call the action complete.
  it("reports a pending tx with no checkpoints as blocked instead of clean", async () => {
    const p = provider([{ arkTxid: "12".repeat(32), signedCheckpointTxs: [] }]);
    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: p,
      coins: [coin],
      sign: signer,
      unrollCandidates: [unrollScript],
    });
    expect(finalized).toEqual([]);
    expect(blocked).toEqual(["12".repeat(32)]);
    expect(p.finalizeTx).not.toHaveBeenCalled();
  });

  it("never asks the ASP without a coin to prove ownership of", async () => {
    const p = provider([{ arkTxid: "34".repeat(32) }]);
    expect(
      await finalizePendingVhtlcSpends({
        provider: p,
        coins: [],
        sign: signer,
        unrollCandidates: [unrollScript],
      }),
    ).toEqual({ finalized: [], blocked: [] });
    expect(p.getPendingTxs).not.toHaveBeenCalled();
  });
});

function xOnlyKey(seed: string): Uint8Array {
  return secp256k1.getPublicKey(hex.decode(seed.repeat(32)), true).slice(1);
}

// The script class is chosen the same way the adapter does it; a VHTLC script
// must be real here because the proof jobs decode its tree.
void VHTLC;
