// Bitcoin history rows as activity-list entries. The Bitcoin activity sheet
// and a contact's page in the address book (#1793) both build their rows
// here, so a payment reads the same in both.
import { Linking } from "react-native";
import type { ActivityItem } from "../../components/ActivitySheet";
import { mempoolTxUrl } from "../../config/endpoints";
import { singleInputAddress } from "../../lib/activityNames";
import { classifyTransaction } from "../../lib/bitcoin/convert";
import { mergeRailsOneRowPerTx, withoutOwnBoardingLegs } from "../../lib/bitcoin/combinedRails";
import { t } from "../../lib/i18n";
import { formatActivityTime } from "../../lib/transactionRowUtils";
import type { UnifiedTransaction } from "../arkade/ArkadeTransactionHistoryService";
import { priceService } from "../pricing/PriceService";
import { type Legs, swapRow } from "../swapkit/swapActivity";
import type { BitcoinTransactionsResult, LegacyOnchainTx } from "./BitcoinTransactionsService";

/** The Arkade rows of a history read, as the lists keep them. */
export function arkadeHistoryRows(rows: BitcoinTransactionsResult["rows"]): UnifiedTransaction[] {
  const out: UnifiedTransaction[] = [];
  for (const row of rows) {
    if (row.source !== "arkade") continue;
    out.push({
      id: row.id,
      type: row.type,
      amountSats: row.amountSats,
      timestamp: row.timestamp,
      status: row.status,
      source: "arkade",
      kind: row.kind,
      txid: row.txid,
      isMigrationTx: row.isMigrationTx,
      counterpartyScripts: row.counterpartyScripts,
      // Kept so the combined history can tell an Arkade deposit is the
      // same movement as an onchain transfer.
      ...(row.boarding ? { boarding: true as const } : {}),
      ...(row.boardingTxid ? { boardingTxid: row.boardingTxid } : {}),
      ...(row.counterpartyAddresses ? { counterpartyAddresses: row.counterpartyAddresses } : {}),
    });
  }
  return out;
}

/**
 * The onchain rows one list shows. Rows carry the address they were read for,
 * and that address decides the rail: the boarding address belongs to the
 * arkade wallet (deposits on their way in), the MuSig2 addresses to the
 * onchain one. The combined Bitcoin list ("bitcoin") keeps both, once each.
 */
export function bitcoinListTxs({
  txs,
  rail,
  railAddresses,
  ownAddresses,
  address,
  boardingDepositTxids,
}: {
  txs: readonly LegacyOnchainTx[];
  rail?: string;
  /** This list's own addresses, lowercased. */
  railAddresses: ReadonlySet<string>;
  ownAddresses: string[];
  /** The address the history is read for (boarding). */
  address: string;
  /** Onchain transactions an Arkade deposit already accounts for. */
  boardingDepositTxids: string[];
}): LegacyOnchainTx[] {
  const rows = txs.filter(({ address: txAddress }) => {
    if (!rail) return true;
    if (railAddresses.size === 0) return true;
    // A row belongs here exactly when it was read for one of this rail's
    // addresses: boarding for arkade, the MuSig2 address for onchain.
    return railAddresses.has(
      String(txAddress || "")
        .trim()
        .toLowerCase(),
    );
  });
  if (rail !== "bitcoin") return rows;
  // Both rails in one list. A deposit into Arkade is already shown arriving by
  // its Arkade row, so its onchain leg goes; a transfer between the wallet's
  // own addresses is read once per address and stays once.
  return mergeRailsOneRowPerTx(
    withoutOwnBoardingLegs(rows, ownAddresses, boardingDepositTxids),
    address,
  );
}

type ItemContext = {
  /** The display currency's symbol; each row is priced at its own time in it. */
  homeSym: string;
  swapLegs: Legs;
};

