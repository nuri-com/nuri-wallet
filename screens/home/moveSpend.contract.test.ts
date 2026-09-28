// The mirrored constants in moveSpend.ts must equal the real ones.
//
// moveSpend.ts cannot import them: their modules reach the Arkade SDK and React
// Native sources, which do not load under vitest. That copy is only safe while
// something checks it, so this file does the import the other one cannot and
// fails the moment the figures diverge. Without it, a floor or fee change would
// leave the Move sheet quietly reserving the wrong headroom.
//
// Mocked at the module edge so the import chain never actually runs; the values
// under test are the real exported ones.
import { describe, expect, it, vi } from "vitest";

// The real constants live behind modules that reach @arkade-os/sdk and the
// Arkade send path; neither transforms under vitest. Stubbed at the edge so the
// exported FIGURES are real while the chain behind them never loads.
vi.mock("@arkade-os/sdk", () => ({ isValidArkAddress: () => true }));
vi.mock("../../services/arkade/ArkadeLightningSendService", () => ({
  payArkadeLightningInvoice: vi.fn(),
}));
vi.mock("../../services/arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: vi.fn(),
}));
vi.mock("../../services/arkade/internal/payTrace", () => ({ createTraceOpId: () => "op" }));
vi.mock("../../services/arkade/internal/logging", () => ({ emitTrace: vi.fn() }));
vi.mock("../../services/arkade/internal/utils", () => ({ truncateForLog: (v: string) => v }));
vi.mock("../../services/bitcoin/PendingBitcoinSendsStore", () => ({
  PendingBitcoinSendsStore: { add: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../lib/bitcoin/lightning", () => ({ decodeBolt11Facts: () => ({ amountSats: 0 }) }));

import {
  MOVE_CORRIDOR_MIN_SATS,
  MOVE_CORRIDOR_SPREAD_MULTIPLIER,
  moveSpendAmount,
} from "./moveSpend";
import {
  LIGHTNING_TO_BITCOIN_MIN_SATS,
  LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER,
} from "../../services/swapkit/LightningToBitcoinLimits";
import { maxFundAmountSats } from "../../services/swapkit/SwapKitArkadeIntentsCreate";

describe("moveSpend mirrors the real corridor constants", () => {
  it("matches the corridor floor", () => {
    expect(MOVE_CORRIDOR_MIN_SATS).toBe(LIGHTNING_TO_BITCOIN_MIN_SATS);
  });

  it("matches the spread multiplier", () => {
    expect(MOVE_CORRIDOR_SPREAD_MULTIPLIER).toBe(LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER);
  });

  it("matches the Intents fee the payer actually charges", () => {
    // The mirrored fee arithmetic, checked against the real helper across the
    // range where the per-quote minimum and the bps rate each dominate.
    for (const sats of [6_550, 10_000, 20_000, 49_830]) {
      const grossed = Math.ceil(sats * LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER);
      expect(moveSpendAmount({ sourceAmount: sats, fromKey: "arkade", toKey: "onchain" })).toBe(
        maxFundAmountSats(grossed),
      );
    }
  });
});
