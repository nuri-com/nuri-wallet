// Who an Arkade payment was with. History rows carry amounts, not addresses,
// but the payment itself names them: its outputs (who got paid) and, one step
// back through the checkpoint Arkade puts in front of every payment, the coin
// that was spent (who paid). Matching those against saved contacts names them.
import { ArkAddress } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";

export type VirtualTxIndexer = {
  getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
};

/** Scripts (hex) on each side of a payment, this wallet's own left out. */
export type Counterparty = { paidFrom: string[]; paidTo: string[] };

// Indexer requests stay small; a long history is read in several.
const BATCH = 50;

const parse = (psbt: string): Transaction =>
  Transaction.fromPSBT(base64.decode(psbt), {
    allowUnknown: true,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });

// Only 34-byte taproot scripts are addresses; the anchor output is not.
const isAddressScript = (script: Uint8Array | undefined): script is Uint8Array =>
  Boolean(script && script.length === 34);

const outputScripts = (tx: Transaction): string[] => {
  const out: string[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const script = tx.getOutput(i).script;
    if (isAddressScript(script)) out.push(hex.encode(script));
  }
  return out;
};

const spentScripts = (tx: Transaction): string[] => {
  const out: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const script = tx.getInput(i).witnessUtxo?.script;
    if (isAddressScript(script)) out.push(hex.encode(script));
  }
  return out;
};

const spentTxids = (tx: Transaction): string[] => {
  const out: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const id = tx.getInput(i).txid;
    if (id) out.push(hex.encode(id));
  }
  return out;
};

async function fetchTxs(indexer: VirtualTxIndexer, txids: string[]): Promise<Transaction[]> {
  const out: Transaction[] = [];
  for (let i = 0; i < txids.length; i += BATCH) {
    const { txs } = await indexer.getVirtualTxs(txids.slice(i, i + BATCH));
    out.push(...txs.map(parse));
  }
  return out;
}

// Per txid, for the life of the app: a payment never changes once made. Kept
// unfiltered, because the wallet can be replaced in-process and the next one
// may have been on either side of the same payment.
const cache = new Map<string, Counterparty>();

const excluding = (party: Counterparty, own: ReadonlySet<string>): Counterparty => ({
  paidFrom: party.paidFrom.filter((s) => !own.has(s)),
  paidTo: party.paidTo.filter((s) => !own.has(s)),
});

/**
 * Both sides of each Arkade payment, keyed by arkTxid (lowercase). Reads the
 * payments and their checkpoints from the indexer; known txids come from
 * memory. Any failure leaves txids out: an unnamed row is fine, a wrong name
 * is not.
 */
export async function arkadeCounterparties(
  indexer: VirtualTxIndexer,
  txids: string[],
  ownScripts: ReadonlySet<string>,
): Promise<Map<string, Counterparty>> {
  const result = new Map<string, Counterparty>();
  const missing: string[] = [];
  for (const txid of new Set(txids.map((t) => t.toLowerCase()))) {
    const known = cache.get(txid);
    if (known) result.set(txid, excluding(known, ownScripts));
    else missing.push(txid);
  }
  if (missing.length === 0) return result;
  try {
    const payments = await fetchTxs(indexer, missing);
    const checkpoints = await fetchTxs(indexer, [...new Set(payments.flatMap(spentTxids))]);
    const spentByCheckpoint = new Map<string, string[]>();
    for (const cp of checkpoints) spentByCheckpoint.set(cp.id.toLowerCase(), spentScripts(cp));
    for (const tx of payments) {
      const party: Counterparty = {
        paidFrom: [...new Set(spentTxids(tx).flatMap((id) => spentByCheckpoint.get(id) ?? []))],
        paidTo: [...new Set(outputScripts(tx))],
      };
      const id = tx.id.toLowerCase();
      cache.set(id, party);
      result.set(id, excluding(party, ownScripts));
    }
  } catch {}
  return result;
}

/** The output script (hex) of an Ark address, or null when it is not one. */
export function arkAddressScript(address: string): string | null {
  try {
    return hex.encode(ArkAddress.decode(address.trim()).pkScript).toLowerCase();
  } catch {
    return null;
  }
}
