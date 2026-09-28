import { describe, expect, it } from "vitest";

import type { PendingWalletTransfer } from "../../types/wallet";
import { mirroredOrderIds, pendingTransferView } from "./pendingRails";

const row = (fields: Partial<PendingWalletTransfer>): PendingWalletTransfer => ({
  amount: 10,
  createdAt: new Date().toISOString(),
  kind: "wallet_transfer",
  ...fields,
});

describe("pendingTransferView", () => {
  // The destination mirror of a BTC→stable order is money ARRIVING. Drawn as a
  // debit it told the user the rail they are buying into is being emptied.
  it("reads a BTC→EURC mirror as euros coming in", () => {
    expect(pendingTransferView(row({ fiat: "EUR", source: "swapkit_topup" }))).toEqual({
      rail: "wallet",
      incoming: true,
      label: "fromBitcoin",
    });
  });

  it("reads a BTC→USDC mirror as dollars coming in", () => {
    expect(pendingTransferView(row({ fiat: "USD", source: "swapkit_topup" }))).toEqual({
      rail: "dollar",
      incoming: true,
      label: "fromBitcoin",
    });
  });

  it("reads an other-chain sweep as an incoming receipt", () => {
    expect(pendingTransferView(row({ fiat: "EUR", source: "swapkit_sweep" }))).toMatchObject({
      incoming: true,
      label: "receiving",
    });
  });

  it("keeps every wallet-funded transfer outgoing, on the rail that pays", () => {
    expect(pendingTransferView(row({ fiat: "USD", source: "base-mainnet" }))).toEqual({
      rail: "dollar",
      incoming: false,
      label: "sending",
    });
    expect(pendingTransferView(row({ kind: "card_topup", source: "base-mainnet" }))).toEqual({
      rail: "wallet",
      incoming: false,
      label: "toCard",
    });
    // An EURC→BTC swap spends the euro wallet: outgoing, whatever its tag.
    expect(pendingTransferView(row({ fiat: "EUR", source: "swapkit" }))).toMatchObject({
      incoming: false,
      label: "sending",
    });
  });

  it("puts a row that states no currency on the euro rail", () => {
    expect(pendingTransferView(row({}))).toMatchObject({ rail: "wallet" });
  });

  it("honors an explicit direction for a stable→stable swap's two legs", () => {
    // The source leg debits the rail it spends…
    expect(
      pendingTransferView(row({ fiat: "EUR", source: "swapkit", direction: "out" })),
    ).toMatchObject({ rail: "wallet", incoming: false, label: "sending" });
    // …and the destination leg credits the rail it lands on — same source tag,
    // opposite direction. Inferring from `source` alone could never tell these
    // apart, which is why both rails showed nothing before.
    expect(
      pendingTransferView(row({ fiat: "USD", source: "swapkit", direction: "in" })),
    ).toMatchObject({ rail: "dollar", incoming: true, label: "receiving" });
  });
});

describe("mirroredOrderIds", () => {
  // One order, two records: the sats leaving (the durable purchase) and the
  // stable arriving (the mirror). Only the mirror knows which currency lands.
  it("names the orders whose arriving side a mirror already states", () => {
    const ids = mirroredOrderIds([
      row({ fiat: "USD", source: "swapkit_topup", orderId: "sk_usd" }),
      row({ fiat: "EUR", source: "swapkit_topup", orderId: "sk_eur" }),
      row({ fiat: "EUR", source: "base-mainnet", orderId: "sent_1" }),
      row({ fiat: "EUR", source: "swapkit_topup", orderId: null }),
    ]);

    expect([...ids].sort()).toEqual(["sk_eur", "sk_usd"]);
  });
});
