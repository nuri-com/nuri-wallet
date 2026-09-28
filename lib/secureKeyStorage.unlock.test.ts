// Who is allowed to clear the session keys.
//
// An abandoned read keeps running — the native ceremony has no abort — so a
// timed-out first attempt and the retry that replaced it are alive at the same
// time. The retry wins the screen; the first attempt's late failure must not
// then wipe the keys the retry installed, or the app sits unlocked with no
// session keys and the next signature fails.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64url } from "./crypto";

const getInternetCredentials = vi.fn();
const setInternetCredentials = vi.fn(async () => true);

vi.mock("react-native-keychain", () => ({
  getInternetCredentials,
  setInternetCredentials,
  resetInternetCredentials: vi.fn(async () => true),
  ACCESS_CONTROL: {
    BIOMETRY_CURRENT_SET: "BiometryCurrentSet",
    BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: "BiometryCurrentSetOrDevicePasscode",
    DEVICE_PASSCODE: "DevicePasscode",
  },
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WhenUnlockedThisDeviceOnly" },
  SECURITY_LEVEL: { SECURE_HARDWARE: "SECURE_HARDWARE" },
  STORAGE_TYPE: {},
  SECURITY_RULES: {},
}));

vi.mock("./OperationLogUtils", () => ({
  logWithId: vi.fn(),
  errorWithId: vi.fn(),
}));

const WALLET_KEYS_ID = "wallet_private_keys";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const BITCOIN = key(0x11);
const ETHEREUM = key(0x22);

const combinedEntry = () => ({
  username: WALLET_KEYS_ID,
  password: JSON.stringify({
    bitcoin: bytesToBase64url(BITCOIN),
    ethereum: bytesToBase64url(ETHEREUM),
  }),
});

describe("abandoned wallet unlock", () => {
  beforeEach(() => {
    getInternetCredentials.mockReset();
    setInternetCredentials.mockClear();
  });

  it("keeps the retry's keys when the abandoned read fails afterwards", async () => {
    const {
      unlockWalletKeys,
      abandonInFlightWalletUnlock,
      getPrivateKey,
      clearPrivateKeyMemoryCache,
    } = await import("./secureKeyStorage");
    clearPrivateKeyMemoryCache();
    abandonInFlightWalletUnlock();

    // The first protected read never settles on its own — the provider that
    // shows no UI. Its rejection is held until after the retry has succeeded.
    let failFirstRead: (error: unknown) => void = () => {};
    const hung = new Promise((_resolve, reject) => {
      failFirstRead = reject;
    });
    getInternetCredentials.mockImplementationOnce(() => hung);

    const abandonedAttempt = unlockWalletKeys();
    void abandonedAttempt.catch(() => {});

    // The lock screen times the attempt out and retries.
    abandonInFlightWalletUnlock();
    getInternetCredentials.mockImplementation(async (server: string) =>
      server === WALLET_KEYS_ID ? combinedEntry() : false,
    );
    await expect(unlockWalletKeys()).resolves.toEqual(["bitcoin", "ethereum", "nostr"]);

    // …and only now does the first attempt fall over.
    failFirstRead(new Error("Provider never presented UI"));
    await expect(abandonedAttempt).rejects.toThrow();

    // The keys the retry installed are still there. The keychain is not asked
    // again, so this can only be the session cache answering.
    getInternetCredentials.mockRejectedValue(new Error("keychain must not be read again"));
    await expect(getPrivateKey("ethereum")).resolves.toEqual(ETHEREUM);
    await expect(getPrivateKey("bitcoin")).resolves.toEqual(BITCOIN);
  });

  it("keeps the abandoned read's keys when the live retry fails afterwards", async () => {
    // The same race the other way round: the first attempt is the one that
    // lands. It unlocked the session, so the retry's later failure is the one
    // that no longer speaks for it.
    const {
      unlockWalletKeys,
      abandonInFlightWalletUnlock,
      getPrivateKey,
      clearPrivateKeyMemoryCache,
    } = await import("./secureKeyStorage");
    clearPrivateKeyMemoryCache();
    abandonInFlightWalletUnlock();

    let landFirstRead: (entry: unknown) => void = () => {};
    let failRetry: (error: unknown) => void = () => {};
    const reads = [
      new Promise((resolve) => {
        landFirstRead = resolve;
      }),
      new Promise((_resolve, reject) => {
        failRetry = reject;
      }),
    ];
    getInternetCredentials.mockImplementation((server: string) =>
      server === WALLET_KEYS_ID
        ? (reads.shift() ?? Promise.resolve(false))
        : Promise.resolve(false),
    );

    const abandonedAttempt = unlockWalletKeys();
    void abandonedAttempt.catch(() => {});
    abandonInFlightWalletUnlock();
    const retry = unlockWalletKeys();
    void retry.catch(() => {});

    // The abandoned ceremony finally presents and the user answers it.
    landFirstRead(combinedEntry());
    await expect(abandonedAttempt).resolves.toEqual(["bitcoin", "ethereum", "nostr"]);

    failRetry(new Error("Provider gave up"));
    await expect(retry).rejects.toThrow();

    getInternetCredentials.mockRejectedValue(new Error("keychain must not be read again"));
    await expect(getPrivateKey("ethereum")).resolves.toEqual(ETHEREUM);
  });

  it("still clears the session keys when the live attempt is the one that fails", async () => {
    const {
      unlockWalletKeys,
      getPrivateKey,
      clearPrivateKeyMemoryCache,
      abandonInFlightWalletUnlock,
    } = await import("./secureKeyStorage");
    clearPrivateKeyMemoryCache();
    abandonInFlightWalletUnlock();

    getInternetCredentials.mockImplementation(async (server: string) =>
      server === WALLET_KEYS_ID ? combinedEntry() : false,
    );
    await expect(unlockWalletKeys()).resolves.toContain("ethereum");

    // Nothing was abandoned, so this failure speaks for the session and the
    // fail-closed wipe must still happen.
    getInternetCredentials.mockRejectedValue(new Error("Keychain entry invalidated"));
    await expect(unlockWalletKeys()).rejects.toThrow();
    await expect(getPrivateKey("ethereum")).rejects.toThrow();
  });
});
