// What the protected read is allowed to SAY when the keychain refuses.
//
// The controller above it already logs class and code only, but it never sees
// the provider error until this module has finished with it — so the contract
// has to hold here, on the real failure path, with the keychain itself as the
// thing that throws. A provider message is unbounded and attacker-influenced,
// and this log travels with a support report.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getInternetCredentials = vi.fn();
const logged: unknown[] = [];

vi.mock("react-native-keychain", () => ({
  getInternetCredentials,
  setInternetCredentials: vi.fn(async () => true),
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
  logWithId: (emoji: string, message: string, data?: unknown) => {
    logged.push({ emoji, message, data });
  },
  errorWithId: (emoji: string, message: string, error?: unknown) => {
    logged.push({ emoji, message, error });
  },
}));

// A keychain message that carries exactly what must never be logged: a
// credential id, an address, and something PRF-shaped.
const SECRET =
  "Keychain error for credentialId=AbC123-passkey-cred addr=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef prf=9f8e7d6c5b4a";

describe("secure key storage failure logging", () => {
  beforeEach(() => {
    logged.length = 0;
    getInternetCredentials.mockReset();
  });

  it("never repeats the keychain's own message", async () => {
    const { unlockWalletKeys, abandonInFlightWalletUnlock } = await import("./secureKeyStorage");
    abandonInFlightWalletUnlock();
    const error = Object.assign(new Error(SECRET), { name: "KeychainError", code: "E_AUTH" });
    getInternetCredentials.mockRejectedValue(error);

    await expect(unlockWalletKeys()).rejects.toThrow();

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("credentialId");
    expect(serialized).not.toContain("0xdeadbeef");
    expect(serialized).not.toContain("prf=");
    // The class and the code are what a report gets instead.
    const blocked = logged.find(
      (entry) => (entry as { message?: string }).message === "combined wallet unlock blocked",
    ) as { data?: Record<string, unknown> } | undefined;
    expect(blocked?.data).toEqual({ errClass: "KeychainError", errCode: "E_AUTH" });
  });

  it("says something even when the failure carries no name or code", async () => {
    const { unlockWalletKeys, abandonInFlightWalletUnlock } = await import("./secureKeyStorage");
    abandonInFlightWalletUnlock();
    getInternetCredentials.mockRejectedValue(SECRET);

    await expect(unlockWalletKeys()).rejects.toThrow();

    expect(JSON.stringify(logged)).not.toContain("credentialId");
    const blocked = logged.find(
      (entry) => (entry as { message?: string }).message === "combined wallet unlock blocked",
    ) as { data?: Record<string, unknown> } | undefined;
    expect(blocked?.data).toEqual({ errClass: "String" });
  });
});
