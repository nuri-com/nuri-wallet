// The one-time copy of rows an older build kept in its own lists.
//
// Before the one list, purchases, stablecoin transfers and bitcoin sends each
// had their own pending store. The screens now read only the one list, so a
// move that was in flight across the update would vanish from every screen
// while still running. This copies each still-active old row into the one list,
// by the same id its done rule checks, and the done watcher retires it like
// any other. Idempotent: an id already listed is left alone.
import { PendingPurchasesStore, type PendingPurchase } from "../app/PendingPurchasesStore";
import { PendingWalletTransfersStore } from "../balance/PendingWalletTransfersStore";
import {
  type PendingBitcoinSend,
  PendingBitcoinSendsStore,
} from "../bitcoin/PendingBitcoinSendsStore";
import type { PendingWalletTransfer } from "../../types/wallet";
import { pendingTransferView } from "../../screens/home/pendingRails";
import { MoneyInFlightStore, type MoneyInFlight, type MoneyRail } from "./MoneyInFlightStore";

const iso = (value: unknown): string => {
  const at = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString();
};

export function purchaseAsInFlight(row: PendingPurchase): MoneyInFlight | null {
  const sats = Number(row.amountSats);
  if (!row.id || !(sats > 0)) return null;
  return {
    id: row.id,
    from: null,
    to: { rail: "onchain", amount: sats, unit: "sats" },
    kind: "purchase",
    createdAt: iso(row.createdAt),
  };
}

export function bitcoinSendAsInFlight(row: PendingBitcoinSend): MoneyInFlight | null {
  const sats = Number(row.amountSats);
  if (!row.txid || !(sats > 0)) return null;
  const rail: MoneyRail = row.source === "onchain" ? "onchain" : "arkade";
  return {
    id: row.txid,
    from: { rail, amount: sats, unit: "sats" },
    to: null,
    kind: "send",
    createdAt: iso(row.createdAt),
  };
}

export function walletTransferAsInFlight(row: PendingWalletTransfer): MoneyInFlight | null {
  const amount = Number(row.amount);
  if (!(amount > 0)) return null;
  const fiat = row.fiat === "USD" ? "USD" : "EUR";
  const wallet: MoneyRail = fiat === "USD" ? "dollar" : "wallet";
  const card: MoneyRail = fiat === "USD" ? "visaUsd" : "visa";
  const createdAt = iso(row.createdAt);
  // A swap row: the order id is what its done rule asks the order store.
  if (row.orderId) {
    // Old rows carry no direction: the same rule that drew them decides it
    // (a top-up or sweep row is money arriving).
    const incoming = pendingTransferView(row).incoming;
    const leg = { rail: wallet, amount, unit: fiat } as const;
    return {
      id: row.orderId,
      from: incoming ? null : leg,
      to: incoming ? leg : null,
      kind: "swap",
      createdAt,
    };
  }
  // A plain transfer: its Base tx hash is what its done rule checks.
  if (row.txHash && /^0x[0-9a-fA-F]{64}$/.test(row.txHash)) {
    if (row.kind === "card_topup") {
      return {
        id: row.txHash,
        from: { rail: wallet, amount, unit: fiat },
        to: { rail: card, amount, unit: fiat },
        kind: "card_topup",
        createdAt,
      };
    }
    return {
      id: row.txHash,
      from: { rail: wallet, amount, unit: fiat },
      to: null,
      kind: "send",
      createdAt,
    };
  }
  return null;
}

let adopted = false;

/** Copies still-active old rows into the one list, once per app run. */
export async function adoptLegacyInFlight(): Promise<void> {
  if (adopted) return;
  const records: MoneyInFlight[] = [];
  try {
    await PendingPurchasesStore.hydrate();
    for (const row of PendingPurchasesStore.list()) {
      const record = purchaseAsInFlight(row);
      if (record) records.push(record);
    }
    for (const row of await PendingBitcoinSendsStore.list()) {
      const record = bitcoinSendAsInFlight(row);
      if (record) records.push(record);
    }
    for (const row of await PendingWalletTransfersStore.list()) {
      const record = walletTransferAsInFlight(row);
      if (record) records.push(record);
    }
  } catch {
    // Retried on the next check.
    return;
  }
  // Two old rows for one order (its out and in legs) become one record.
  const byId = new Map<string, MoneyInFlight>();
  for (const record of records) {
    const prior = byId.get(record.id);
    byId.set(
      record.id,
      prior ? { ...prior, from: prior.from ?? record.from, to: prior.to ?? record.to } : record,
    );
  }
  await MoneyInFlightStore.adoptMissing([...byId.values()]);
  adopted = true;
}

export function _resetLegacyAdoptionForTests(): void {
  adopted = false;
}
