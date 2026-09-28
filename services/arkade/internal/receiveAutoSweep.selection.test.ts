import { beforeEach, describe, expect, it, vi } from "vitest";

// Review finding on #1433: the sweep does a forced-fresh boarding read, but when
// an ownership proof exists it selected inputs from the PROOF's UTXO objects,
// which come from the shared cache and may be up to 8s old. That can sign over
// an outpoint that has since been spent, or skip one that has since confirmed.
//
// These tests drive the real `sweepArkadeBoardingToOffchain` with two different
// answers from `getBoardingUtxos()` — the cached proof read, then the fresh
// signing read — and assert what reaches `Ramps.onboard`.

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
import { sweepArkadeBoardingToOffchain } from "./receiveAutoSweep";
import {
  getBlockedBoardingRotationState,
  resetBoardingSweepBlockedCache,
} from "./boardingSweepBlocked";
import { resetBoardingUtxoCache } from "./boardingUtxoCache";
import { resetArkadeBoardingMinimumSats } from "./boardingMinimum";

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

const SPENT = "aa".repeat(32);
const LIVE = "bb".repeat(32);

const onboardedTxids = () => {
  const call = mocks.onboard.mock.calls[0] as unknown[] | undefined;
  const selected = (call?.[1] ?? []) as Array<{ txid: string }>;
  return selected.map((coin) => coin.txid);
};

let walletStub: Record<string, unknown>;

beforeEach(() => {
  resetBoardingUtxoCache("test");
  resetBoardingSweepBlockedCache();
  // The floor is cached module state, primed from the wallet's node info.
  resetArkadeBoardingMinimumSats();
  mocks.getOrCreateWallet.mockReset();
  mocks.getBoardingUtxos.mockReset();
  mocks.onboard.mockClear();
  mocks.onboard.mockResolvedValue("swept-txid");
  walletStub = {
    getBoardingUtxos: mocks.getBoardingUtxos,
    boardingTapscript: { pkScript: boardingScriptHex },
    offchainTapscript: { pkScript: boardingScriptHex },
    arkProvider: { getInfo: async () => ({ fees: { txFeeRate: "1" } }) },
    // The approval wrapper just runs the signing body in these tests.
    identity: new ArkadeRemoteIdentity(),
  };
  mocks.getOrCreateWallet.mockResolvedValue(walletStub);
  mocks.withBoardingSweepApproval.mockImplementation(
    async (_ctx: unknown, _scope: unknown, run: () => Promise<string>) => run(),
  );
});

