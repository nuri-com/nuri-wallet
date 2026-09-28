import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wipe's own dependencies are native (keychain, expo-updates) and are
// mocked wholesale. What is under test is the GATE: which failures are allowed
// to reach `Updates.reloadAsync()`, because a relaunch is what puts the user in
// front of a neutral welcome screen where any passkey may sign in.
const mocks = vi.hoisted(() => ({
  reloadAsync: vi.fn(),
  clearAllData: vi.fn(),
  clearPreviousAddresses: vi.fn(),
  setLoginHintAfterWipe: vi.fn(),
  verifyCriticalKeysAbsent: vi.fn(),
  wipeAllKeychainData: vi.fn(),
  getEthereumAddress: vi.fn(),
  storeAuthData: vi.fn(),
  deleteCacheKeys: vi.fn(),
  unregisterPushDevice: vi.fn(),
  clearPushNotificationStorage: vi.fn(),
  stopAllSwapKitV2Tracking: vi.fn(),
}));

vi.mock("expo-updates", () => ({ reloadAsync: mocks.reloadAsync }));
vi.mock("../auth/AuthStateService", () => ({
  authStateManager: {
    clearAllData: mocks.clearAllData,
    clearPreviousAddresses: mocks.clearPreviousAddresses,
    setLoginHintAfterWipe: mocks.setLoginHintAfterWipe,
  },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  storeAuthData: mocks.storeAuthData,
  verifyCriticalKeysAbsent: mocks.verifyCriticalKeysAbsent,
  wipeAllKeychainData: mocks.wipeAllKeychainData,
}));
vi.mock("../../lib/wirex/pendingWithdrawKey", () => ({
  pendingWithdrawKeyFor: (w: string) => `pending:${w}`,
}));
vi.mock("../../lib/accountEmail", () => ({ accountEmailKeyFor: (w: string) => `email:${w}` }));
vi.mock("../arkade/ArkadeServerConfigService", () => ({
  arkadeServerConfigService: { reset: vi.fn() },
}));
vi.mock("../balance/TransactionCacheService", () => ({ deleteCacheKeys: mocks.deleteCacheKeys }));
vi.mock("../bitcoin/SigningContextStore", () => ({ clearAllContexts: vi.fn() }));
vi.mock("./PendingPurchasesStore", () => ({ PendingPurchasesStore: { clear: vi.fn() } }));
vi.mock("../mercuryo/MercuryoOrderStore", () => ({ MercuryoOrderStore: { clear: vi.fn() } }));
vi.mock("../mercuryo/MercuryoPendingTracker", () => ({ stopAllMercuryoTracking: vi.fn() }));
vi.mock("../swapkit/SwapKitOrderStore", () => ({ SwapKitOrderStore: { clear: vi.fn() } }));
vi.mock("../swapkit/SwapKitV2PendingTracker", () => ({
  stopAllSwapKitV2Tracking: mocks.stopAllSwapKitV2Tracking,
}));
// Soft logout clears the v2 move accounting, which reads the balance stores.
// Those pull expo-sqlite/react-native-keychain through their own graphs, which
// this node-environment suite has no business loading.
vi.mock("../balance/WalletBalanceStore", () => ({
  walletBalanceStore: {
    getSnapshot: () => ({ balanceEur: null as number | null }),
    applyOptimisticDebit: vi.fn(),
  },
}));
vi.mock("../balance/UsdcBalanceStore", () => ({
  usdcBalanceStore: {
    getSnapshot: () => ({ balanceUsd: null as number | null }),
    applyOptimisticDebit: vi.fn(),
  },
}));
vi.mock("../bitcoin/BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: { revertArkadeOutgoingBalance: vi.fn() },
}));
vi.mock("./wipeStorageKeys", () => ({ WIPE_EXTRA_STORAGE_KEYS: [] }));
vi.mock("../notifications/NotificationRegistrationService", () => ({
  clearPushNotificationStorage: mocks.clearPushNotificationStorage,
  unregisterPushDevice: mocks.unregisterPushDevice,
}));

import { performSoftLogoutForRelogin } from "./SoftLogoutService";

const HINT = { credIdB64u: "cred-a" };

describe("performSoftLogoutForRelogin · the relaunch gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getEthereumAddress.mockResolvedValue("0xA");
    mocks.verifyCriticalKeysAbsent.mockResolvedValue([]);
    mocks.clearPreviousAddresses.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flushReload = async () => {
    await vi.advanceTimersByTimeAsync(400);
  };

  it("drops the previous-address list when no hint is preserved", async () => {
    await performSoftLogoutForRelogin();
    await flushReload();

    // Hint-less means the next sign-in may be a different account, so account
    // A's addresses may not survive into account B's transaction views (#671).
    expect(mocks.clearPreviousAddresses).toHaveBeenCalledTimes(1);
    expect(mocks.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps the list when a hint says the same user is coming back", async () => {
    await performSoftLogoutForRelogin({ preserveHint: HINT });
    await flushReload();

    expect(mocks.clearPreviousAddresses).not.toHaveBeenCalled();
    expect(mocks.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("refuses to relaunch when the previous-address list survives the delete", async () => {
    mocks.clearPreviousAddresses.mockRejectedValue(
      new Error("Previous-address list still present after delete"),
    );

    await expect(performSoftLogoutForRelogin()).rejects.toThrow(/previous_addresses/);
    await flushReload();

    // The whole point: a best-effort delete that silently failed used to end in
    // a neutral welcome screen, where the next passkey inherits A's addresses.
    expect(mocks.reloadAsync).not.toHaveBeenCalled();
  });

  it("still refuses to relaunch on a residual key", async () => {
    mocks.verifyCriticalKeysAbsent.mockResolvedValue(["ethereum"]);

    await expect(performSoftLogoutForRelogin()).rejects.toThrow(/ethereum/);
    await flushReload();

    expect(mocks.reloadAsync).not.toHaveBeenCalled();
  });

  it("names every survivor when both fail", async () => {
    mocks.verifyCriticalKeysAbsent.mockResolvedValue(["ethereum"]);
    mocks.clearPreviousAddresses.mockRejectedValue(new Error("nope"));

    await expect(performSoftLogoutForRelogin()).rejects.toThrow(/ethereum, previous_addresses/);
    await flushReload();

    expect(mocks.reloadAsync).not.toHaveBeenCalled();
  });

  it("does not re-stash a login hint when the gate aborts", async () => {
    mocks.verifyCriticalKeysAbsent.mockResolvedValue(["auth"]);

    await expect(performSoftLogoutForRelogin({ preserveHint: HINT })).rejects.toThrow();

    expect(mocks.setLoginHintAfterWipe).not.toHaveBeenCalled();
  });
});

describe("performSoftLogoutForRelogin · v2 swap loops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getEthereumAddress.mockResolvedValue("0xA");
    mocks.verifyCriticalKeysAbsent.mockResolvedValue([]);
    mocks.clearPreviousAddresses.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the v2 swap loops before any wipe, without waiting for them", async () => {
    const order: string[] = [];
    mocks.stopAllSwapKitV2Tracking.mockImplementation(() => void order.push("loopsStopped"));
    mocks.clearAllData.mockImplementation(async () => void order.push("clearAllData"));
    await performSoftLogoutForRelogin();
    await vi.advanceTimersByTimeAsync(400);
    expect(order.slice(0, 2)).toEqual(["loopsStopped", "clearAllData"]);
  });
});
