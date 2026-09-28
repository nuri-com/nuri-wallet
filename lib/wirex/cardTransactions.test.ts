import { describe, expect, it, vi } from "vitest";
import type { FxRates } from "../../services/pricing/FxRateService";
import type { WirexActivityItem } from "./cardTransactions";

vi.mock("../i18n", () => ({
  t: (key: string) => key,
}));

vi.mock("../transactionRowUtils", () => ({
  formatActivityTime: (iso?: string | null) => (iso ? iso.slice(11, 16) : ""),
  withTxTime: (time: string, subtitle: string) =>
    time && subtitle ? `${time} · ${subtitle}` : time || subtitle,
}));

const { eurSubtitle, mapWirexBankActivity, mapWirexCardTransactions, wirexFiatCode } = await import(
  "./cardTransactions"
);

const rates: FxRates = {
  EUR: 1.25,
  GBP: 1.5,
  USD: 1,
};

const baseItem = (overrides: Partial<WirexActivityItem>): WirexActivityItem => ({
  id: "tx-1",
  created_at: "2026-01-01T10:00:00.000Z",
  type: "CardTransaction",
  direction: "Outbound",
  status: "Completed",
  source: { type: "Wallet" },
  destination: { type: "Merchant", merchant: { name: "Coffee", mcc: "5812" } },
  source_amount: { amount: 12.5, token_symbol: "WEUR" },
  ...overrides,
});

describe("wirexFiatCode", () => {
  it("prefers supported ISO currencies and otherwise derives token pegs", () => {
    expect(wirexFiatCode({ amount: 1, currency: "GBP", token_symbol: "WEUR" })).toBe("GBP");
    expect(wirexFiatCode({ amount: 1, token_symbol: "WEUR" })).toBe("EUR");
    expect(wirexFiatCode({ amount: 1, token_symbol: "WGBP" })).toBe("GBP");
    expect(wirexFiatCode({ amount: 1, token_symbol: "USDC" })).toBe("USD");
    expect(wirexFiatCode(undefined)).toBeNull();
  });
});

describe("eurSubtitle", () => {
  it("uses injected rates to convert non-EUR amounts and skips EUR/unknown amounts", () => {
    expect(eurSubtitle(10, "USD", "-", rates)).toBe("-EUR 8.00");
    expect(eurSubtitle(10, "EUR", "-", rates)).toBeUndefined();
    expect(eurSubtitle(10, null, "-", rates)).toBeUndefined();
    expect(eurSubtitle(10, "USD", "-", undefined)).toBeUndefined();
  });
});

describe("mapWirexCardTransactions", () => {
  it("maps debit and credit card rows with fiat codes and injected-rate EUR subtitles", () => {
    const rows = mapWirexCardTransactions(
      [
        baseItem({
          id: "debit",
          source_amount: { amount: 10, token_symbol: "USDC" },
        }),
        baseItem({
          id: "credit",
          direction: "Inbound",
          source: { type: "Merchant", merchant: { name: "Refund Shop" } },
          destination: { type: "Cards" },
          destination_amount: { amount: 4, currency: "GBP" },
        }),
      ],
      rates,
    );

    expect(rows.map((row) => row.key)).toEqual(["debit", "credit"]);
    expect(rows[0]).toMatchObject({
      label: "Coffee",
      amount: "-USD 10.00",
      amountSecondary: "-EUR 8.00",
    });
    expect(rows[1]).toMatchObject({
      label: "Refund Shop",
      amount: "GBP 4.00",
      amountSecondary: "EUR 4.80",
    });
  });

  it("sorts pending rows first, then by newest created_at", () => {
    const rows = mapWirexCardTransactions([
      baseItem({ id: "old", created_at: "2026-01-01T00:00:00.000Z" }),
      baseItem({ id: "pending", created_at: "2025-01-01T00:00:00.000Z", status: "Pending" }),
      baseItem({ id: "new", created_at: "2026-02-01T00:00:00.000Z" }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["pending", "new", "old"]);
  });
});

describe("mapWirexBankActivity", () => {
  it("maps bank rows using the counterparty side and same injected-rate amount handling", () => {
    const [row] = mapWirexBankActivity(
      [
        baseItem({
          type: "BankTransfer",
          direction: "Outbound",
          destination: { type: "Bank", bank_account: { holder_name: "Alice Recipient" } },
          source_amount: { amount: 10, token_symbol: "USDC" },
        }),
      ],
      rates,
    );

    expect(row).toMatchObject({
      label: "Alice Recipient",
      amount: "-USD 10.00",
      amountSecondary: "-EUR 8.00",
    });
  });
});
