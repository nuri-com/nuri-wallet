import { describe, expect, it } from "vitest";

import {
  isSafeToApplyUpdate,
  type OtaAutoApplyDeps,
  startOtaUpdateAutoApply,
} from "./OtaUpdateAutoApply";

/** Let the module's promise chain settle (evaluate → fetch → apply). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

type Harness = {
  deps: OtaAutoApplyDeps;
  applies: () => number;
  fetches: () => number;
  logs: () => string[];
  enterForeground: () => Promise<void>;
  /** A download finishing while the app is up: the state machine turns pending. */
  finishDownload: () => Promise<void>;
  /** The last open sheet/cover closing. */
  closeSurface: () => Promise<void>;
  setForeground: (v: boolean) => void;
  setSurface: (v: boolean) => void;
  setWalletBusy: (v: boolean) => void;
  setPending: (v: boolean) => void;
  setDownloadable: (v: boolean) => void;
  failNextApply: () => void;
};

function harness(): Harness {
  let foreground = true;
  let surface = false;
  let walletBusy = false;
  let pending = false;
  let downloadable = false;
  let applies = 0;
  let fetches = 0;
  const logs: string[] = [];
  let foregroundListener: (() => void) | null = null;
  let pendingListener: (() => void) | null = null;
  let surfaceListener: ((open: number) => void) | null = null;
  let failApply = false;

  return {
    deps: {
      isAppForeground: () => foreground,
      hasOpenSurface: () => surface,
      isWalletAccessBusy: () => walletBusy,
      isUpdatePending: () => pending,
      fetchPendingUpdate: async () => {
        fetches += 1;
        return downloadable;
      },
      applyPendingUpdate: async () => {
        applies += 1;
        if (failApply) {
          failApply = false;
          throw new Error("reloadAsync failed");
        }
      },
      onAppForegroundEnter: (listener) => {
        foregroundListener = listener;
        return () => {
          foregroundListener = null;
        };
      },
      onUpdatePending: (listener) => {
        pendingListener = listener;
        return () => {
          pendingListener = null;
        };
      },
      onOpenSurfacesChange: (listener) => {
        surfaceListener = listener;
        return () => {
          surfaceListener = null;
        };
      },
      log: (message) => logs.push(message),
    },
    applies: () => applies,
    fetches: () => fetches,
    logs: () => logs,
    enterForeground: async () => {
      foregroundListener?.();
      await settle();
    },
    finishDownload: async () => {
      pending = true;
      pendingListener?.();
      await settle();
    },
    closeSurface: async () => {
      surface = false;
      surfaceListener?.(0);
      await settle();
    },
    setForeground: (v) => {
      foreground = v;
    },
    setSurface: (v) => {
      surface = v;
    },
    setWalletBusy: (v) => {
      walletBusy = v;
    },
    setPending: (v) => {
      pending = v;
    },
    setDownloadable: (v) => {
      downloadable = v;
    },
    failNextApply: () => {
      failApply = true;
    },
  };
}

