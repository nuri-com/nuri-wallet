import { beforeEach, describe, expect, it, vi } from "vitest";

// #1108: the real filter path, not a mock of it. A boarding-UTXO read that
// fails must not be read as "this wallet owns none of the server's rows" — that
// drops every sweep_ready row, and with it the only surface that can sweep them.

const mocks = vi.hoisted(() => ({
  getOrCreateWallet: vi.fn(),
  getBoardingUtxos: vi.fn(),
}));

// `@arkade-os/sdk` cannot be transformed by vitest; the mock keeps it out of the
// graph. Only `Ramps` is used from it here, and only past the filter path.
vi.mock("@arkade-os/sdk", () => ({
  Ramps: class {},
}));

vi.mock("../ArkadeRemoteIdentity", () => ({
  ArkadeRemoteIdentity: class {},
}));

vi.mock("./recoveryDefaults", () => ({
  scriptHashForLog: (script: unknown) => String(script || "n/a").slice(0, 12),
}));

vi.mock("./walletCache", () => ({
  getOrCreateWallet: mocks.getOrCreateWallet,
  // The boarding read is now shared through `boardingUtxoCache`, which scopes
  // its entries by wallet — so the filter path asks for the cache key too.
  getCurrentArkadeWalletCacheKey: () => "test-wallet",
}));

vi.mock("./walletSummaryEvents", () => ({
  addArkadeWalletSummaryListener: vi.fn(),
}));

vi.mock("./walletSummary", () => ({
  getCachedWalletSummary: vi.fn(() => null),
  loadArkadeWalletSummary: vi.fn(async () => null),
}));

vi.mock("./receiveAutoClaim", () => ({
  emitArkadeWalletSummaryAfterAutoSweep: vi.fn(),
}));

vi.mock("./logging", () => ({
  emitTrace: vi.fn(),
  logArkadeWalletSignTrace: vi.fn(),
}));

vi.mock("./boardingSweepFailure", () => ({
  getCachedBoardingSweepFailure: vi.fn(() => null),
  setBoardingSweepFailure: vi.fn(),
}));

vi.mock("./recovery", () => ({
  assertArkadeRecoveryCsvCompatible: vi.fn(async () => undefined),
}));

import {
  filterArkadeBoardingRowsForCurrentWallet,
  getArkadeBoardingOwnershipCopyLogs,
} from "./receiveAutoSweep";
import { resetBoardingUtxoCache } from "./boardingUtxoCache";

const sweepReadyRow = {
  type: "boarding" as const,
  status: "sweep_ready",
  txid: "4cdfc1681b060f5d252e70873b2c61943d23b2e74261f047b4de8df8c04c8cb6",
  vout: 0,
  value_sats: 737_148,
  confirmations: 1_843,
};

const boardingScriptHex = "51206db8500000000000000000000000000000000000000000000000000000007ba9";

beforeEach(() => {
  // The boarding read is shared for a few seconds now, so one case's rows would
  // otherwise satisfy the next case's read.
  resetBoardingUtxoCache("test");
  mocks.getOrCreateWallet.mockReset();
  mocks.getBoardingUtxos.mockReset();
  mocks.getOrCreateWallet.mockResolvedValue({
    getBoardingUtxos: mocks.getBoardingUtxos,
    boardingTapscript: { pkScript: boardingScriptHex },
    offchainTapscript: { pkScript: boardingScriptHex },
  });
});

describe("filterArkadeBoardingRowsForCurrentWallet (#1108)", () => {
  it("keeps sweep_ready rows when the local boarding-UTXO read fails", async () => {
    mocks.getBoardingUtxos.mockRejectedValue(new Error("esplora timeout"));

    const result = await filterArkadeBoardingRowsForCurrentWallet([sweepReadyRow], "test");

    expect(result.walletUnavailable).toBe(true);
    expect(result.walletError).toContain("esplora timeout");
    expect(result.rows).toEqual([sweepReadyRow]);
    // The support bundle must state what the server reported, not blank to zero.
    expect(getArkadeBoardingOwnershipCopyLogs().join(" ")).toContain("server_ready=1");
  });

  it("keeps sweep_ready rows when the wallet cannot be built at all", async () => {
    mocks.getOrCreateWallet.mockRejectedValue(new Error("identity unavailable"));

    const result = await filterArkadeBoardingRowsForCurrentWallet([sweepReadyRow], "test");

    expect(result.walletUnavailable).toBe(true);
    expect(result.rows).toEqual([sweepReadyRow]);
  });

  it("drops a sweep_ready row the wallet genuinely does not own", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([]);

    const result = await filterArkadeBoardingRowsForCurrentWallet([sweepReadyRow], "test");

    expect(result.walletUnavailable).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it("keeps a sweep_ready row the wallet owns", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([
      {
        txid: sweepReadyRow.txid,
        vout: 0,
        value: sweepReadyRow.value_sats,
        status: { confirmed: true },
        tapLeafScript: [],
      },
    ]);

    const result = await filterArkadeBoardingRowsForCurrentWallet([sweepReadyRow], "test");

    expect(result.walletUnavailable).toBe(false);
    expect(result.rows).toEqual([sweepReadyRow]);
  });
});