describe("sweepArkadeBoardingToOffchain input selection (#1433 review)", () => {
  it("never signs over an outpoint the fresh read no longer returns", async () => {
    // The proof (cached, up to 8s old) still sees the spent coin; the fresh
    // signing read does not. Selecting from the proof would sign a spent input.
    mocks.getBoardingUtxos
      .mockResolvedValueOnce([utxo(SPENT, 12_807), utxo(LIVE, 9_000)])
      .mockResolvedValue([utxo(LIVE, 9_000)]);

    await sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_807), serverRow(LIVE, 9_000)]);

    expect(onboardedTxids()).not.toContain(SPENT);
    expect(onboardedTxids()).toEqual([LIVE]);
  });

  // Review finding on #1454: 330 is the mainnet figure, not a constant. A custom
  // node (setCustomArkadeNodeUrl) may still demand 3,000, and the selection has to
  // follow the node this sweep is talking to instead of admitting a coin the node
  // will reject at Ramps.onboard.
  it("refuses a coin below the floor the active node declares", async () => {
    const SMALL = "ff".repeat(32);
    walletStub.arkProvider = {
      getInfo: async () => ({ fees: { txFeeRate: "1" }, utxoMinAmount: 3_000 }),
    };
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SMALL, 2_000)]);

    const outcome = await sweepArkadeBoardingToOffchain([serverRow(SMALL, 2_000)]);

    expect(mocks.onboard).not.toHaveBeenCalled();
    expect(outcome).toBe("pending_unconfirmed");
  });

  it("still restricts the selection to outpoints the ownership proof matched", async () => {
    // The reconciliation must not become "sweep anything the fresh read
    // returns": the proof is what proves these are this wallet's coins and that
    // the server considers them sweep_ready.
    const FOREIGN = "cc".repeat(32);
    mocks.getBoardingUtxos
      .mockResolvedValueOnce([utxo(LIVE, 9_000)])
      .mockResolvedValue([utxo(LIVE, 9_000), utxo(FOREIGN, 50_000)]);

    await sweepArkadeBoardingToOffchain([serverRow(LIVE, 9_000)]);

    expect(onboardedTxids()).toEqual([LIVE]);
  });

  it("sweeps a coin that confirmed AFTER the cached ownership proof was built", async () => {
    // The proof's cached read saw this outpoint as unconfirmed, so it is absent
    // from `matchingUtxos`. It confirms before the forced-fresh signing read.
    // Using `matchingUtxos` as the allow-list would filter the fresh confirmed
    // coin straight back out and report no candidate while the funds sit there.
    const NEWLY = "dd".repeat(32);
    mocks.getBoardingUtxos
      .mockResolvedValueOnce([{ ...utxo(NEWLY, 20_000), status: { confirmed: false } }])
      .mockResolvedValue([utxo(NEWLY, 20_000)]);

    await sweepArkadeBoardingToOffchain([serverRow(NEWLY, 20_000)]);

    expect(onboardedTxids()).toEqual([NEWLY]);
  });

  it("still excludes a fresh confirmed coin whose server row claims a foreign script", async () => {
    // The eligibility set must not become "any sweep_ready outpoint": a row
    // whose script disagrees with this wallet's is still rejected, even though
    // it is now judged before the missing-local branch.
    const FOREIGN_SCRIPT = "ee".repeat(32);
    mocks.getBoardingUtxos
      .mockResolvedValueOnce([])
      .mockResolvedValue([utxo(FOREIGN_SCRIPT, 30_000), utxo(LIVE, 9_000)]);

    await sweepArkadeBoardingToOffchain([
      { ...serverRow(FOREIGN_SCRIPT, 30_000), script: `5120${"ff".repeat(31)}` },
      serverRow(LIVE, 9_000),
    ]);

    expect(onboardedTxids()).toEqual([LIVE]);
  });

  // General case for the ASP-side stuck registration: a settle that fails after
  // its register leaves an intent holding that boarding outpoint, and every
  // later attempt over it is refused with `duplicated input`. The sweep picks
  // one coin per attempt and takes the lowest outpoint, so without remembering
  // the refusal a single stuck coin hides every coin deposited afterwards.
  const duplicatedInputError = (txid: string) =>
    new Error(
      `INTERNAL_ERROR (0): failed to push intent: failed to push intent after max number of retries: duplicated input, ${txid}:0 already registered by another intent`,
    );

  it("skips a coin the ASP refused and sweeps the next candidate", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000), utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation((async (_fee: unknown, coins: unknown) => {
      const selected = (coins ?? []) as Array<{ txid: string }>;
      if (selected[0]?.txid === SPENT) throw duplicatedInputError(SPENT);
      return "swept-txid";
    }) as never);

    // First attempt takes the lowest outpoint, which the ASP refuses.
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("duplicated input");

    // The next attempt must go for the other coin rather than retry the blocked
    // one, which would fail identically forever.
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).resolves.toBe("swept-txid");
    const attempted = mocks.onboard.mock.calls.map(
      (call) => ((call as unknown[])[1] as Array<{ txid: string }> | undefined)?.[0]?.txid,
    );
    expect(attempted).toEqual([SPENT, LIVE]);
  });

  // The shape that actually reaches the sweep: the SDK's recovery delete is
  // refused (the ASP's registration belongs to an older intent, so our proof
  // matches nothing) and that error is what the settle surfaces. Matching only
  // the duplicated-input text recorded nothing here, so the sweep retried the
  // same coin on every tick and never touched the next deposit.
  it("skips the coin when the refusal arrives as the SDK's refused cleanup delete", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000), utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation((async (_fee: unknown, coins: unknown) => {
      const selected = (coins ?? []) as Array<{ txid: string }>;
      if (selected[0]?.txid === SPENT) {
        throw new Error("INVALID_INTENT_PROOF (23): no matching intents found for intent proof");
      }
      return "swept-txid";
    }) as never);

    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("no matching intents found");

    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).resolves.toBe("swept-txid");
    const attempted = mocks.onboard.mock.calls.map(
      (call) => ((call as unknown[])[1] as Array<{ txid: string }> | undefined)?.[0]?.txid,
    );
    expect(attempted).toEqual([SPENT, LIVE]);
  });

  it("keeps attempting a refused coin when it is the only candidate", async () => {
    // A registration the ASP clears must become sweepable again without any
    // user action, so the blocklist may not hide the wallet's only coin.
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000)]);
    mocks.onboard.mockImplementation((async () => {
      throw duplicatedInputError(SPENT);
    }) as never);

    await expect(sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000)])).rejects.toThrow(
      "duplicated input",
    );
    await expect(sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000)])).rejects.toThrow(
      "duplicated input",
    );
    expect(mocks.onboard).toHaveBeenCalledTimes(2);
  });

  // Review finding: a preflight failure used to be counted as an attempt, so the
  // count stopped meaning "we reached the ASP" and a coin whose preflight keeps
  // failing could pin the rotation.
  it("records a preflight failure as a turn, not an ASP attempt, and rotates", async () => {
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000), utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation((async (_fee: unknown, coins: unknown) => {
      const selected = (coins ?? []) as Array<{ txid: string }>;
      throw duplicatedInputError(String(selected[0]?.txid));
    }) as never);

    // Two real attempts, one per coin, both refused by the ASP.
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("duplicated input");
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("duplicated input");
    const afterRefusals = getBlockedBoardingRotationState();

    // Now every candidate is blocked, and the identity check fails before the
    // settle call, so the ASP is never reached with this coin.
    const realIdentity = walletStub.identity;
    walletStub.identity = {};
    const attemptsSoFar = mocks.onboard.mock.calls.length;
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("arkade remote identity unavailable");
    expect(mocks.onboard.mock.calls.length).toBe(attemptsSoFar);

    const state = getBlockedBoardingRotationState();
    const target =
      afterRefusals[`${SPENT}:0`].turns <= afterRefusals[`${LIVE}:0`].turns ? SPENT : LIVE;
    expect(state[`${target}:0`].turns).toBe(afterRefusals[`${target}:0`].turns + 1);
    // The failed turn did NOT count as an ASP attempt for that coin.
    expect(state[`${target}:0`].attempts).toBe(afterRefusals[`${target}:0`].attempts);

    // And the next attempt does not come back to it.
    walletStub.identity = realIdentity;
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
    ).rejects.toThrow("duplicated input");
    const other = target === SPENT ? LIVE : SPENT;
    const lastCall = mocks.onboard.mock.calls.at(-1) as unknown[];
    expect((lastCall[1] as Array<{ txid: string }>)[0].txid).toBe(other);
  });

  // Review finding: an unblocked dust coin counted as an available candidate, so
  // the all-blocked fallback never ran, selection dropped the dust, and the sweep
  // returned "pending_unconfirmed" without ever retrying the claimable coin the
  // ASP may have already released.
  it("unblocked dust does not suppress retrying a claimable blocked coin", async () => {
    // 100 sats is below the node's boarding floor (utxoMinAmount 330), so it is
    // still dust for selection; at 2,000 it was only dust under the old 3,000
    // figure and would now be a legitimate candidate.
    const DUST = "dd".repeat(32);
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000), utxo(DUST, 100)]);
    mocks.onboard.mockImplementation((async () => {
      throw duplicatedInputError(SPENT);
    }) as never);

    // Block the claimable coin first.
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(DUST, 100)]),
    ).rejects.toThrow("duplicated input");

    // With the dust now the only unblocked candidate, the claimable blocked coin
    // must still be retried rather than silently skipped.
    await expect(
      sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(DUST, 100)]),
    ).rejects.toThrow("duplicated input");

    const attempted = mocks.onboard.mock.calls.map(
      (call) => ((call as unknown[])[1] as Array<{ txid: string }> | undefined)?.[0]?.txid,
    );
    expect(attempted).toEqual([SPENT, SPENT]);
  });

  it("reaches every blocked coin, including the highest of three", async () => {
    // Review finding: dropping only the just-attempted coin alternated between
    // the lowest two, so with three stuck coins the highest was never attempted
    // and a registration the ASP released above them stayed invisible.
    const NEWEST = "cc".repeat(32);
    const all = [utxo(SPENT, 12_000), utxo(LIVE, 9_000), utxo(NEWEST, 7_000)];
    const rows = [serverRow(SPENT, 12_000), serverRow(LIVE, 9_000), serverRow(NEWEST, 7_000)];
    mocks.getBoardingUtxos.mockResolvedValue(all);
    mocks.onboard.mockImplementation((async (_fee: unknown, coins: unknown) => {
      const selected = (coins ?? []) as Array<{ txid: string }>;
      throw duplicatedInputError(String(selected[0]?.txid));
    }) as never);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(sweepArkadeBoardingToOffchain(rows)).rejects.toThrow("duplicated input");
    }

    const attempted = mocks.onboard.mock.calls.map(
      (call) => ((call as unknown[])[1] as Array<{ txid: string }> | undefined)?.[0]?.txid,
    );
    expect(attempted).toEqual([SPENT, LIVE, NEWEST, SPENT, LIVE, NEWEST]);
  });

  it("alternates between blocked coins instead of starving the higher one", async () => {
    // Both coins are stuck, so every pass goes through the all-blocked fallback.
    // Handing it the list unchanged makes the sweep retry the lowest outpoint
    // forever, and a coin the ASP releases above it would never be attempted.
    mocks.getBoardingUtxos.mockResolvedValue([utxo(SPENT, 12_000), utxo(LIVE, 9_000)]);
    mocks.onboard.mockImplementation((async (_fee: unknown, coins: unknown) => {
      const selected = (coins ?? []) as Array<{ txid: string }>;
      throw duplicatedInputError(String(selected[0]?.txid));
    }) as never);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        sweepArkadeBoardingToOffchain([serverRow(SPENT, 12_000), serverRow(LIVE, 9_000)]),
      ).rejects.toThrow("duplicated input");
    }

    const attempted = mocks.onboard.mock.calls.map(
      (call) => ((call as unknown[])[1] as Array<{ txid: string }> | undefined)?.[0]?.txid,
    );
    expect(attempted).toEqual([SPENT, LIVE, SPENT, LIVE]);
  });
});
