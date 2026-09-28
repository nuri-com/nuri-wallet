import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The controller binds its production defaults at module load; every test
// injects its own, so the native-backed modules behind those defaults only need
// to exist.
vi.mock("../../lib/secureKeyStorage", () => ({
  abandonInFlightWalletUnlock: vi.fn(),
  clearPrivateKeyMemoryCache: vi.fn(),
  isBiometricPromptDismissal: vi.fn(() => false),
  unlockWalletKeys: vi.fn(),
}));
vi.mock("./WalletKeyRecoveryService", () => ({ recoverWalletKeysFromPasskey: vi.fn() }));
vi.mock("../../lib/support/reportErrorToSupport", () => ({ reportErrorToSupport: vi.fn() }));
vi.mock("../../lib/factoryResetIntent", () => ({
  noteAutoAccessSettled: vi.fn(),
  noteAutoAccessStarted: vi.fn(),
}));
vi.mock("../../lib/OperationLogUtils", () => ({ logWithId: vi.fn() }));

import { WalletAccessController, type WalletAccessDeps } from "./WalletAccessController";

/**
 * The contract these lock: an attempt is finite, at most one runs at a time, a
 * hung provider gives the manual retry back instead of consuming it, and a late
 * result from an abandoned attempt cannot describe the screen.
 */
