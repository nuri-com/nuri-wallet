import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: vi.fn() } }));

import {
  NOTIFICATION_WEB_LINK_QUERY_PARAM,
  NOTIFICATION_WEB_TARGET_QUERY_PARAM,
} from "../../config/constants";
import {
  getInitialNotification,
  getPushToken,
  isServiceWorkerResponsive,
  waitForServiceWorkerPong,
} from "./NotificationService.web";

// A tap on a CLOSED PWA cannot be delivered by postMessage — no client is
// listening yet — so the service worker puts the destination in the launch URL
// and this path reads it back. Carrying only `target` there was the bug: a
// link-style notification lost its screen and opened the default tab.
function launchWith(search: string) {
  const url = `https://app.nuri.com/${search}`;
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: url },
    history: { replaceState },
  });
  return replaceState;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// arkade.money's zombie check, copied: ping the worker and only trust a
// registration that answers, because `ready` resolves either way.
describe("service worker liveness", () => {
  const registrationWith = (active: unknown) =>
    ({ active }) as unknown as ServiceWorkerRegistration;

  it("is responsive when the worker answers the ping", async () => {
    const registration = registrationWith({
      postMessage: (_message: unknown, ports: MessagePort[]): void => {
        ports[0]?.postMessage({ type: "nuri:sw-pong" });
      },
    });

    await expect(isServiceWorkerResponsive(registration, 50)).resolves.toBe(true);
  });

  it("is not responsive when the worker stays silent", async () => {
    const registration = registrationWith({ postMessage: (): void => undefined });

    await expect(isServiceWorkerResponsive(registration, 20)).resolves.toBe(false);
  });

  it("is not responsive without an active worker", async () => {
    await expect(isServiceWorkerResponsive(registrationWith(null), 20)).resolves.toBe(false);
  });
});
describe("service worker repair", () => {
  const asRegistration = (shape: unknown): ServiceWorkerRegistration =>
    shape as ServiceWorkerRegistration;
  const silentWorker = (): { postMessage: () => void } => ({
    postMessage: (): void => undefined,
  });
  const pongWorker = (): { postMessage: (message: unknown, ports: MessagePort[]) => void } => ({
    postMessage: (_message: unknown, ports: MessagePort[]): void => {
      ports[0]?.postMessage({ type: "nuri:sw-pong" });
    },
  });
  const stubBrowser = (registration: unknown): void => {
    vi.stubGlobal("PushManager", class {});
    // The test environment is node: urlBase64ToUint8Array needs window.atob.
    vi.stubGlobal("window", { atob: (value: string): string => atob(value) });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: Promise.resolve(registration),
        register: async (): Promise<unknown> => registration,
      },
    });
  };

  it("answers again on a retry after a missed ping", async () => {
    const registration: { active: unknown } = { active: silentWorker() };
    setTimeout(() => {
      registration.active = pongWorker();
    }, 40);

    // The budget has to outlast the first ping's own timeout, otherwise a single
    // miss consumes it and the retry never happens.
    await expect(waitForServiceWorkerPong(asRegistration(registration), 1500)).resolves.toBe(true);
  });

  it("gives up when the worker never answers", async () => {
    const registration = { active: silentWorker() };

    await expect(waitForServiceWorkerPong(asRegistration(registration), 60)).resolves.toBe(false);
  });

  // A worker that is current and merely slow must stay usable: the first ping can
  // be missed, update() then has nothing to install, and rejecting the worker
  // would take notifications down over a transient miss.
  it("keeps a slow current worker that answers on the retry", async () => {
    const subscribe = vi.fn(
      async (): Promise<{ toJSON: () => { endpoint: string } }> => ({
        toJSON: (): { endpoint: string } => ({ endpoint: "https://push.test/1" }),
      }),
    );
    let pings = 0;
    const registration = {
      active: {
        postMessage: (_message: unknown, ports: MessagePort[]): void => {
          pings += 1;
          if (pings > 1) ports[0]?.postMessage({ type: "nuri:sw-pong" });
        },
      },
      // The installed script is already current, so there is nothing to install.
      update: async (): Promise<void> => undefined,
      pushManager: {
        getSubscription: async (): Promise<null> => null,
        subscribe,
      },
    };
    stubBrowser(registration);

    vi.useFakeTimers();
    const pending = getPushToken();
    await vi.advanceTimersByTimeAsync(1000);
    const token = await pending;
    vi.useRealTimers();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(token?.value).toContain("push.test");
  });

  // The stale script: it predates the ping handler, so it never answers and the
  // update installs one that does.
  it("subscribes once the update installs a worker that answers", async () => {
    const subscribe = vi.fn(
      async (): Promise<{ toJSON: () => { endpoint: string } }> => ({
        toJSON: (): { endpoint: string } => ({ endpoint: "https://push.test/1" }),
      }),
    );
    const registration: {
      active: unknown;
      update: () => Promise<void>;
      pushManager: unknown;
    } = {
      active: silentWorker(),
      update: async (): Promise<void> => {
        registration.active = pongWorker();
      },
      pushManager: {
        getSubscription: async (): Promise<null> => null,
        subscribe,
      },
    };
    stubBrowser(registration);

    vi.useFakeTimers();
    const pending = getPushToken();
    await vi.advanceTimersByTimeAsync(1000);
    const token = await pending;
    vi.useRealTimers();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(token?.value).toContain("push.test");
  });

  it("returns nothing when no worker ever answers", async () => {
    const subscribe = vi.fn((): void => undefined);
    const registration = {
      active: silentWorker(),
      update: async (): Promise<void> => undefined,
      pushManager: {
        getSubscription: async (): Promise<null> => null,
        subscribe,
      },
    };
    stubBrowser(registration);

    vi.useFakeTimers();
    const pending = getPushToken();
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
describe("PWA cold-start handoff", () => {
  it("recovers a deep link from the launch URL", async () => {
    launchWith(`?${NOTIFICATION_WEB_LINK_QUERY_PARAM}=${encodeURIComponent("nuri://show-iban")}`);

    expect(await getInitialNotification()).toEqual({
      title: "",
      body: "",
      data: { url: "nuri://show-iban" },
    });
  });

  it("still recovers a plain tab target", async () => {
    launchWith(`?${NOTIFICATION_WEB_TARGET_QUERY_PARAM}=wallet`);

    expect((await getInitialNotification())?.data).toEqual({ target: "wallet" });
  });

  it("carries both when both are present", async () => {
    // Both travel so the app can prefer the link and still fall back to the
    // target when the link names a screen this build cannot route. Dropping
    // the target here is what broke the closed-PWA path.
    launchWith(
      `?${NOTIFICATION_WEB_LINK_QUERY_PARAM}=${encodeURIComponent("nuri://card")}` +
        `&${NOTIFICATION_WEB_TARGET_QUERY_PARAM}=bitcoin`,
    );

    expect((await getInitialNotification())?.data).toEqual({
      url: "nuri://card",
      target: "bitcoin",
    });
  });

  it("consumes the parameters so a reload does not route again", async () => {
    const replaceState = launchWith(
      `?${NOTIFICATION_WEB_LINK_QUERY_PARAM}=${encodeURIComponent("nuri://card")}&keep=1`,
    );

    await getInitialNotification();

    expect(replaceState).toHaveBeenCalledWith({}, "", "/?keep=1");
  });

  it("is null on an ordinary launch", async () => {
    launchWith("");

    expect(await getInitialNotification()).toBeNull();
  });
});
