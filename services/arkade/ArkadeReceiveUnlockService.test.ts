import { beforeEach, describe, expect, it, vi } from "vitest";

// #1108: a wallet-summary failure must not discard the server's boarding rows.
// The boarding sweep is client-only and runs from the unlock modal alone, and
// App.tsx only opens that modal while actionableCount > 0 — so a refresh that
// collapses to actionableCount: 0 on a summary rejection strands the funds with
// no retry path at all.

const mocks = vi.hoisted(() => ({
  arkadeReceiveSync: vi.fn(),
  getArkadeWalletSummary: vi.fn(),
  loadArkadeWalletSummary: vi.fn(),
  filterArkadeBoardingRowsForCurrentWallet: vi.fn(),
  sweepArkadeBoardingToOffchain: vi.fn(),
  resumeArkadeLightningClaimsManual: vi.fn(),
  recoverArkadeRecoverableVtxosManual: vi.fn(),
  fetchArkNodeInfoWithRetry: vi.fn(),
}));

vi.mock("./ArkadeApiService", () => ({
  arkadeReceiveSync: mocks.arkadeReceiveSync,
}));

vi.mock("./internal/walletSummary", () => ({
  getArkadeWalletSummary: mocks.getArkadeWalletSummary,
  loadArkadeWalletSummary: mocks.loadArkadeWalletSummary,
}));

vi.mock("./internal/identity", () => ({
  getArkadeReceiveOwner: vi.fn(async () => ({
    credIdB64u: "cred",
    clientPublicKey33Hex: "pub",
  })),
}));

vi.mock("./internal/receiveAutoSweep", () => ({
  filterArkadeBoardingRowsForCurrentWallet: mocks.filterArkadeBoardingRowsForCurrentWallet,
  getArkadeBoardingOwnershipCopyLogs: vi.fn(() => []),
  isBoardingOutpointRecentlySwept: vi.fn(() => false),
  resetArkadeBoardingOwnershipCopyLogs: vi.fn(),
  sweepArkadeBoardingToOffchain: mocks.sweepArkadeBoardingToOffchain,
}));

vi.mock("./internal/logging", () => ({
  emitTrace: vi.fn(),
  logArkadeWalletSignTrace: vi.fn(),
}));

vi.mock("./internal/network", () => ({
  fetchArkNodeInfoWithRetry: mocks.fetchArkNodeInfoWithRetry,
}));

vi.mock("./ArkadeServerConfigService", () => ({
  arkadeServerConfigService: { getArkadeNodeUrl: () => "https://arkade.computer" },
}));

vi.mock("./internal/receiveAutoRecover", () => ({
  recoverArkadeRecoverableVtxosManual: mocks.recoverArkadeRecoverableVtxosManual,
}));

vi.mock("./internal/receiveAutoClaim", () => ({
  resumeArkadeLightningClaimsManual: mocks.resumeArkadeLightningClaimsManual,
}));

vi.mock("./internal/pendingLnurlSwaps", () => ({
  setPendingLnurlSwapsFromReceiveRows: vi.fn(),
}));

import {
  addArkadeReceiveUnlockStateListener,
  refreshArkadeReceiveUnlockState,
  runArkadeReceiveUnlock,
} from "./ArkadeReceiveUnlockService";
import { resetArkadeBoardingMinimumSats } from "./internal/boardingMinimum";

// sinan's stranded outpoint, with the values the server actually reports.
const sweepReadyRow = {
  type: "boarding" as const,
  status: "sweep_ready",
  txid: "4cdfc1681b060f5d252e70873b2c61943d23b2e74261f047b4de8df8c04c8cb6",
  vout: 0,
  value_sats: 737_148,
  confirmations: 1_843,
};

const claimableLightningRow = {
  type: "lightning" as const,
  status: "transaction.confirmed",
  payment_hash_hex: "aa".repeat(32),
  amount_msat: 21_000_000,
};

const syncResponse = (lightning: unknown[] = []) => ({
  ok: true,
  receives: [] as unknown[],
  lightning,
  boarding: [sweepReadyRow],
});

beforeEach(() => {
  mocks.arkadeReceiveSync.mockReset();
  mocks.getArkadeWalletSummary.mockReset();
  mocks.loadArkadeWalletSummary.mockReset();
  mocks.filterArkadeBoardingRowsForCurrentWallet.mockReset();
  mocks.sweepArkadeBoardingToOffchain.mockReset();
  mocks.resumeArkadeLightningClaimsManual.mockReset();
  mocks.recoverArkadeRecoverableVtxosManual.mockReset();
  mocks.fetchArkNodeInfoWithRetry.mockReset();
  mocks.arkadeReceiveSync.mockResolvedValue(syncResponse());
  mocks.filterArkadeBoardingRowsForCurrentWallet.mockResolvedValue({
    rows: [sweepReadyRow],
    walletUnavailable: false,
    walletError: null,
  });
  mocks.sweepArkadeBoardingToOffchain.mockResolvedValue("swept");
  mocks.resumeArkadeLightningClaimsManual.mockResolvedValue("claimed");
  mocks.recoverArkadeRecoverableVtxosManual.mockResolvedValue("recovered");
  mocks.fetchArkNodeInfoWithRetry.mockResolvedValue({ utxoMinAmount: 330 });
  // The node floor is module state; a test that moves it must not carry it into the next one.
  resetArkadeBoardingMinimumSats();
});

