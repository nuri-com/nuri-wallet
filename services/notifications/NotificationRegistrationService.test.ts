import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage so a wipe can be observed rather than asserted on a spy.
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) store.delete(k);
    }),
  },
}));

vi.mock("../../config/network", () => ({ NOTIFICATIONS_API_BASE_URL: "https://notify.test" }));

const mocks = vi.hoisted(() => ({
  getPermission: vi.fn(),
  getPushToken: vi.fn(),
  requestPermission: vi.fn(),
  bind: vi.fn(),
  assertion: vi.fn(),
  wirexBind: vi.fn(),
}));

vi.mock("./NotificationService", () => ({
  getPermission: mocks.getPermission,
  getPushToken: mocks.getPushToken,
  requestPermission: mocks.requestPermission,
}));
vi.mock("../arkade/ArkadeApiService", () => ({
  arkadeBindNotificationSubscription: mocks.bind,
}));
vi.mock("../arkade/internal/identity", () => ({
  getArkadeLnurlAssertion: mocks.assertion,
}));
vi.mock("../wirex/WirexService", () => ({
  wirexService: { bindNotificationSubscription: mocks.wirexBind },
}));

import {
  bindSubscriptionWithWirex,
  clearPushNotificationStorage,
  unregisterPushDevice,
  getSubscriptionId,
  PUSH_BINDING_STORAGE_KEY,
  PUSH_REGISTRATION_STORAGE_KEY,
  PUSH_SUBSCRIPTION_ID_STORAGE_KEY,
  registerPushToken,
} from "./NotificationRegistrationService";

const ASSERTION = {
  token: "t",
  clientDataB64u: "c",
  authDataB64u: "a",
  sigB64u: "s",
};

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mocks.getPermission.mockResolvedValue("granted");
  mocks.getPushToken.mockResolvedValue({
    kind: "expo",
    value: "ExponentPushToken[device-a]",
    platform: "ios",
  });
  mocks.assertion.mockResolvedValue(ASSERTION);
  mocks.bind.mockResolvedValue(undefined);
  mocks.wirexBind.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response),
  );
});

describe("subscription id", () => {
  it("is minted once and reused", async () => {
    const first = await getSubscriptionId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await getSubscriptionId()).toBe(first);
  });
});

describe("wallet wipe", () => {
  // The regression that matters: these keys live in AsyncStorage, which
  // wipeAllKeychainData does not touch. If a reset leaves them behind, the next
  // wallet reuses the old subscription and the caches suppress both the
  // re-register and the re-bind — so the device keeps receiving the previous
  // wallet's payment notifications.
  it("old wallet → wipe → new wallet gets a fresh subscription and re-registers", async () => {
    const before = await registerPushToken({ prompt: true });
    expect(before.kind).toBe("registered");
    const oldSubscription = await getSubscriptionId();
    expect(store.get(PUSH_REGISTRATION_STORAGE_KEY)).toBeDefined();
    expect(store.get(PUSH_BINDING_STORAGE_KEY)).toBe(oldSubscription);

    await clearPushNotificationStorage();

    expect(store.has(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe(false);
    expect(store.has(PUSH_REGISTRATION_STORAGE_KEY)).toBe(false);
    expect(store.has(PUSH_BINDING_STORAGE_KEY)).toBe(false);

    const newSubscription = await getSubscriptionId();
    expect(newSubscription).not.toBe(oldSubscription);

    vi.clearAllMocks();
    mocks.assertion.mockResolvedValue(ASSERTION);
    mocks.bind.mockResolvedValue(undefined);
    const after = await registerPushToken({ prompt: true });

    expect(after.kind).toBe("registered");
    // Re-registered and re-bound under the NEW subscription, not the old one.
    expect(mocks.bind).toHaveBeenCalledWith(ASSERTION, newSubscription);
    expect(store.get(PUSH_BINDING_STORAGE_KEY)).toBe(newSubscription);
  });
});

describe("reset", () => {
  it("tells the server to forget the device before the local state goes", async () => {
    // The push token survives a wallet wipe, so clearing only locally leaves
    // the PREVIOUS wallet's subscription pointing at a token that still works —
    // this device would keep receiving that wallet's payment notifications.
    await registerPushToken({ prompt: true });
    const subscriptionId = await getSubscriptionId();
    const posts = vi.mocked(globalThis.fetch);
    posts.mockClear();

    await unregisterPushDevice();

    const [url, init] = posts.mock.calls[0] ?? [];
    expect(String(url)).toContain("/devices/unregister");
    expect(String(url)).toBe("https://notify.test/devices/unregister");
    expect(JSON.parse(String((init as RequestInit)?.body))).toEqual({
      subscriptionId,
      token: "ExponentPushToken[device-a]",
    });
  });

  it("reports the server outcome for the debug tools", async () => {
    await registerPushToken({ prompt: true });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as unknown as Response);

    // 204 is the server's answer for both a deleted row and an unknown token —
    // either way it is done with this device.
    expect(await unregisterPushDevice()).toEqual({ ok: true, detail: "unregistered (HTTP 204)" });
  });

  it("reports a failure instead of claiming success", async () => {
    await registerPushToken({ prompt: true });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
    } as unknown as Response);

    expect(await unregisterPushDevice()).toEqual({ ok: false, detail: "HTTP 400" });
  });

  it("sends nothing when the device was never registered", async () => {
    const posts = vi.mocked(globalThis.fetch);
    posts.mockClear();

    await unregisterPushDevice();

    expect(posts).not.toHaveBeenCalled();
  });

  it("clears the local state even when the server call fails", async () => {
    // A reset must complete offline.
    await registerPushToken({ prompt: true });
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("offline"));

    await unregisterPushDevice();
    await clearPushNotificationStorage();

    expect(store.has(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe(false);
    expect(store.has(PUSH_REGISTRATION_STORAGE_KEY)).toBe(false);
    expect(store.has(PUSH_BINDING_STORAGE_KEY)).toBe(false);
  });
});

