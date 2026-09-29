import { base64, hex } from "@scure/base";
import { Batch, Intent, Transaction, type Transaction as TransactionType } from "@arkade-os/sdk";

/**
 * Refund a VHTLC whose VTXO the Arkade operator has already swept.
 *
 * Once a lock's batch expires the operator sweeps it, and the offchain spend the
 * normal refund uses is refused for good (`VTXO_RECOVERABLE`). A swept coin can
 * only leave by joining a settlement batch: the operator skips the forfeit and
 * the timelock-script checks for it and verifies only the owners' signatures on
 * the intent. So the refund registers a batch intent that spends the swept coin
 * through the same `refundWithoutReceiver` leaf the offchain refund uses, signed
 * with the same swap key, paying the full value to the bound refund address.
 *
 * Kept free of the wallet so the request it builds can be tested: the caller
 * supplies the provider, the swap-key signer, a tree-signing session and the
 * batch handler.
 */

/** A swept VHTLC coin as the indexer reports it. */
export type SweptVhtlcVtxo = {
  txid: string;
  vout: number;
  value: number;
  isSwept?: boolean;
  isSpent?: boolean;
  isUnrolled?: boolean;
  createdAt?: Date | string | number;
  virtualStatus?: unknown;
};

/** The coin shape the batch intent and the SDK's batch handler read. */
export type SweptVhtlcCoin = {
  txid: string;
  vout: number;
  value: number;
  /** pkScript hex: marks the input as a virtual coin for the batch handler. */
  script: string;
  tapTree: Uint8Array;
  intentTapLeafScript: unknown;
  forfeitTapLeafScript: unknown;
  isSwept: true;
  isSpent: false;
  isUnrolled: false;
  createdAt: Date;
  virtualStatus: unknown;
};

/** Unspent coins the operator swept: the ones only a batch can move. */
export function sweptUnspentVtxos(vtxos: SweptVhtlcVtxo[]): SweptVhtlcVtxo[] {
  return vtxos.filter((vtxo) => vtxo.isSwept === true && !vtxo.isSpent && !vtxo.isUnrolled);
}

export function toSweptVhtlcCoin(
  vtxo: SweptVhtlcVtxo,
  lock: { pkScriptHex: string; tapTree: Uint8Array; refundLeaf: unknown },
): SweptVhtlcCoin {
  return {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: Number(vtxo.value),
    script: lock.pkScriptHex,
    tapTree: lock.tapTree,
    intentTapLeafScript: lock.refundLeaf,
    forfeitTapLeafScript: lock.refundLeaf,
    isSwept: true,
    isSpent: false,
    isUnrolled: false,
    createdAt: new Date(vtxo.createdAt ?? 0),
    virtualStatus: vtxo.virtualStatus ?? { state: "swept" },
  };
}

/** The register message: one offchain output, tree cosigned by `cosignerPubkeyHex`. */
export function sweptRefundRegisterMessage(cosignerPubkeyHex: string): Intent.RegisterMessage {
  return {
    type: "register",
    onchain_output_indexes: [],
    valid_at: 0,
    expire_at: 0,
    cosigners_public_keys: [cosignerPubkeyHex],
  };
}

/** Input 0 is the proof's anchor, then one input per coin; the swap key signs all. */
export function sweptRefundSigningIndexes(coinCount: number): number[] {
  return Array.from({ length: coinCount + 1 }, (_, i) => i);
}

export type SweptRefundProvider = {
  registerIntent(intent: { proof: string; message: Intent.RegisterMessage }): Promise<string>;
  deleteIntent(intent: { proof: string; message: Intent.DeleteMessage }): Promise<void>;
  getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<unknown>;
};

export type SweptRefundSession = {
  getPublicKey(): Promise<Uint8Array>;
};

export type SweptRefundDeps = {
  provider: SweptRefundProvider;
  /** Signs with the swap key (the VHTLC's sender). */
  sign: (tx: TransactionType, inputIndexes?: number[]) => Promise<TransactionType>;
  session: SweptRefundSession;
  createBatchHandler: (
    intentId: string,
    inputs: SweptVhtlcCoin[],
    recipients: { address: string; amount: number }[],
    session: SweptRefundSession,
  ) => Batch.Handler;
  /**
   * Journal hook, awaited with the commitment txid at batch finalization —
   * before this wallet sends anything back and before join returns — so a
   * crash after the coin is spent still leaves a replay handle.
   */
  onCommitment?: (commitmentTxid: string) => Promise<void>;
  /** Defaults to the SDK's `Batch.join`. */
  join?: typeof Batch.join;
  /** How long to wait for a batch to include the intent. */
  timeoutMs?: number;
};

/**
 * Register the swept coins in a batch and return the commitment txid.
 * The whole value goes to `destinationAddress`: Arkade charges no intent fee on
 * recoverable inputs today, and a fee would make the operator refuse the intent
 * rather than take a different amount, so nothing is guessed here.
 */
export async function settleSweptVhtlcRefund(
  args: {
    coins: SweptVhtlcCoin[];
    destinationAddress: string;
    destinationScript: Uint8Array;
  },
  deps: SweptRefundDeps,
): Promise<string> {
  const { coins } = args;
  if (coins.length === 0) throw new Error("swept refund has no coins to settle");
  const total = coins.reduce((sum, coin) => sum + Number(coin.value), 0);
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error("swept refund total is not a positive integer");
  }

  const cosignerPubkey = hex.encode(await deps.session.getPublicKey());
  const message = sweptRefundRegisterMessage(cosignerPubkey);
  const outputs = [{ amount: BigInt(total), script: args.destinationScript }];
  const indexes = sweptRefundSigningIndexes(coins.length);
  const registerProof = await deps.sign(Intent.create(message, coins as never, outputs), indexes);
  const deleteMessage: Intent.DeleteMessage = { type: "delete", expire_at: 0 };
  const deleteProof = await deps.sign(Intent.create(deleteMessage, coins as never, []), indexes);
  const intent = { proof: base64.encode(registerProof.toPSBT()), message };
  const deleteIntent = { proof: base64.encode(deleteProof.toPSBT()), message: deleteMessage };

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), deps.timeoutMs ?? 5 * 60_000);
  const topics = [cosignerPubkey, ...coins.map((coin) => `${coin.txid}:${coin.vout}`)];
  let committed = false;
  try {
    const stream = deps.provider.getEventStream(abortController.signal, topics);
    let intentId: string;
    try {
      intentId = await deps.provider.registerIntent(intent);
    } catch (error) {
      // A lingering intent from an earlier attempt holds these inputs.
      if (!String((error as Error)?.message || "").includes("duplicated input")) throw error;
      await deps.provider.deleteIntent(deleteIntent);
      intentId = await deps.provider.registerIntent(intent);
    }
    const inner = deps.createBatchHandler(
      intentId,
      coins,
      [{ address: args.destinationAddress, amount: total }],
      deps.session,
    );
    const handler: Batch.Handler = {
      ...inner,
      onBatchFinalization: async (event, vtxoTree, connectorTree) => {
        const commitmentTxid = Transaction.fromPSBT(base64.decode(event.commitmentTx)).id;
        await deps.onCommitment?.(commitmentTxid);
        return inner.onBatchFinalization?.(event, vtxoTree, connectorTree);
      },
    };
    const join = deps.join ?? Batch.join;
    const commitmentTxid = await join(stream as never, handler, { abortController });
    committed = true;
    return commitmentTxid;
  } finally {
    clearTimeout(timer);
    abortController.abort();
    if (!committed) await deps.provider.deleteIntent(deleteIntent).catch(() => {});
  }
}