/** An Arkade row (off-chain, Lightning, boarding) as an activity entry. */
export function arkadeActivityItem(
  atx: UnifiedTransaction,
  { homeSym, swapLegs }: ItemContext,
): ActivityItem {
  const isIncoming = atx.type === "received";
  const sign = isIncoming ? "" : "-";
  // Anything not finalized stays pending: Arkade may reject a fresh
  // preconfirmed VTXO when a spend requires settlement.
  const isPending = atx.status !== "confirmed";
  const unixSeconds = atx.timestamp ? Math.floor(atx.timestamp / 1000) : null;
  const timeStr = formatActivityTime(null, unixSeconds);
  const subtitle = isPending ? "Pending" : timeStr;
  const title = isIncoming ? "Received Bitcoin" : "Send Bitcoin";

  let fiatLine: string | null = null;
  if (!isPending && unixSeconds) {
    const fiatPrice = priceService.getCachedPriceAt(unixSeconds, homeSym);
    if (typeof fiatPrice === "number") {
      const fiatValue = (atx.amountSats / 1e8) * fiatPrice;
      fiatLine = `${sign}${homeSym} ${fiatValue.toFixed(2)}`;
    }
  }

  const _createdAt = atx.timestamp
    ? new Date(atx.timestamp).toISOString()
    : new Date().toISOString();
  const swap = swapRow(swapLegs, atx.id, isIncoming);
  // A boarding deposit's own transaction is on the chain: its explorer
  // belongs to this row, which is the one the combined history keeps for
  // a transfer into Arkade.
  const boardingExplorer =
    atx.boarding && atx.boardingTxid
      ? () => Linking.openURL(`${mempoolTxUrl(String(atx.boardingTxid))}?mode=details`)
      : null;
  return {
    key: atx.id,
    icon: atx.isMigrationTx ? "transfer-horizontal" : isIncoming ? "plus" : "arrow-up",
    sublabel: subtitle,
    label: atx.isMigrationTx ? "Migration" : (swap?.title ?? title),
    ...(swap?.image ? { image: swap.image } : {}),
    ...(swap?.sides ? { swap: swap.sides } : {}),
    ...(boardingExplorer
      ? {
          onPress: boardingExplorer,
          onPressLabel: t("component.ActivityRowActions.viewOnMempool"),
        }
      : {}),
    amount: `${sign}BTC ${atx.amountSats}`,
    amountSecondary: fiatLine ?? `${homeSym} —`,
    pending: isPending,
    createdAt: _createdAt,
    incoming: isIncoming,
    counterpartyScripts: atx.counterpartyScripts,
    ...(atx.counterpartyAddresses ? { counterpartyAddresses: atx.counterpartyAddresses } : {}),
  };
}

/** An onchain row as an activity entry. */
export function onchainActivityItem(
  { tx, address: txAddress }: LegacyOnchainTx,
  { homeSym, swapLegs, railAddresses }: ItemContext & { railAddresses: ReadonlySet<string> },
): ActivityItem {
  const mempoolLabel = t("component.ActivityRowActions.viewOnMempool");
  const isPending = !tx?.status?.confirmed;
  const display = classifyTransaction(tx, txAddress);
  const isIncoming = display.isIncoming;
  const amountSats = display.amountSats;

  const blockTime = tx?.status?.block_time;
  const txTime = formatActivityTime(null, blockTime);
  const subtitle = isPending ? "Pending" : txTime;
  const title = isIncoming ? "Received Bitcoin" : "Send Bitcoin";
  const _createdAt = blockTime
    ? new Date(blockTime * 1000).toISOString()
    : new Date().toISOString();

  const onOpenExplorer = () => {
    const url = `${mempoolTxUrl(tx.txid)}?mode=details`;
    Linking.openURL(url);
  };

  const sign = isIncoming ? "" : "-";
  let fiatLine: string | null = null;
  if (!isPending && tx?.status?.block_time) {
    const fiatPrice = priceService.getCachedPriceAt(tx.status?.block_time as number, homeSym);
    if (typeof fiatPrice === "number") {
      const fiatValue = (amountSats / 1e8) * fiatPrice;
      fiatLine = `${sign}${homeSym} ${fiatValue.toFixed(2)}`;
    }
  }

  // Who a send paid: its one output that is not this wallet's own. A send
  // with several such outputs names no single recipient to save.
  const paidTo = isIncoming
    ? []
    : (tx.vout || [])
        .map((o: { scriptpubkey_address?: string }) => o?.scriptpubkey_address || "")
        // Never the wallet's own addresses: a transfer between its rails
        // (or change) has no recipient to save.
        .filter((a: string) => a && a !== txAddress && !railAddresses.has(a.toLowerCase()));
  // A swap's deposit address is the swap, never someone to save.
  const swap = swapRow(swapLegs, tx.txid, isIncoming);
  const recipient = paidTo.length === 1 && !swap ? paidTo[0] : null;
  // Who paid a receive: the one address its inputs came from, when it is
  // not this wallet's own. The names lookup may know them (#1782).
  const sender =
    isIncoming && !swap ? singleInputAddress(tx.vin, [txAddress, ...railAddresses]) : null;
  return {
    // Address-scoped: a transfer between the two onchain rails appears in
    // both histories, once as a send and once as a receive.
    key: `${txAddress}:${tx.txid}`,
    icon: isIncoming ? "plus" : "arrow-up",
    sublabel: subtitle,
    label: swap?.title ?? title,
    ...(swap?.image ? { image: swap.image } : {}),
    ...(swap?.sides ? { swap: swap.sides } : {}),
    onPress: onOpenExplorer,
    onPressLabel: mempoolLabel,
    saveOffer: recipient
      ? { destination: { type: "crypto", raw: recipient, network: "bitcoin", asset: "BTC" } }
      : null,
    ...(sender ? { counterpartyAddress: sender } : {}),
    amount: `${sign}BTC ${amountSats}`,
    amountSecondary: fiatLine ?? `${homeSym} —`,
    pending: isPending,
    createdAt: _createdAt,
    incoming: isIncoming,
  };
}
