import { beforeEach, describe, expect, it, vi } from "vitest";

// Taner #3 (ed72f14e) — the canonical wipe (logout and the in-process
// `/@username` wallet replacement both use it) cleared keys without stopping
// v2 trackers. It must drain them first, and must not wipe if it cannot.
const order: string[] = [];
const mocks = vi.hoisted(() => ({
  stopAll: vi.fn(),
  resumeIntake: vi.fn(),
  clearAllData: vi.fn(),
  wipeKeychain: vi.fn(),
  v2Clear: vi.fn(),
}));

vi.mock("expo-updates", () => ({ reloadAsync: vi.fn() }));
vi.mock("../auth/AuthStateService", () => ({
  authStateManager: { clearAllData: mocks.clearAllData, clearPreviousAddresses: vi.fn() },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn().mockResolvedValue("0xA"),
  verifyCriticalKeysAbsent: vi.fn().mockResolvedValue([]),
  wipeAllKeychainData: mocks.wipeKeychain,
}));
vi.mock("../../lib/wirex/pendingWithdrawKey", () => ({
  pendingWithdrawKeyFor: (w: string) => `p:${w}`,
}));
vi.mock("../../lib/accountEmail", () => ({ accountEmailKeyFor: (w: string) => `e:${w}` }));
vi.mock("../arkade/ArkadeServerConfigService", () => ({
  arkadeServerConfigService: { reset: vi.fn() },
}));
vi.mock("../balance/TransactionCacheService", () => ({ deleteCacheDatabase: vi.fn() }));
vi.mock("../bitcoin/SigningContextStore", () => ({ clearAllContexts: vi.fn() }));
vi.mock("../arkade/ArkadeRecoveryBackupService", () => ({ clearAllArkadeLocalStorage: vi.fn() }));
vi.mock("./PendingPurchasesStore", () => ({ PendingPurchasesStore: { clear: vi.fn() } }));
vi.mock("../mercuryo/MercuryoOrderStore", () => ({ MercuryoOrderStore: { clear: vi.fn() } }));
vi.mock("../mercuryo/MercuryoPendingTracker", () => ({ stopAllMercuryoTracking: vi.fn() }));
vi.mock("./wipeStorageKeys", () => ({ WIPE_EXTRA_STORAGE_KEYS: [] }));
vi.mock("../notifications/NotificationRegistrationService", () => ({
  clearPushNotificationStorage: vi.fn(),
  unregisterPushDevice: vi.fn(),
}));
vi.mock("../swapkit/SwapKitOrderStore", () => ({ SwapKitOrderStore: { clear: vi.fn() } }));
vi.mock("../swapkit/SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { clear: mocks.v2Clear },
}));
vi.mock("../swapkit/SwapKitV2MoveAccounting", () => ({ clearV2MoveAccounting: vi.fn() }));
vi.mock("../swapkit/SwapKitV2MoveStatus", () => ({ clearV2Moves: vi.fn() }));
vi.mock("../swapkit/SwapKitV2PendingTracker", () => ({
  stopAllSwapKitV2Tracking: mocks.stopAll,
  resumeSwapKitV2TrackingIntake: mocks.resumeIntake,
}));

import { wipeLocalWalletData } from "./FactoryResetService";

beforeEach(() => {
  order.length = 0;
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.clearAllData.mockImplementation(async () => void order.push("clearAllData"));
  mocks.wipeKeychain.mockImplementation(async () => void order.push("wipeKeychain"));
  mocks.v2Clear.mockImplementation(async () => void order.push("v2StoreClear"));
  mocks.resumeIntake.mockImplementation(() => void order.push("intakeReopened"));
});

describe("wipeLocalWalletData · v2 trackers", () => {
  it("stops the v2 trackers before touching auth or keys, without waiting", async () => {
    mocks.stopAll.mockImplementation(() => void order.push("trackersStopped"));
    await wipeLocalWalletData();
    expect(order[0]).toBe("trackersStopped");
    expect(order.indexOf("clearAllData")).toBeGreaterThan(0);
    expect(order).toContain("v2StoreClear");
    expect(order.at(-1)).toBe("intakeReopened");
  });
});
