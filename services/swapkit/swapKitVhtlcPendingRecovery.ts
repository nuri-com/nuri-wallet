import { base64, hex } from "@scure/base";
import {
  CSVMultisigTapscript,
  Intent,
  P2A,
  Transaction,
  type Transaction as TransactionType,
  VtxoScript,
  assertAllowedSighashTypes,
  buildOffchainTx,
  decodeTapscript,
  scriptFromTapLeafScript,
} from "@arkade-os/sdk";

/**
 * Finish a VHTLC offchain spend that was submitted but never finalized.
 *
 * `submitTx` → sign checkpoints → `finalizeTx` cannot be made atomic, so an
 * interruption inside that window (process death, app kill, a dropped socket)
 * leaves the ASP holding a pending offchain transaction: the VHTLC VTXO reads as
 * spent, nothing on the client knows the arkTxid, and the next attempt reports
 * "VHTLC is already spent" while the coin is still there. The ASP keeps the tx
 * together with its signed checkpoints and hands them back when asked with the
 * right inputs, so the window is recoverable: this module asks and re-signs.
 *
 * It deliberately knows nothing about the wallet, so it can be tested without
 * one: the caller supplies the VTLC coins, the ASP provider and the leaf signer
 * (the claim's signer attaches the preimage witness, the refund's does not).
 */

/** The fields of the SDK's pending tx that this recovery needs. */
export type VhtlcPendingTx = {
  arkTxid: string;
  signedCheckpointTxs?: string[];
};

export type VhtlcPendingProvider = {
  getPendingTxs(intent: {
    proof: string;
    message: Intent.GetPendingTxMessage;
  }): Promise<VhtlcPendingTx[]>;
  finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
};

export type VhtlcPendingCoin = {
  txid: string;
  vout: number;
  value: bigint | number;
  /** The VHTLC script tree, as `VtxoScript.decode` accepts it. */
  tapTree: Uint8Array;
  /** The leaf that will spend this VTXO; the proof carries its sequence. */
  intentTapLeafScript: unknown;
  /** Preimage for a claim leaf, so the proof's witness satisfies the script. */
  extraWitness?: Uint8Array[];
};

export type VhtlcIntentProofJob = {
  index: number;
  lookupScript: Uint8Array;
};

export type VhtlcAddressVtxo = {
  txid: string;
  vout: number;
  value: number;
  isSpent?: boolean;
};

/**
 * Read the VTXOs at a VHTLC address, retrying only while the address is empty:
 * an action can arrive before the indexer sees the lockup, but once anything is
 * indexed further waiting cannot change what is there, and the spent case (an
 * interrupted submit, or a finished spend) would otherwise cost a full retry
 * budget on every attempt.
 */