describe("opt-in", () => {
  it("reports not-bound when arkade never vouched", async () => {
    // A cancelled Face ID yields no assertion. Reporting "registered" here
    // would claim notifications are on while the server cannot route to us.
    mocks.assertion.mockResolvedValue(null);

    const state = await registerPushToken({ prompt: true });

    expect(state).toEqual({ kind: "disabled", reason: "not-bound" });
    expect(store.has(PUSH_BINDING_STORAGE_KEY)).toBe(false);
  });

  it("prompts for the assertion on opt-in but not on the silent sync", async () => {
    await registerPushToken({ prompt: true });
    expect(mocks.assertion).toHaveBeenCalledWith(expect.any(String), true);

    await clearPushNotificationStorage();
    vi.clearAllMocks();
    mocks.assertion.mockResolvedValue(ASSERTION);

    // The silent path deliberately does not await the bind, so let it settle.
    await registerPushToken({ prompt: false });
    await vi.waitFor(() => expect(mocks.assertion).toHaveBeenCalledWith(expect.any(String), false));
  });

  it("binds only once for an unchanged subscription", async () => {
    await registerPushToken({ prompt: true });
    expect(mocks.bind).toHaveBeenCalledTimes(1);

    await registerPushToken({ prompt: true });
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });
});

describe("wirex namespace", () => {
  it("binds the same subscription arkade got, so one device serves both rails", async () => {
    await registerPushToken({ prompt: true });

    const subscriptionId = await getSubscriptionId();
    expect(mocks.bind).toHaveBeenCalledWith(ASSERTION, subscriptionId);
    await vi.waitFor(() => expect(mocks.wirexBind).toHaveBeenCalledWith(subscriptionId));
  });

  it("re-sends on every registration — the server may have cascaded it away", async () => {
    // Unlike the arkade bind there is no local cache: the POST is free once a
    // session exists, and a cached "already bound" would leave a device that a
    // token change unbound silent forever.
    await registerPushToken({ prompt: true });
    await vi.waitFor(() => expect(mocks.wirexBind).toHaveBeenCalledTimes(1));

    await registerPushToken({ prompt: true });
    await vi.waitFor(() => expect(mocks.wirexBind).toHaveBeenCalledTimes(2));
  });

  it("never turns a failed wirex bind into 'notifications are off'", async () => {
    // No Wirex read session is cached for every account without a card. Gating
    // the opt-in on this would break Lightning notifications for those users.
    mocks.wirexBind.mockResolvedValue(false);

    expect((await registerPushToken({ prompt: true })).kind).toBe("registered");
  });

  it("does nothing until a device is registered", async () => {
    // Binding a subscription no push token answers only creates a dead row.
    expect(await bindSubscriptionWithWirex()).toBe(false);
    expect(mocks.wirexBind).not.toHaveBeenCalled();
  });
});
