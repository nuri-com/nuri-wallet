import { beforeEach, describe, expect, it, vi } from "vitest";

// Models the one piece of Expo state this is about: a single process-wide "last
// notification response" slot that both the tap listener and cold start read.
const expo = vi.hoisted(() => {
  let lastResponse: unknown = null;
  let tapListener: ((event: unknown) => void) | null = null;
  let pushTokenListener: (() => void) | null = null;
  // While holding, each token fetch parks on its own gate, so a test can release
  // exactly one and leave the other genuinely in flight.
  let holding = false;
  let gates: Array<() => void> = [];
  return {
    get lastResponse() {
      return lastResponse;
    },
    setLastResponse(value: unknown) {
      lastResponse = value;
    },
    tap(event: unknown) {
      lastResponse = event;
      tapListener?.(event);
    },
    rotateToken() {
      pushTokenListener?.();
    },
    holdFetches() {
      holding = true;
      gates = [];
    },
    pendingFetches() {
      return gates.length;
    },
    releaseOneFetch() {
      gates.shift()?.();
    },
    releaseAllFetches() {
      holding = false;
      for (const open of gates.splice(0)) open();
    },
    module: {
      setNotificationHandler: vi.fn(),
      setNotificationChannelAsync: vi.fn().mockResolvedValue(undefined),
      AndroidImportance: { MAX: 5 },
      SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
      getLastNotificationResponseAsync: vi.fn(async () => lastResponse),
      clearLastNotificationResponseAsync: vi.fn(async () => {
        lastResponse = null;
      }),
      addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
      addNotificationResponseReceivedListener: vi.fn((listener: (e: unknown) => void) => {
        tapListener = listener;
        return { remove: vi.fn() };
      }),
      addPushTokenListener: vi.fn((listener: () => void) => {
        pushTokenListener = listener;
        return { remove: vi.fn() };
      }),
      getPermissionsAsync: vi.fn(),
      requestPermissionsAsync: vi.fn(),
      getExpoPushTokenAsync: vi.fn(async () => {
        // The real implementation fetches the device token, which fires the
        // push-token listener. Modelling that is the whole point of the loop test.
        pushTokenListener?.();
        if (holding) await new Promise<void>((resolve) => gates.push(resolve));
        return { data: "ExponentPushToken[x]" };
      }),
      scheduleNotificationAsync: vi.fn(),
      getAllScheduledNotificationsAsync: vi.fn(async () => []),
      cancelScheduledNotificationAsync: vi.fn(),
      cancelAllScheduledNotificationsAsync: vi.fn(),
    },
  };
});

vi.mock("expo-notifications", () => expo.module);
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "p" } } } },
}));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: vi.fn() } }));

import {
  addListeners,
  addTokenChangeListener,
  getInitialNotification,
  getPushToken,
} from "./NotificationService";

const response = (target: string) => ({
  notification: { request: { content: { title: "t", body: "b", data: { target } } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  expo.releaseAllFetches();
  expo.setLastResponse(null);
});

describe("tap routing", () => {
  it("a listener-handled tap is not replayed by the next cold start", async () => {
    const onTapped = vi.fn();
    addListeners({ onTapped });

    expo.tap(response("wallet"));
    expect(onTapped).toHaveBeenCalledTimes(1);

    // The listener must consume the response. Expo keeps it process-wide
    // otherwise, and the next ordinary launch would route to it again as if
    // the user had tapped a second time.
    await vi.waitFor(() => expect(expo.lastResponse).toBeNull());

    expect(await getInitialNotification()).toBeNull();
  });

  it("a cold-start tap routes once and is then consumed", async () => {
    expo.setLastResponse(response("bitcoin"));

    const first = await getInitialNotification();
    expect(first?.data).toEqual({ target: "bitcoin" });

    expect(await getInitialNotification()).toBeNull();
  });
});

describe("token rotation", () => {
  it("keeps the guard up while a second fetch is still running", async () => {
    // A boolean guard breaks here: the first fetch to finish clears it while
    // the second is still in flight, so that second fetch's own echo arrives
    // looking like a genuine rotation and re-registration loops again.
    const onRotate = vi.fn();
    addTokenChangeListener(onRotate);

    expo.holdFetches();
    const first = getPushToken();
    const second = getPushToken();
    // getPushToken awaits startNotifications before the fetch, so wait until
    // both have actually reached the gate.
    await vi.waitFor(() => expect(expo.pendingFetches()).toBe(2));

    // Finish ONLY the first. The second is genuinely still running.
    expo.releaseOneFetch();
    await first;

    expo.rotateToken();
    expect(onRotate).not.toHaveBeenCalled();

    expo.releaseAllFetches();
    await second;
  });

  it("does not re-enter when our own fetch fires the push-token listener", async () => {
    // Expo warns that getDevicePushTokenAsync inside the listener loops. The
    // guard has to swallow the echo of a fetch we started ourselves, or the app
    // hammers exp.host every frame.
    const onRotate = vi.fn();
    addTokenChangeListener(onRotate);

    await getPushToken();

    expect(onRotate).not.toHaveBeenCalled();
  });

  it("still reports a rotation the app did not trigger", async () => {
    const onRotate = vi.fn();
    addTokenChangeListener(onRotate);

    expo.rotateToken();

    expect(onRotate).toHaveBeenCalledTimes(1);
  });
});
