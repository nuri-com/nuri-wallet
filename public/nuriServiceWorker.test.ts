import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NOTIFICATION_WEB_SW_PING, NOTIFICATION_WEB_SW_PONG } from "../config/constants";
import {
  readNotificationLink,
  readNotificationTarget,
} from "../services/notifications/notificationTypes";

// Runs the shipped service worker itself. The web tests start after the handoff,
// so only this can cover the notificationclick branch that builds the launch URL
// — the one place where a payload can lose its destination on a cold start.

type Listeners = Record<string, (event: unknown) => void>;

function loadServiceWorker() {
  const source = readFileSync(join(__dirname, "nuri-service-worker.js"), "utf8");
  const listeners: Listeners = {};
  // Typed argument: the test reads the URL back off mock.calls, and an
  // inferred zero-argument mock makes that a type error.
  const openWindow = vi.fn(async (_url: string) => null);
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      claim: vi.fn(async () => undefined),
      // No window open — the cold-start branch.
      matchAll: vi.fn(async () => []),
      openWindow,
    },
  };
  new Function("self", source)(self);
  return { listeners, openWindow };
}

async function tap(data: Record<string, unknown>) {
  const { listeners, openWindow } = loadServiceWorker();
  const waits: unknown[] = [];
  listeners.notificationclick?.({
    notification: { title: "t", body: "b", data, close: vi.fn() },
    waitUntil: (p: unknown) => waits.push(p),
  });
  await Promise.all(waits);
  return String(openWindow.mock.calls[0]?.[0] ?? "");
}

/** What the app makes of the launch URL the worker produced. */
function routeFrom(launchUrl: string) {
  const params = new URL(launchUrl, "https://app.nuri.com").searchParams;
  const payload = {
    url: params.get("nuriNotificationLink") ?? undefined,
    target: params.get("nuriNotificationTarget") ?? undefined,
  };
  return readNotificationLink(payload) ?? readNotificationTarget(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The page pings before trusting a registration it did not create: a worker
// whose thread is gone still satisfies `navigator.serviceWorker.ready`, so
// without an answer the app reports push as wired up while nothing delivers.
describe("liveness ping", () => {
  it("answers a ping with a pong on the reply port", () => {
    const { listeners } = loadServiceWorker();
    const port = { postMessage: vi.fn() };

    listeners.message?.({ data: { type: NOTIFICATION_WEB_SW_PING }, ports: [port] });

    expect(port.postMessage).toHaveBeenCalledWith({ type: NOTIFICATION_WEB_SW_PONG });
  });

  it("ignores anything that is not a ping", () => {
    const { listeners } = loadServiceWorker();
    const port = { postMessage: vi.fn() };

    listeners.message?.({ data: { tag: "nuri:notification" }, ports: [port] });
    listeners.message?.({ data: null, ports: [port] });

    expect(port.postMessage).not.toHaveBeenCalled();
  });
});

describe("closed-PWA notification tap", () => {
  it("keeps a valid target when the link names a screen this build cannot route", async () => {
    // The regression: the worker used to write link OR target, so a link the
    // app rejects discarded a perfectly good fallback — and only on cold start,
    // where native and open clients still fell back correctly.
    const launch = await tap({ url: "nuri://future-screen", target: "wallet" });

    expect(routeFrom(launch)).toBe("wallet");
  });

  it("prefers the link when it does route", async () => {
    const launch = await tap({ url: "nuri://show-iban", target: "wallet" });

    expect(routeFrom(launch)).toBe("nuri://show-iban");
  });

  it("strips a query before it can reach the launch URL", async () => {
    // That URL is recorded by hosting, proxies and the browser.
    const launch = await tap({ url: "nuri://card?token=secret" });

    expect(launch).not.toContain("secret");
    expect(routeFrom(launch)).toBe("nuri://card");
  });

  it("opens the root when the payload names nothing", async () => {
    expect(await tap({})).toBe("/");
  });
});
