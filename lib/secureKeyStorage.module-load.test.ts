// Regression (PR #1292 review): importing secureKeyStorage must NOT evaluate
// expo-local-authentication — the Android-only native module throws at module load on binaries
// that don't include it, and App.tsx imports this module at startup. The lazy import inside
// resolveBiometricAccessControl is a documented exception to the no-dynamic-imports rule.
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-local-authentication", () => {
  throw new Error("native module absent (legacy binary)");
});

// react-native-keychain ships Flow syntax vitest cannot parse; the module-load guarantee is about
// expo-local-authentication, so keychain is stubbed like the existing secureKeyStorage tests do.
vi.mock("react-native-keychain", () => ({
  ACCESS_CONTROL: {},
  ACCESSIBLE: {},
  SECURITY_LEVEL: {},
  STORAGE_TYPE: {},
  SECURITY_RULES: {},
}));

describe("secureKeyStorage module load", () => {
  it("imports cleanly with expo-local-authentication absent (iOS/legacy binary)", async () => {
    await expect(import("./secureKeyStorage")).resolves.toBeTypeOf("object");
  });
});
