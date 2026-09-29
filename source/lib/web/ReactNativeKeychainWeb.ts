/**
 * Web (PWA) implementation of `react-native-keychain`, aliased in on web via
 * metro.config.js. The native package has no web build, so direct callers
 * (AuthStateService, SupportDump, BiometricLockModal) would hit
 * `undefined.getInternetCredentials` in a browser.
 *
 * Backed by localStorage, no biometrics (the co-signer is the second factor).
 * Returns the same shapes react-native-keychain does: getInternetCredentials ->
 * `false` on miss or `{ service, username, password, storage }` on hit.
 */

const PREFIX = "nuri.kc.";
const mem = new Map<string, string>();

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
function put(server: string, value: string): void {
  const s = ls();
  if (s) {
    try {
      s.setItem(PREFIX + server, value);
      return;
    } catch {}
  }
  mem.set(server, value);
}
function read(server: string): string | null {
  const s = ls();
  if (s) {
    try {
      const v = s.getItem(PREFIX + server);
      if (v !== null) return v;
    } catch {}
  }
  return mem.has(server) ? (mem.get(server) as string) : null;
}
function drop(server: string): void {
  const s = ls();
  if (s) {
    try {
      s.removeItem(PREFIX + server);
    } catch {}
  }
  mem.delete(server);
}
function serverOf(arg: string | { server?: string } | undefined): string {
  return typeof arg === "string" ? arg : (arg?.server ?? "");
}

export type UserCredentials = {
  service: string;
  username: string;
  password: string;
  storage: string;
};

export async function setInternetCredentials(
  server: string,
  username: string,
  password: string,
  _options?: unknown,
): Promise<{ service: string } | false> {
  put(server, JSON.stringify({ username, password }));
  return { service: server };
}

export async function getInternetCredentials(
  server: string,
  _options?: unknown,
): Promise<UserCredentials | false> {
  const raw = read(server);
  if (!raw) return false;
  try {
    const { username, password } = JSON.parse(raw) as { username: string; password: string };
    return { service: server, username, password, storage: "web_localStorage" };
  } catch {
    return false;
  }
}

export async function resetInternetCredentials(arg: string | { server?: string }): Promise<void> {
  const server = serverOf(arg);
  if (server) drop(server);
}

export async function hasInternetCredentials(arg: string | { server?: string }): Promise<boolean> {
  const server = serverOf(arg);
  return server ? read(server) !== null : false;
}

export async function getSupportedBiometryType(): Promise<null> {
  return null; // no biometrics in a browser
}

export async function getAllGenericPasswordServices(): Promise<string[]> {
  return [];
}
export async function resetGenericPassword(_options?: unknown): Promise<boolean> {
  return true;
}
export async function getGenericPassword(_options?: unknown): Promise<false> {
  return false;
}
export async function setGenericPassword(): Promise<false> {
  return false;
}

export const ACCESSIBLE = {
  WHEN_UNLOCKED: "AccessibleWhenUnlocked",
  AFTER_FIRST_UNLOCK: "AccessibleAfterFirstUnlock",
  ALWAYS: "AccessibleAlways",
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: "AccessibleWhenPasscodeSetThisDeviceOnly",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "AccessibleWhenUnlockedThisDeviceOnly",
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "AccessibleAfterFirstUnlockThisDeviceOnly",
} as const;

export const ACCESS_CONTROL = {
  USER_PRESENCE: "UserPresence",
  BIOMETRY_ANY: "BiometryAny",
  BIOMETRY_CURRENT_SET: "BiometryCurrentSet",
  DEVICE_PASSCODE: "DevicePasscode",
  APPLICATION_PASSWORD: "ApplicationPassword",
  BIOMETRY_ANY_OR_DEVICE_PASSCODE: "BiometryAnyOrDevicePasscode",
  BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: "BiometryCurrentSetOrDevicePasscode",
} as const;

export const BIOMETRY_TYPE = {
  TOUCH_ID: "TouchID",
  FACE_ID: "FaceID",
  OPTIC_ID: "OpticID",
  FINGERPRINT: "Fingerprint",
  FACE: "Face",
  IRIS: "Iris",
} as const;

export const SECURITY_LEVEL = {
  SECURE_SOFTWARE: "SECURE_SOFTWARE",
  SECURE_HARDWARE: "SECURE_HARDWARE",
  ANY: "ANY",
} as const;

export const STORAGE_TYPE = {
  FB: "FacebookConceal",
  AES: "KeystoreAESCBC",
  AES_CBC: "KeystoreAESCBC",
  AES_GCM_NO_AUTH: "KeystoreAESGCM_NoAuth",
  AES_GCM: "KeystoreAESGCM",
  RSA: "KeystoreRSAECB",
} as const;

export const AUTHENTICATION_TYPE = {
  DEVICE_PASSCODE_OR_BIOMETRICS: "AuthenticationWithBiometricsDevicePasscode",
  BIOMETRICS: "AuthenticationWithBiometrics",
} as const;

export default {
  setInternetCredentials,
  getInternetCredentials,
  resetInternetCredentials,
  hasInternetCredentials,
  getSupportedBiometryType,
  getAllGenericPasswordServices,
  resetGenericPassword,
  getGenericPassword,
  setGenericPassword,
  ACCESSIBLE,
  ACCESS_CONTROL,
  BIOMETRY_TYPE,
  SECURITY_LEVEL,
  STORAGE_TYPE,
  AUTHENTICATION_TYPE,
};
