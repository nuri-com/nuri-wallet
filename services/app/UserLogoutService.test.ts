import { beforeEach, describe, expect, it, vi } from "vitest";

// The primitive is mocked: these tests are about the boundary's contract
// (exactly-once, honest failure), not about the wipe itself, which ends in an
// app reload and cannot run under vitest.
const performFactoryReset = vi.hoisted(() => vi.fn());
const wipeLocalWalletData = vi.hoisted(() => vi.fn());
vi.mock("./FactoryResetService", () => ({ performFactoryReset, wipeLocalWalletData }));

import {
  __resetUserLogoutGuardForTests,
  hasAbortedTeardown,
  requestUserLogout,
  requestWalletReplacement,
} from "./UserLogoutService";

describe("requestUserLogout", () => {
  beforeEach(() => {
    performFactoryReset.mockReset();
    wipeLocalWalletData.mockReset();
    __resetUserLogoutGuardForTests();
  });

  it("tears the device down exactly once", async () => {
    performFactoryReset.mockResolvedValue(undefined);

    await expect(requestUserLogout()).resolves.toBe("started");

    expect(performFactoryReset).toHaveBeenCalledTimes(1);
    // No options: the reset takes the app down on its own timer, and nothing
    // about this flow may preserve state for the next sign-in.
    expect(performFactoryReset).toHaveBeenCalledWith();
  });

  it("a second call while a teardown is pending does not fire another wipe", async () => {
    performFactoryReset.mockResolvedValue(undefined);

    await requestUserLogout();
    await expect(requestUserLogout()).resolves.toBe("in-flight");

    expect(performFactoryReset).toHaveBeenCalledTimes(1);
  });

  it("concurrent taps produce one teardown", async () => {
    let release: (() => void) | undefined;
    performFactoryReset.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = requestUserLogout();
    const second = requestUserLogout();
    release?.();

    expect(await first).toBe("started");
    expect(await second).toBe("in-flight");
    expect(performFactoryReset).toHaveBeenCalledTimes(1);
  });

  it("blocks when the reset throws part-way", async () => {
    performFactoryReset.mockRejectedValue(new Error("keychain wipe failed"));

    // Not a successful reset (old key material may still be there) and not an
    // intact session either (auth state was cleared before the throw).
    await expect(requestUserLogout()).resolves.toBe("blocked");
    expect(hasAbortedTeardown()).toBe(true);
  });

  it("an aborted teardown stays latched, so a retry is the only way out", async () => {
    performFactoryReset.mockRejectedValueOnce(new Error("wipe failed"));
    performFactoryReset.mockResolvedValueOnce(undefined);

    expect(await requestUserLogout()).toBe("blocked");
    // The guard reopens only so the retry can run…
    expect(await requestUserLogout()).toBe("started");
    expect(performFactoryReset).toHaveBeenCalledTimes(2);
    // …and the abort stays on the record: the process never goes back to
    // presenting itself as a normal signed-in session.
    expect(hasAbortedTeardown()).toBe(true);
  });

  it("reports no abort on a clean run", async () => {
    performFactoryReset.mockResolvedValue(undefined);

    await requestUserLogout();

    expect(hasAbortedTeardown()).toBe(false);
  });
});

describe("requestWalletReplacement", () => {
  beforeEach(() => {
    performFactoryReset.mockReset();
    wipeLocalWalletData.mockReset();
    __resetUserLogoutGuardForTests();
  });

  it("wipes without relaunching, so the caller can commit the new wallet", async () => {
    wipeLocalWalletData.mockResolvedValue(undefined);

    await expect(requestWalletReplacement()).resolves.toBe("replaced");

    expect(wipeLocalWalletData).toHaveBeenCalledTimes(1);
    // The caller continues in this process; scheduling a reload here would take
    // the app down before the incoming wallet is committed.
    expect(performFactoryReset).not.toHaveBeenCalled();
  });

  it("concurrent replacements produce one wipe", async () => {
    let release: (() => void) | undefined;
    wipeLocalWalletData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = requestWalletReplacement();
    const second = requestWalletReplacement();
    release?.();

    expect(await first).toBe("replaced");
    expect(await second).toBe("in-flight");
    expect(wipeLocalWalletData).toHaveBeenCalledTimes(1);
  });

  it("a completed replacement lets a later targeted link wipe again", async () => {
    wipeLocalWalletData.mockResolvedValue(undefined);

    expect(await requestWalletReplacement()).toBe("replaced");
    // Unlike a logout, nothing is pending afterwards: the wipe ran to completion
    // and no reload is scheduled, so the guard must not stay shut.
    expect(await requestWalletReplacement()).toBe("replaced");
    expect(wipeLocalWalletData).toHaveBeenCalledTimes(2);
  });

  it("blocks and latches when the wipe throws part-way", async () => {
    wipeLocalWalletData.mockRejectedValue(new Error("keychain wipe failed"));

    await expect(requestWalletReplacement()).resolves.toBe("blocked");
    expect(hasAbortedTeardown()).toBe(true);
  });

  it("refuses every later replacement once a teardown has aborted", async () => {
    wipeLocalWalletData.mockRejectedValueOnce(new Error("keychain wipe failed"));
    wipeLocalWalletData.mockResolvedValue(undefined);

    expect(await requestWalletReplacement()).toBe("blocked");
    // A duplicate or queued passkey payload reaches the boundary regardless of
    // what the UI shows. It must not wipe again and hand back "replaced", which
    // is the caller's licence to commit the incoming wallet.
    expect(await requestWalletReplacement()).toBe("blocked");
    expect(wipeLocalWalletData).toHaveBeenCalledTimes(1);
  });

  it("leaves the full teardown as the only way out of the latch", async () => {
    wipeLocalWalletData.mockRejectedValue(new Error("keychain wipe failed"));
    performFactoryReset.mockResolvedValue(undefined);

    expect(await requestWalletReplacement()).toBe("blocked");

    // Replacement is refused, but the logout retry still runs — the latch must
    // block committing a new identity, not trap the device.
    expect(await requestUserLogout()).toBe("started");
    expect(performFactoryReset).toHaveBeenCalledTimes(1);
  });

  it("an abort here blocks the logout surfaces too", async () => {
    wipeLocalWalletData.mockRejectedValue(new Error("keychain wipe failed"));
    performFactoryReset.mockResolvedValue(undefined);

    await requestWalletReplacement();

    // One device, one identity: the latch is shared, so the home and support
    // sheets present the same recovery state a failed logout would.
    expect(hasAbortedTeardown()).toBe(true);
    // …and the full teardown is still reachable as the way out.
    expect(await requestUserLogout()).toBe("started");
    expect(hasAbortedTeardown()).toBe(true);
  });
});