describe("startOtaUpdateAutoApply", () => {
  it("applies a downloaded bundle as soon as the app is idle", async () => {
    const h = harness();
    h.setPending(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();

    expect(h.applies()).toBe(1);
    // Pending already: no need to ask the server again.
    expect(h.fetches()).toBe(0);
  });

  it("applies what the launch check downloads while the app is already idle", async () => {
    const h = harness();
    h.setDownloadable(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();

    expect(h.fetches()).toBe(1);
    expect(h.applies()).toBe(1);
  });

  it("does nothing when no bundle is waiting", async () => {
    const h = harness();
    startOtaUpdateAutoApply(h.deps);
    await settle();

    expect(h.fetches()).toBe(1);
    expect(h.applies()).toBe(0);
  });

  it("never restarts over an open sheet, and applies on the next foreground once it closes", async () => {
    const h = harness();
    h.setPending(true);
    h.setSurface(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();
    expect(h.applies()).toBe(0);
    expect(h.logs()).toContain("update ready, waiting for an idle moment");

    // Still mid-flow on the next foreground.
    await h.enterForeground();
    expect(h.applies()).toBe(0);

    h.setSurface(false);
    await h.enterForeground();
    expect(h.applies()).toBe(1);
  });

  it("never restarts while the wallet-access ceremony is running", async () => {
    const h = harness();
    h.setPending(true);
    h.setWalletBusy(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();
    await h.enterForeground();
    expect(h.applies()).toBe(0);

    h.setWalletBusy(false);
    await h.enterForeground();
    expect(h.applies()).toBe(1);
  });

  it("does not restart an app that is not in the foreground", async () => {
    const h = harness();
    h.setPending(true);
    h.setForeground(false);
    startOtaUpdateAutoApply(h.deps);
    await settle();

    expect(h.applies()).toBe(0);
  });

  it("keeps the bundle and retries on the next foreground after a failed apply", async () => {
    const h = harness();
    h.setPending(true);
    h.failNextApply();
    startOtaUpdateAutoApply(h.deps);
    await settle();
    expect(h.applies()).toBe(1);
    expect(h.logs()).toContain("applying update failed");

    await h.enterForeground();
    expect(h.applies()).toBe(2);
  });

  it("applies once and stops listening after the unsubscribe", async () => {
    const h = harness();
    h.setPending(true);
    const stop = startOtaUpdateAutoApply(h.deps);
    await settle();
    expect(h.applies()).toBe(1);

    stop();
    await h.enterForeground();
    expect(h.applies()).toBe(1);
  });

  // Review 5294728655 #2: the launch-time download finishes AFTER the first evaluation, with the app
  // idle and in the foreground. No foreground transition follows, so only the download itself can
  // trigger the apply.
  it("applies a bundle whose download finishes after mount, without a foreground transition", async () => {
    const h = harness();
    startOtaUpdateAutoApply(h.deps);
    await settle();
    expect(h.applies()).toBe(0);

    await h.finishDownload();
    expect(h.applies()).toBe(1);
  });

  it("applies a deferred bundle when the surface that blocked it closes", async () => {
    const h = harness();
    h.setPending(true);
    h.setSurface(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();
    expect(h.applies()).toBe(0);

    await h.closeSurface();
    expect(h.applies()).toBe(1);
  });

  it("keeps every gate on the new triggers", async () => {
    const h = harness();
    h.setSurface(true);
    startOtaUpdateAutoApply(h.deps);
    await settle();
    await h.finishDownload();
    expect(h.applies()).toBe(0);

    h.setWalletBusy(true);
    await h.closeSurface();
    expect(h.applies()).toBe(0);

    h.setWalletBusy(false);
    h.setForeground(false);
    await h.closeSurface();
    expect(h.applies()).toBe(0);
  });

  it("stops listening to the new triggers after the unsubscribe", async () => {
    const h = harness();
    const stop = startOtaUpdateAutoApply(h.deps);
    await settle();
    stop();
    await h.finishDownload();
    await h.closeSurface();
    expect(h.applies()).toBe(0);
  });

  it("is idempotent: one reload per idle moment, however many triggers fire", async () => {
    const h = harness();
    h.setPending(true);
    startOtaUpdateAutoApply(h.deps);
    // A foreground that lands while the first apply is still resolving.
    await h.enterForeground();
    await settle();

    expect(h.applies()).toBe(1);
  });
});

describe("isSafeToApplyUpdate", () => {
  it("allows a foreground app with nothing open and no ceremony running", () => {
    expect(
      isSafeToApplyUpdate({ appForeground: true, openSurface: false, walletAccessBusy: false }),
    ).toBe(true);
  });

  it("blocks the background, an open surface and a running ceremony", () => {
    expect(
      isSafeToApplyUpdate({ appForeground: false, openSurface: false, walletAccessBusy: false }),
    ).toBe(false);
    expect(
      isSafeToApplyUpdate({ appForeground: true, openSurface: true, walletAccessBusy: false }),
    ).toBe(false);
    expect(
      isSafeToApplyUpdate({ appForeground: true, openSurface: false, walletAccessBusy: true }),
    ).toBe(false);
  });
});
