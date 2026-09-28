import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DevDevice, PushToken } from "./notificationTypes";

// The developer-facing address book: which devices the debug tools may push to.
// Deliberately local and manual — devs paste each other's tokens — so that no
// token-collecting endpoint has to exist before the backend sender does.

export const DEV_DEVICES_STORAGE_KEY = "@nuri:dev_push_devices:v1";

let memory: DevDevice[] = [];
let hydrated = false;

const isDevDevice = (value: unknown): value is DevDevice => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.label === "string" &&
    typeof item.token === "string" &&
    item.token.trim().length > 0 &&
    (item.kind === "expo" || item.kind === "web") &&
    typeof item.platform === "string" &&
    typeof item.addedAtMs === "number" &&
    Number.isFinite(item.addedAtMs)
  );
};

const persist = async () => {
  if (!hydrated) return;
  try {
    await AsyncStorage.setItem(DEV_DEVICES_STORAGE_KEY, JSON.stringify(memory));
  } catch {}
};

async function hydrate(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(DEV_DEVICES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    memory = Array.isArray(parsed) ? parsed.filter(isDevDevice) : [];
  } catch {
    memory = [];
  }
  hydrated = true;
}

export async function listDevDevices(): Promise<DevDevice[]> {
  await hydrate();
  return [...memory];
}

/** Adds or refreshes a device. The token is the identity, so re-adding the same
 *  token renames the entry instead of duplicating it. */
export async function saveDevDevice(device: {
  label: string;
  token: string;
  kind: DevDevice["kind"];
  platform: string;
}): Promise<DevDevice[]> {
  await hydrate();
  const token = device.token.trim();
  if (!token) return [...memory];
  const entry: DevDevice = {
    label: device.label.trim() || "unnamed device",
    token,
    kind: device.kind,
    platform: device.platform,
    addedAtMs: Date.now(),
  };
  memory = [entry, ...memory.filter((existing) => existing.token !== token)];
  await persist();
  return [...memory];
}

/** Registers the device this app runs on, so it appears alongside the others. */
export async function saveThisDevice(label: string, token: PushToken): Promise<DevDevice[]> {
  return saveDevDevice({
    label,
    token: token.value,
    kind: token.kind,
    platform: token.platform,
  });
}

export async function removeDevDevice(token: string): Promise<DevDevice[]> {
  await hydrate();
  memory = memory.filter((existing) => existing.token !== token);
  await persist();
  return [...memory];
}
