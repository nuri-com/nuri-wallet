import { beforeEach, describe, expect, it, vi } from "vitest";

// Two boarding sweeps must never be in flight at once.
//
// Each caller used to hold its own in-flight flag (and the unlock modal held
// none), so a summary-driven auto-sweep and a user-driven unlock could sign two
// different intents over the SAME boarding UTXO seconds apart. The operator
// registers the first and refuses the second with `duplicated input … already
// registered by another intent`; the loser cannot delete the registration
// because its proof does not match it, so the intent lingers and the sats stay
// stuck. These tests pin the shared single-flight lock.

const mocks = vi.hoisted(() => ({
  getOrCreateWallet: vi.fn(),
  getBoardingUtxos: vi.fn(),
  onboard: vi.fn(async () => "swept-txid"),
  withBoardingSweepApproval: vi.fn(),
}));

vi.mock("@arkade-os/sdk", () => ({
  Ramps: class {
    onboard(...args: unknown[]) {
      return mocks.onboard(...(args as []));
    }
  },
}));

vi.mock("../ArkadeRemoteIdentity", () => ({
  // The sweep gates on `identity instanceof ArkadeRemoteIdentity`, so the mock
  // wallet must carry a real instance of this mocked class.
  ArkadeRemoteIdentity: class {
    withBoardingSweepApproval(...args: unknown[]) {
      return mocks.withBoardingSweepApproval(...(args as []));
    }
  },
}));

vi.mock("./recoveryDefaults", () => ({
  scriptHashForLog: (script: unknown) => String(script || "n/a").slice(0, 12),
}));

vi.mock("./walletCache", () => ({
  getOrCreateWallet: mocks.getOrCreateWallet,
  getCurrentArkadeWalletCacheKey: () => "test-wallet",
}));

vi.mock("./walletSummaryEvents", () => ({
  addArkadeWalletSummaryListener: vi.fn(),
}));

vi.mock("./walletSummary", () => ({
  getCachedWalletSummary: vi.fn(() => ({ balanceBoardingConfirmedSats: 12_807 })),
  loadArkadeWalletSummary: vi.fn(async () => ({ balanceBoardingConfirmedSats: 12_807 })),
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

import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import {
  resetArkadeBoardingAutoSweepState,
  sweepArkadeBoardingToOffchain,
} from "./receiveAutoSweep";
import { resetBoardingUtxoCache } from "./boardingUtxoCache";

const boardingScriptHex = "51206db8500000000000000000000000000000000000000000000000000000007ba9";

const utxo = (txid: string, value: number) => ({
  txid,
  vout: 0,
  value,
  status: { confirmed: true },
  script: boardingScriptHex,
});

const serverRow = (txid: string, value: number) => ({
  type: "boarding" as const,
  status: "sweep_ready",
  txid,
  vout: 0,
  value_sats: value,
  confirmations: 12,
  script: boardingScriptHex,
});

const LIVE = "bb".repeat(32);

beforeEach(() => {
  resetBoardingUtxoCache("test");
  mocks.getOrCreateWallet.mockReset();
  mocks.getBoardingUtxos.mockReset();
  mocks.onboard.mockClear();
  mocks.onboard.mockResolvedValue("swept-txid");
  mocks.getOrCreateWallet.mockResolvedValue({
    getBoardingUtxos: mocks.getBoardingUtxos,
    boardingTapscript: { pkScript: boardingScriptHex },
    offchainTapscript: { pkScript: boardingScriptHex },
    arkProvider: { getInfo: async () => ({ fees: { txFeeRate: "1" } }) },
    // The approval wrapper just runs the signing body in these tests.
    identity: new ArkadeRemoteIdentity(),
  });
  mocks.withBoardingSweepApproval.mockImplementation(
    async (_ctx: unknown, _scope: unknown, run: () => Promise<string>) => run(),
  );
});

describe("sweepArkadeBoardingToOffchain single-flight (#1433 follow-up)", () => {
  it("does not start a second sweep while one is in flight", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.getBoardingUtxos.mockResolvedValue([utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation(async () => {
      await gate;
      return "swept-txid";
    });

    // The unlock modal and the summary-driven auto-sweep, overlapping.
    const first = sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);
    const second = sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);

    release?.();
    const [a, b] = await Promise.all([first, second]);

    // One registered intent, not two over the same outpoint.
    expect(mocks.onboard).toHaveBeenCalledTimes(1);
    // The joiner still gets the answer it asked for.
    expect(a).toBe("swept-txid");
    expect(b).toBe(a);
  });

  it("allows a new sweep once the previous one has settled", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([utxo(LIVE, 9_000)]);

    await sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);
    await sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);

    expect(mocks.onboard).toHaveBeenCalledTimes(2);
  });

  it("releases the lock when a sweep FAILS, so a retry is still possible", async () => {
    // A failed sweep that kept the lock would wedge the wallet for the rest of
    // the session — worse than the bug being fixed.
    mocks.getBoardingUtxos.mockResolvedValue([utxo(LIVE, 9_000)]);
    mocks.onboard.mockRejectedValueOnce(new Error("settle refused"));

    await expect(sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)])).rejects.toThrow(
      "settle refused",
    );

    mocks.onboard.mockResolvedValue("swept-txid");
    await expect(sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)])).resolves.toBe(
      "swept-txid",
    );
    expect(mocks.onboard).toHaveBeenCalledTimes(2);
  });

  it("a reset during an active sweep does NOT free the lock", async () => {
    // `restoreArkadeDebugRecoveryBackup()` calls this reset, and it can land
    // while the sweep is still awaiting approval/settlement. Clearing the lock
    // there cannot cancel the run, so the next caller would register a second
    // intent over the same UTXO — the exact orphan this PR prevents.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.getBoardingUtxos.mockResolvedValue([utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation(async () => {
      await gate;
      return "swept-txid";
    });

    const first = sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);
    resetArkadeBoardingAutoSweepState();
    const second = sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);

    release?.();
    await Promise.all([first, second]);

    expect(mocks.onboard).toHaveBeenCalledTimes(1);
  });

  it("a reset still lets the NEXT sweep run once the active one finished", async () => {
    // The lock must not outlive its run: reset is legitimate between sweeps.
    mocks.getBoardingUtxos.mockResolvedValue([utxo(LIVE, 9_000)]);

    await sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);
    resetArkadeBoardingAutoSweepState();
    await sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);

    expect(mocks.onboard).toHaveBeenCalledTimes(2);
  });
});