function makeDeps(overrides: Partial<WalletAccessDeps> = {}): WalletAccessDeps {
  return {
    unlockWalletKeys: vi.fn(async () => ["bitcoin", "ethereum", "nostr"]),
    recoverWalletKeysFromPasskey: vi.fn(async () => "recovered" as const),
    isBiometricPromptDismissal: (error: unknown) =>
      /cancel|lock(ed)?\s?out/i.test(error instanceof Error ? error.message : String(error)),
    abandonInFlightWalletUnlock: vi.fn(),
    clearPrivateKeyMemoryCache: vi.fn(),
    noteAutoAccessStarted: vi.fn(),
    noteAutoAccessSettled: vi.fn(),
    reportErrorToSupport: vi.fn(async () => undefined),
    log: vi.fn(),
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** A provider that presents nothing and never returns. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("WalletAccessController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the wallet unlocked once when the auto attempt succeeds", async () => {
    const deps = makeDeps();
    const controller = new WalletAccessController(deps);

    await expect(controller.requestAccess("auto")).resolves.toEqual({ status: "unlocked" });
    expect(deps.unlockWalletKeys).toHaveBeenCalledTimes(1);
    expect(deps.noteAutoAccessSettled).toHaveBeenCalledWith(true);
    expect(controller.isBusy()).toBe(false);
  });

  it("cannot permanently disable manual retry when the auto attempt never settles", async () => {
    const unlockWalletKeys = vi
      .fn<WalletAccessDeps["unlockWalletKeys"]>()
      .mockImplementationOnce(neverSettles)
      .mockImplementationOnce(async () => ["bitcoin"]);
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    const auto = controller.requestAccess("auto");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(auto).resolves.toEqual({ status: "timeout" });
    // The dead read is released, so the retry performs a real ceremony.
    expect(deps.abandonInFlightWalletUnlock).toHaveBeenCalledTimes(1);
    expect(controller.isBusy()).toBe(false);

    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "unlocked" });
    expect(unlockWalletKeys).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation and lockout retryable without touching storage", async () => {
    const unlockWalletKeys = vi
      .fn<WalletAccessDeps["unlockWalletKeys"]>()
      .mockRejectedValueOnce(new Error("Biometric authentication cancelled"))
      .mockRejectedValueOnce(new Error("Biometric authentication locked out"))
      .mockResolvedValueOnce(["bitcoin"]);
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    await expect(controller.requestAccess("auto")).resolves.toEqual({ status: "cancelled" });
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "cancelled" });
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "unlocked" });
    expect(deps.recoverWalletKeysFromPasskey).not.toHaveBeenCalled();
  });

  it("defers passkey recovery for an unreadable entry to a deliberate tap", async () => {
    const unlockWalletKeys = vi
      .fn<WalletAccessDeps["unlockWalletKeys"]>()
      .mockRejectedValue(new Error("Combined wallet keys entry unavailable"));
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    // Android gates provider UI on user activation, so the automatic attempt
    // asks for the tap instead of starting a second ceremony by itself.
    await expect(controller.requestAccess("auto")).resolves.toEqual({
      status: "recovery_required",
    });
    expect(deps.recoverWalletKeysFromPasskey).not.toHaveBeenCalled();

    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "unlocked" });
    expect(deps.recoverWalletKeysFromPasskey).toHaveBeenCalledTimes(1);
    // …and the tap did NOT repeat the read that just failed. Doing so raises a
    // device-auth prompt already known to fail, with the passkey ceremony
    // behind it: two prompts from one tap.
    expect(unlockWalletKeys).toHaveBeenCalledTimes(1);
  });

  it("forgets the deferred recovery once access is restored", async () => {
    // The verdict belongs to one unreadable entry. After recovery rebuilds it,
    // the next presentation must read it again rather than reaching straight
    // for the passkey.
    const unlockWalletKeys = vi
      .fn<WalletAccessDeps["unlockWalletKeys"]>()
      .mockRejectedValueOnce(new Error("Combined wallet keys entry unavailable"))
      .mockResolvedValue(["bitcoin", "ethereum", "nostr"]);
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    await expect(controller.requestAccess("auto")).resolves.toEqual({
      status: "recovery_required",
    });
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "unlocked" });
    expect(deps.recoverWalletKeysFromPasskey).toHaveBeenCalledTimes(1);

    await expect(controller.requestAccess("auto")).resolves.toEqual({ status: "unlocked" });
    expect(unlockWalletKeys).toHaveBeenCalledTimes(2);
    expect(deps.recoverWalletKeysFromPasskey).toHaveBeenCalledTimes(1);
  });

  it("rejects a passkey from another wallet and stays retryable", async () => {
    const deps = makeDeps({
      unlockWalletKeys: vi.fn(async () => {
        throw new Error("Combined wallet keys entry incomplete");
      }),
      recoverWalletKeysFromPasskey: vi.fn(async () => "wrong_wallet" as const),
    });
    const controller = new WalletAccessController(deps);

    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "wrong_wallet" });
    expect(deps.reportErrorToSupport).toHaveBeenCalledTimes(1);
    expect(controller.isBusy()).toBe(false);
  });

  it("runs one ceremony for rapid repeated taps", async () => {
    let release: (value: string[]) => void = () => {};
    const unlockWalletKeys = vi.fn<WalletAccessDeps["unlockWalletKeys"]>(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    const first = controller.requestAccess("button");
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "in_flight" });
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "in_flight" });
    release(["bitcoin"]);
    await expect(first).resolves.toEqual({ status: "unlocked" });
    expect(unlockWalletKeys).toHaveBeenCalledTimes(1);
  });

  it("does not let an abandoned attempt's late failure surface after a success", async () => {
    let failAbandoned: (error: Error) => void = () => {};
    const unlockWalletKeys = vi
      .fn<WalletAccessDeps["unlockWalletKeys"]>()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((_resolve, reject) => {
            failAbandoned = reject;
          }),
      )
      .mockImplementationOnce(async () => ["bitcoin"]);
    const deps = makeDeps({ unlockWalletKeys });
    const controller = new WalletAccessController(deps);

    const auto = controller.requestAccess("auto");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(auto).resolves.toEqual({ status: "timeout" });

    const retry = await controller.requestAccess("button");
    failAbandoned(new Error("provider returned after the deadline"));
    await vi.advanceTimersByTimeAsync(0);

    expect(retry).toEqual({ status: "unlocked" });
    expect(controller.isBusy()).toBe(false);
    expect(deps.reportErrorToSupport).not.toHaveBeenCalled();
  });

  it("starts at most one ceremony per presentation on startup and resume", async () => {
    const deps = makeDeps({ unlockWalletKeys: vi.fn(neverSettles) });
    const controller = new WalletAccessController(deps);

    const auto = controller.requestAccess("auto");
    // Anything arriving while the ceremony is live — a resume, a tap — is a
    // no-op rather than a second provider prompt.
    await expect(controller.requestAccess("auto")).resolves.toEqual({ status: "in_flight" });
    await expect(controller.requestAccess("button")).resolves.toEqual({ status: "in_flight" });
    expect(deps.unlockWalletKeys).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(auto).resolves.toEqual({ status: "timeout" });
  });

  it("logs only a sanitized phase and bounded error class", async () => {
    const log = vi.fn();
    const secretish = new Error("prf=deadbeefcafe credentialId=AAAA address=0xabc123");
    secretish.name = "KeychainError";
    const deps = makeDeps({
      log,
      unlockWalletKeys: vi.fn(async () => {
        throw secretish;
      }),
      recoverWalletKeysFromPasskey: vi.fn(async () => "unavailable" as const),
    });
    const controller = new WalletAccessController(deps);

    await controller.requestAccess("button");

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("KeychainError");
    expect(logged).not.toContain("deadbeefcafe");
    expect(logged).not.toContain("credentialId");
    expect(logged).not.toContain("0xabc123");
  });
});