export async function resolveVhtlcAddressVtxos(args: {
  queryVtxos: () => Promise<VhtlcAddressVtxo[]>;
  retryAttempts: number;
  retryDelayMs: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ spendable: VhtlcAddressVtxo[]; seen: VhtlcAddressVtxo[] }> {
  const wait =
    args.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let seen: VhtlcAddressVtxo[] = [];
  for (let attempt = 1; attempt <= Math.max(1, args.retryAttempts); attempt += 1) {
    seen = (await args.queryVtxos()) ?? [];
    if (seen.length > 0) break;
    if (attempt < args.retryAttempts) await wait(args.retryDelayMs);
  }
  return { seen, spendable: seen.filter((vtxo) => !vtxo.isSpent) };
}

export type VhtlcSpendPlan = {
  /** Coins that read spent and may be the input of an interrupted submit. */
  toRecover: VhtlcAddressVtxo[];
  /** Coins that are still there to be spent by this attempt. */
  toSpend: VhtlcAddressVtxo[];
  outcome: "recover-only" | "recover-then-spend" | "spend" | "already-spent" | "not-indexed";
};

/**
 * Decide what an attempt at a VHTLC address must do.
 *
 * A spent coin does not mean the spend is done: it is also what an interrupted
 * submit looks like. So recovery runs for the spent subset on EVERY attempt,
 * including one that still has coins to spend — otherwise spending the rest
 * returns success while the interrupted input stays pending forever. Recovery
 * is expected to come back empty once the ASP has nothing pending, which is how
 * "recover-only" turns into "already-spent".
 */
export function planVhtlcSpend(seen: VhtlcAddressVtxo[]): VhtlcSpendPlan {
  const toRecover = seen.filter((vtxo) => vtxo.isSpent);
  const toSpend = seen.filter((vtxo) => !vtxo.isSpent);
  if (seen.length === 0) return { toRecover, toSpend, outcome: "not-indexed" };
  if (toSpend.length === 0) {
    return {
      toRecover,
      toSpend,
      outcome: toRecover.length > 0 ? "recover-only" : "not-indexed",
    };
  }
  return { toRecover, toSpend, outcome: toRecover.length > 0 ? "recover-then-spend" : "spend" };
}

export type VhtlcRecoveryOutcome = {
  /** The finalized pending tx, when the ASP had one and it went through. */
  txid: string | null;
  /** True when the recovery itself could not complete, so the caller must not
   * report success: a known-pending input is still out there. */
  failed: boolean;
};

export type VhtlcSpendDecision =
  | { kind: "deliver-unindexed" }
  | { kind: "abort-recovery-failed" }
  | { kind: "return-recovered"; txid: string }
  | { kind: "return-previous"; txid: string }
  | { kind: "rejected-already-spent" }
  | { kind: "spend-remaining" };

/**
 * What an attempt does after the address has been read and its pending spend
 * recovered. Kept here (not in the adapter, which cannot be imported in a test)
 * because the mixed case is the one that used to fail OPEN: recovery would fail,
 * the remaining coins would still be spent, and the action would report success
 * with an interrupted input left pending forever.
 */
export function decideVhtlcSpend(args: {
  plan: VhtlcSpendPlan;
  recovery: VhtlcRecoveryOutcome;
  /**
   * The txid this action already journaled at submit. Its presence is what makes
   * the finalize→journal crash recoverable: if the tx finalized and the process
   * died before the journal was completed, the inputs read spent, the ASP has
   * nothing pending, and this stale txid is the result the action owes.
   */
  previouslySubmittedArkTxid?: string;
}): VhtlcSpendDecision {
  const { plan, recovery } = args;
  if (plan.outcome === "not-indexed") return { kind: "deliver-unindexed" };
  if (recovery.failed) return { kind: "abort-recovery-failed" };
  if (plan.toSpend.length === 0) {
    if (recovery.txid) return { kind: "return-recovered", txid: recovery.txid };
    const previous = String(args.previouslySubmittedArkTxid || "").trim();
    if (previous) return { kind: "return-previous", txid: previous };
    return { kind: "rejected-already-spent" };
  }
  return { kind: "spend-remaining" };
}

export function vhtlcGetPendingTxMessage(): Intent.GetPendingTxMessage {
  // expire_at 0 is what the SDK sends for this message too: the proof is a
  // one-shot ownership proof, not something that should sit in the ASP.
  return { type: "get-pending-tx", expire_at: 0 };
}

/**
 * Mirrors the SDK's internal proof jobs: input 0 is an anchor input carrying the
 * first coin's script, then one input per coin, in order.
 */
export function vhtlcIntentProofJobs(coins: VhtlcPendingCoin[]): VhtlcIntentProofJob[] {
  if (coins.length === 0) return [];
  const coinJobs = coins.map((coin, i) => ({
    index: i + 1,
    lookupScript: VtxoScript.decode(coin.tapTree).pkScript,
  }));
  return [{ index: 0, lookupScript: coinJobs[0].lookupScript }, ...coinJobs];
}

/**
 * Bind one ASP-supplied checkpoint to the coin it claims to spend.
 *
 * The ASP chooses what to send back, and signing a checkpoint hands out both a
 * signature and (for a claim) the preimage witness, so an unbound checkpoint is
 * a signature for someone else's spend. Every field that decides where the money
 * goes is checked against the coin we accepted and the checkpoint script we can
 * rebuild locally: one input, that outpoint, that amount, the VHTLC script, and
 * one output locking the full value into the server-unroll + collaborative
 * closure that only this coin's leaf can open.
 */
export function assertVhtlcCheckpointBound(args: {
  checkpoint: TransactionType;
  coin: VhtlcPendingCoin;
  unrollCandidates: unknown[];
}): void {
  const { checkpoint, coin } = args;
  const fail = (reason: string): never => {
    throw new Error(`VHTLC checkpoint rejected: ${reason}`);
  };
  if (checkpoint.inputsLength !== 1) {
    fail(`spends ${checkpoint.inputsLength} inputs, expected 1`);
  }
  const spent = checkpoint.getInput(0);
  const spentTxid = spent?.txid ? hex.encode(spent.txid) : "";
  if (spentTxid !== String(coin.txid) || spent?.index !== coin.vout) {
    fail(`spends ${spentTxid}:${spent?.index ?? "?"}, expected ${coin.txid}:${coin.vout}`);
  }
  const witnessUtxo = spent?.witnessUtxo;
  if (!witnessUtxo) fail("input 0 has no witnessUtxo");
  const coinScript = VtxoScript.decode(coin.tapTree).pkScript;
  if (hex.encode(witnessUtxo.script as Uint8Array) !== hex.encode(coinScript)) {
    fail("input 0 does not spend the VHTLC script");
  }
  if (BigInt(witnessUtxo.amount) !== BigInt(coin.value)) {
    fail(`input 0 is ${witnessUtxo.amount} sats, expected ${coin.value}`);
  }
  // A real checkpoint carries the locked value plus the shared anchor output;
  // anything else is a different transaction than the one we asked for.
  if (checkpoint.outputsLength !== 1 && checkpoint.outputsLength !== 2) {
    fail(`has ${checkpoint.outputsLength} outputs, expected 1 or 2`);
  }
  const closure = decodeTapscript(scriptFromTapLeafScript(coin.intentTapLeafScript as never));
  const expectedScripts = args.unrollCandidates.map((candidate) =>
    hex.encode(
      new VtxoScript([
        (candidate as { script: Uint8Array }).script,
        (closure as { script: Uint8Array }).script,
      ]).pkScript,
    ),
  );
  if (expectedScripts.length === 0) fail("no checkpoint script to bind against");
  const output = checkpoint.getOutput(0);
  const outputScriptHex = output?.script ? hex.encode(output.script) : "";
  const matchingIndex = expectedScripts.indexOf(outputScriptHex);
  if (matchingIndex < 0) {
    fail("output 0 does not lock into the checkpoint script");
  }
  if (BigInt(output?.amount ?? 0) !== BigInt(coin.value)) {
    fail(`output 0 is ${output?.amount} sats, expected the full ${coin.value}`);
  }
  for (let index = 1; index < checkpoint.outputsLength; index += 1) {
    const extra = checkpoint.getOutput(index);
    const extraScriptHex = extra?.script ? hex.encode(extra.script) : "";
    if (extraScriptHex !== hex.encode(P2A.script) || BigInt(extra?.amount ?? 0) !== P2A.amount) {
      fail(`output ${index} is not the shared anchor output`);
    }
  }
  // Bind the transaction shape the fields above cannot express: version, locktime
  // and the input sequence do not change the script, the outpoint or the value,
  // but they change what the signature commits to. Rebuild the checkpoint for
  // this coin and compare those three against the server's copy.
  const { checkpoints: rebuilt } = buildOffchainTx(
    [
      {
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        tapLeafScript: coin.intentTapLeafScript,
        tapTree: coin.tapTree,
      } as never,
    ],
    [{ amount: BigInt(coin.value), script: output?.script as Uint8Array }],
    args.unrollCandidates[matchingIndex] as never,
  );
  const shape = rebuilt[0];
  if (!shape) fail("no checkpoint this wallet would have built");
  if (checkpoint.version !== shape.version) {
    fail(`version ${checkpoint.version}, expected ${shape.version}`);
  }
  if (checkpoint.lockTime !== shape.lockTime) {
    fail(`locktime ${checkpoint.lockTime}, expected ${shape.lockTime}`);
  }
  if (spent?.sequence !== shape.getInput(0)?.sequence) {
    fail(`input sequence ${spent?.sequence}, expected ${shape.getInput(0)?.sequence}`);
  }
}

/**
 * Recover whatever pending spend sits on `coins`, reporting whether the recovery
 * itself completed. A thrown provider error is `failed`, NOT "nothing pending":
 * the caller must keep the action retryable instead of declaring the VHTLC
 * spent and moving on.
 */
export async function recoverSpentVhtlcVtxos(args: {
  provider: VhtlcPendingProvider;
  spentCoins: VhtlcAddressVtxo[];
  toCoin: (vtxo: VhtlcAddressVtxo) => VhtlcPendingCoin;
  sign: (tx: TransactionType, inputIndexes?: number[]) => Promise<TransactionType>;
  unrollCandidates: unknown[];
  /** Journal hook, awaited per recovered tx before it is finalized. */
  onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
  onFinalized?: (arkTxid: string) => Promise<void>;
}): Promise<VhtlcRecoveryOutcome> {
  if (args.spentCoins.length === 0) return { txid: null, failed: false };
  try {
    const { finalized, blocked } = await finalizePendingVhtlcSpends({
      provider: args.provider,
      coins: args.spentCoins.map(args.toCoin),
      sign: args.sign,
      unrollCandidates: args.unrollCandidates,
      ...(args.onSubmittedArkTxid ? { onSubmittedArkTxid: args.onSubmittedArkTxid } : {}),
    });
    if (blocked.length > 0) return { txid: null, failed: true };
    if (finalized.length === 0) return { txid: null, failed: false };
    const txid = finalized[finalized.length - 1] as string;
    await args.onFinalized?.(txid);
    return { txid, failed: false };
  } catch {
    return { txid: null, failed: true };
  }
}

/**
 * Ask the ASP for the pending offchain transactions over `coins` and finalize
 * the ones whose checkpoints provably spend those coins.
 *
 * Every returned checkpoint is bound to the coin it claims to spend BEFORE it is
 * signed (the SDK's own check: one input, that outpoint, and a txid equal to the
 * checkpoint we would have built locally), because the ASP chose what to send
 * and a substituted checkpoint would otherwise harvest a signature and the claim
 * preimage for a different spend. A pending tx we cannot bind is reported as
 * `blocked`, never silently skipped: skipping it would let the caller spend the
 * rest and report a clean finish over a stranded input.
 */
export async function finalizePendingVhtlcSpends(args: {
  provider: VhtlcPendingProvider;
  coins: VhtlcPendingCoin[];
  sign: (tx: TransactionType, inputIndexes?: number[]) => Promise<TransactionType>;
  /** Decoded from the ASP's `checkpointTapscript`; what a checkpoint may lock to. */
  unrollCandidates: unknown[];
  /**
   * Journal hook: awaited with the recovered arkTxid BEFORE `finalizeTx`, so a
   * crash or a lost finalize response still leaves a durable handle for the
   * destination-credit recovery instead of a pending tx nobody knows about.
   */
  onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
}): Promise<{ finalized: string[]; blocked: string[] }> {
  const { provider, coins, sign } = args;
  if (coins.length === 0) return { finalized: [], blocked: [] };

  const message = vhtlcGetPendingTxMessage();
  const jobs = vhtlcIntentProofJobs(coins);
  const proof = Intent.create(message, coins as never, []);
  const signedProof = await sign(
    proof,
    jobs.map((job) => job.index),
  );

  const pendingTxs = await provider.getPendingTxs({
    proof: base64.encode(signedProof.toPSBT()),
    message,
  });

  const finalized: string[] = [];
  const blocked: string[] = [];
  for (const pendingTx of pendingTxs) {
    const checkpointTxs = (pendingTx.signedCheckpointTxs ?? []).map((tx) =>
      Transaction.fromPSBT(base64.decode(tx)),
    );
    if (checkpointTxs.length === 0) {
      blocked.push(pendingTx.arkTxid);
      continue;
    }
    try {
      const byOutpoint = new Map(coins.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
      for (const tx of checkpointTxs) {
        assertAllowedSighashTypes(tx);
        const spent = tx.getInput(0);
        const spentTxid = spent?.txid ? hex.encode(spent.txid as Uint8Array) : "";
        const coin = byOutpoint.get(`${spentTxid}:${spent?.index}`);
        if (!coin) throw new Error("checkpoint spends an outpoint this recovery did not ask about");
        assertVhtlcCheckpointBound({
          checkpoint: tx,
          coin,
          unrollCandidates: args.unrollCandidates,
        });
      }
    } catch {
      blocked.push(pendingTx.arkTxid);
      continue;
    }
    const finalCheckpoints = await Promise.all(
      checkpointTxs.map(async (tx) => base64.encode((await sign(tx, [0])).toPSBT())),
    );
    await args.onSubmittedArkTxid?.(pendingTx.arkTxid);
    await provider.finalizeTx(pendingTx.arkTxid, finalCheckpoints);
    finalized.push(pendingTx.arkTxid);
  }
  return { finalized, blocked };
}

/** Decode the ASP's checkpoint tapscript into the candidate a checkpoint may use. */
export function vhtlcCheckpointUnrollCandidates(checkpointTapscriptHex: string): unknown[] {
  const raw = String(checkpointTapscriptHex || "").trim();
  if (!raw) return [];
  return [CSVMultisigTapscript.decode(hex.decode(raw))];
}

/**
 * Positive evidence that an arkTxid was finalized: the ASP credits an offchain
 * tx's outputs as VTXOs whose txid IS that txid, so a VTXO at the destination
 * script proves the spend landed. A stale journaled txid alone is not evidence:
 * a finalize that was rejected also leaves the inputs spent with nothing pending.
 */
export async function arkTxidCreditedAtScript(args: {
  indexerProvider: { getVtxos(query: { scripts: string[] }): Promise<{ vtxos?: unknown[] }> };
  arkTxid: string;
  outputScriptHex: string;
}): Promise<boolean> {
  const txid = String(args.arkTxid || "").trim();
  if (!txid) return false;
  const { vtxos } = await args.indexerProvider.getVtxos({ scripts: [args.outputScriptHex] });
  return (vtxos ?? []).some((vtxo) => String((vtxo as { txid?: unknown })?.txid || "") === txid);
}
