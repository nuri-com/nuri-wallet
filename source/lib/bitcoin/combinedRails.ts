import type { AddressTx } from "../../types/bitcoin";
import type { LegacyOnchainTx } from "../../services/bitcoin/BitcoinTransactionsService";
import { classifyTransaction } from "./convert";

function txidOf(entry: LegacyOnchainTx): string {
  return String(entry.tx?.txid || "")
    .trim()
    .toLowerCase();
}

/**
 * One timeline for the two bitcoin rails.
 *
 * A transaction hash is not an event key on its own. One transaction can pay
 * the wallet at two of its addresses: two separate receipts, both kept. One
 * transfer between the wallet's own accounts is read once per address, as a
 * send on one and a receive on the other: one movement, shown once. And a
 * transaction that pays a recipient AND fills the wallet's own account states
 * two movements, so its send and its receipt both stay.
 */
export function mergeRailsOneRowPerTx(
  rows: readonly LegacyOnchainTx[],
  ownAddress: string,
): LegacyOnchainTx[] {
  const own = new Set(
    [ownAddress, ...rows.map((entry) => entry.address)]
      .map((address) =>
        String(address || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const groups = new Map<string, LegacyOnchainTx[]>();
  for (const entry of rows) {
    const txid = txidOf(entry);
    if (!txid) continue;
    const group = groups.get(txid);
    if (group) group.push(entry);
    else groups.set(txid, [entry]);
  }
  const kept = new Map<string, LegacyOnchainTx[]>();
  for (const [txid, group] of groups) {
    if (group.length === 1) {
      kept.set(txid, group);
      continue;
    }
    const read = group.map((entry) => ({
      entry,
      incoming: classifyTransaction(entry.tx, entry.address).isIncoming,
    }));
    const incoming = read.filter((row) => row.incoming);
    const outgoing = read.filter((row) => !row.incoming);
    // Every row incoming: the one transaction made several separate receipts.
    if (outgoing.length === 0) {
      kept.set(txid, group);
      continue;
    }
    // One spend read for several of the wallet's addresses is one spend.
    if (incoming.length === 0) {
      kept.set(txid, [outgoing[0].entry]);
      continue;
    }
    // Send and receive of one transaction. When it pays nobody but the wallet,
    // it is a transfer between its own accounts and the arrival is the row that
    // says where the money now is. When it also pays someone else, the payment
    // and the deposit are two statements and both stay.
    if (paysOnlyOwnAddresses(group[0].tx, own)) {
      const arrival = incoming.find((row) => row.entry.address === ownAddress) ?? incoming[0];
      kept.set(txid, [arrival.entry]);
      continue;
    }
    kept.set(txid, [outgoing[0].entry, ...incoming.map((row) => row.entry)]);
  }
  // Original order, each transaction at its first appearance. A row with no
  // txid cannot be matched to another, so it always stands on its own.
  return rows.flatMap((entry) => {
    const txid = txidOf(entry);
    if (!txid) return [entry];
    const group = kept.get(txid);
    if (!group) return [];
    kept.delete(txid);
    return group;
  });
}

/** True when every paying output of the tx goes to one of the wallet's own addresses. */
function paysOnlyOwnAddresses(tx: AddressTx, ownAddresses: ReadonlySet<string>): boolean {
  const outputs = (tx?.vout ?? []).filter((output) => (output?.value ?? 0) > 0);
  if (outputs.length === 0) return false;
  return outputs.every((output) => {
    const address = String(output?.scriptpubkey_address || "")
      .trim()
      .toLowerCase();
    return address !== "" && ownAddresses.has(address);
  });
}

/**
 * A deposit into Arkade is one movement. The Arkade history shows it arriving,
 * and the onchain history shows the same transaction leaving the wallet's
 * onchain account, so the combined list would state it twice. Only the
 * outgoing leg goes, and only when the transaction pays nobody but the wallet:
 * an incoming row sharing that hash is a separate receipt at another of the
 * wallet's addresses, and must stay, as must a transaction that pays someone
 * else.
 */
export function withoutOwnBoardingLegs(
  rows: readonly LegacyOnchainTx[],
  ownAddresses: readonly string[],
  boardingTxids: readonly string[],
): LegacyOnchainTx[] {
  const deposits = new Set(
    boardingTxids
      .map((txid) =>
        String(txid || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  if (deposits.size === 0) return [...rows];
  const own = new Set(
    ownAddresses
      .map((address) =>
        String(address || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  return rows.filter((entry) => {
    if (!deposits.has(txidOf(entry))) return true;
    // A receipt is money in its own right, whatever else the transaction did.
    if (classifyTransaction(entry.tx, entry.address).isIncoming) return true;
    return !paysOnlyOwnAddresses(entry.tx, own);
  });
}