// Review finding on #1454: the node's floor is read for the boarding rows, but it
// must not become a blocking member of the refresh: that helper retries three
// times with 8s timeouts, so a slow /v1/info would withhold rows the signer
// already returned and stall Lightning-only refreshes that never use the floor.
describe("refreshArkadeReceiveUnlockState and the node floor (#1454 review)", () => {
  it("publishes the sync rows even when the node read fails", async () => {
    mocks.fetchArkNodeInfoWithRetry.mockRejectedValue(new Error("node down"));

    const state = await refreshArkadeReceiveUnlockState({ reason: "test_node_down" });

    expect(state.boardingSweepReadyCount).toBe(1);
    expect(state.actionableItems.some((item) => item.kind === "boarding_sweep")).toBe(true);
  });

  it("does not read the node for a refresh with no boarding rows", async () => {
    mocks.filterArkadeBoardingRowsForCurrentWallet.mockResolvedValue({
      rows: [],
      walletUnavailable: false,
      walletError: null,
    });

    await refreshArkadeReceiveUnlockState({ reason: "test_lightning_only" });

    expect(mocks.fetchArkNodeInfoWithRetry).not.toHaveBeenCalled();
  });

  // Codex P2 on #1466: /v1/info that is slow (not failing) held the refresh for all its retries.
  it("publishes the sync rows while the node read is still outstanding", async () => {
    let answerNode: (info: { utxoMinAmount: number }) => void = () => {};
    mocks.fetchArkNodeInfoWithRetry.mockReturnValue(
      new Promise((resolve) => {
        answerNode = resolve;
      }),
    );

    const state = await refreshArkadeReceiveUnlockState({ reason: "test_node_slow" });

    // Resolved without the node having answered.
    expect(state.boardingSweepReadyCount).toBe(1);
    expect(mocks.fetchArkNodeInfoWithRetry).toHaveBeenCalledTimes(1);
    answerNode({ utxoMinAmount: 330 });
  });

  it("re-classifies the published rows when the node's floor turns out different", async () => {
    let answerNode: (info: { utxoMinAmount: number }) => void = () => {};
    mocks.fetchArkNodeInfoWithRetry.mockReturnValue(
      new Promise((resolve) => {
        answerNode = resolve;
      }),
    );
    const published: number[] = [];
    const stop = addArkadeReceiveUnlockStateListener((next) => {
      published.push(next.boardingSweepReadyCount);
    });

    await refreshArkadeReceiveUnlockState({ reason: "test_node_floor" });
    // A floor above the row's value: the row is no longer claimable.
    answerNode({ utxoMinAmount: 10_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(published.at(-1)).toBe(0);
  });
});

describe("refreshArkadeReceiveUnlockState with a failing wallet summary (#1108)", () => {
  it("keeps the boarding sweep actionable and records the summary failure", async () => {
    mocks.getArkadeWalletSummary.mockRejectedValue(new Error("wallet_summary_ark_address timeout"));

    const state = await refreshArkadeReceiveUnlockState({ reason: "test" });

    expect(state.status).toBe("actionable");
    expect(state.actionableCount).toBe(1);
    expect(state.actionableItems.map((item) => item.kind)).toEqual(["boarding_sweep"]);
    expect(state.boardingSweepReadyCount).toBe(1);
    expect(state.boardingSweepReadySats).toBe(737_148);
    expect(state.lastError).toContain("wallet_summary_ark_address timeout");
  });

  it("keeps server sweep_ready rows when the wallet cannot be built", async () => {
    mocks.getArkadeWalletSummary.mockRejectedValue(new Error("wallet unavailable"));
    mocks.filterArkadeBoardingRowsForCurrentWallet.mockResolvedValue({
      rows: [sweepReadyRow],
      walletUnavailable: true,
      walletError: "getOrCreateWallet failed",
    });

    const state = await refreshArkadeReceiveUnlockState({ reason: "test" });

    expect(state.boardingWalletUnavailable).toBe(true);
    expect(state.actionableCount).toBe(1);
  });

  it("surfaces a sync failure without dropping the rows it already knew about", async () => {
    // Seeded here rather than inherited from the tests above: the service holds
    // module state, and a carry-forward assertion that depends on test order
    // breaks under .only, a reorder, or a shard split.
    mocks.getArkadeWalletSummary.mockResolvedValue(null);
    const seeded = await refreshArkadeReceiveUnlockState({ reason: "test_seed" });
    expect(seeded.boardingSweepReadyCount).toBe(1);

    mocks.arkadeReceiveSync.mockRejectedValue(new Error("sync down"));

    const state = await refreshArkadeReceiveUnlockState({ reason: "test" });

    expect(state.lastError).toContain("sync down");
    // The sync is the only source of boarding rows, so its failure carries the
    // last known state forward rather than reporting "nothing to do".
    expect(state.boardingSweepReadyCount).toBe(1);
  });
});

describe("runArkadeReceiveUnlock step handling (#1108)", () => {
  it("sweeps the rows it snapshotted even when a refresh clears them mid-session", async () => {
    mocks.getArkadeWalletSummary.mockResolvedValue(null);
    mocks.loadArkadeWalletSummary.mockResolvedValue(null);
    mocks.arkadeReceiveSync.mockResolvedValue(syncResponse([claimableLightningRow]));
    // The claim emits arkade:receiveUpdated, which the app monitor answers with
    // a refresh. Modelled as a refresh that starts and does not settle, because
    // it clears the module's boarding rows on entry and only repopulates at the
    // end — the window the boarding sweep used to read an empty list in.
    mocks.resumeArkadeLightningClaimsManual.mockImplementation(async () => {
      mocks.arkadeReceiveSync.mockImplementationOnce(() => new Promise(() => {}));
      void refreshArkadeReceiveUnlockState({ reason: "monitor_receive_updated" });
      return "claimed";
    });

    const result = await runArkadeReceiveUnlock("test_unlock");

    expect(mocks.resumeArkadeLightningClaimsManual).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain.mock.calls[0]?.[0]).toEqual([sweepReadyRow]);
    expect(result.errors).toEqual([]);
  });

  it("still sweeps the known rows when the revalidate fails and state carries forward", async () => {
    mocks.getArkadeWalletSummary.mockResolvedValue(null);
    mocks.loadArkadeWalletSummary.mockResolvedValue(null);
    await refreshArkadeReceiveUnlockState({ reason: "test_seed" });
    // The carried-forward failure state keeps boarding_sweep actionable, so the
    // rows it refers to have to survive with it — a sweep handed an empty list
    // returns "pending_unconfirmed", which counts as a skip and would report the
    // unlock as successful with the UTXO untouched.
    mocks.arkadeReceiveSync.mockRejectedValue(new Error("sync down"));

    const result = await runArkadeReceiveUnlock("test_unlock_carried");

    expect(mocks.sweepArkadeBoardingToOffchain).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain.mock.calls[0]?.[0]).toEqual([sweepReadyRow]);
    expect(result.state.boardingSweepReadyCount).toBe(1);
  });

  it("does not bundle a recoverable wallet update with a Lightning claim", async () => {
    mocks.getArkadeWalletSummary.mockResolvedValue({ balanceRecoverableSats: 500_000 });
    mocks.loadArkadeWalletSummary.mockResolvedValue({ balanceRecoverableSats: 500_000 });
    mocks.arkadeReceiveSync.mockResolvedValue(syncResponse([claimableLightningRow]));

    await runArkadeReceiveUnlock("test_unlock_mixed");

    expect(mocks.resumeArkadeLightningClaimsManual).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain).toHaveBeenCalledTimes(1);
    expect(mocks.recoverArkadeRecoverableVtxosManual).not.toHaveBeenCalled();
  });

  // Review finding on #1450 (round 5): a persisted receive row can no longer be
  // claimed, so the claim step fails loudly now. The failure has to reach
  // `errors` and must not take the boarding sweep down with it.
  it("surfaces a retired Lightning claim and still sweeps the boarding rows", async () => {
    mocks.getArkadeWalletSummary.mockResolvedValue(null);
    mocks.loadArkadeWalletSummary.mockResolvedValue(null);
    mocks.arkadeReceiveSync.mockResolvedValue(syncResponse([claimableLightningRow]));
    mocks.resumeArkadeLightningClaimsManual.mockRejectedValue(
      new Error(
        "Lightning receive is retired: 1 persisted receive row(s) cannot be claimed from this build",
      ),
    );

    const result = await runArkadeReceiveUnlock("test_unlock_retired_claim");

    const claimError = result.errors.find((line) => line.includes("ln_receive_claim"));
    expect(claimError).toContain("Lightning receive is retired");
    expect(mocks.sweepArkadeBoardingToOffchain).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain.mock.calls[0]?.[0]).toEqual([sweepReadyRow]);
  });

  it("runs a recoverable wallet update when it is the only work", async () => {
    mocks.getArkadeWalletSummary.mockResolvedValue({ balanceRecoverableSats: 500_000 });
    mocks.loadArkadeWalletSummary.mockResolvedValue({ balanceRecoverableSats: 500_000 });
    mocks.arkadeReceiveSync.mockResolvedValue({
      ok: true,
      receives: [],
      lightning: [],
      boarding: [],
    });
    mocks.filterArkadeBoardingRowsForCurrentWallet.mockResolvedValue({
      rows: [],
      walletUnavailable: false,
      walletError: null,
    });

    await runArkadeReceiveUnlock("test_unlock_recoverable");

    expect(mocks.recoverArkadeRecoverableVtxosManual).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArkadeBoardingToOffchain).not.toHaveBeenCalled();
  });
});
