import {
  NOTIFICATION_SERVICE_WORKER_PATH,
  NOTIFICATION_WEB_LINK_QUERY_PARAM,
  NOTIFICATION_WEB_MESSAGE_TAG,
  NOTIFICATION_WEB_SW_ACTIVATION_TIMEOUT_MS,
  NOTIFICATION_WEB_SW_PING,
  NOTIFICATION_WEB_SW_PING_TIMEOUT_MS,
  NOTIFICATION_WEB_SW_PONG,
  NOTIFICATION_WEB_TARGET_QUERY_PARAM,
} from "../../config/constants";
import { VAPID_PUBLIC_KEY } from "../../config/network";
import { EventBus } from "../events/AppEventBusService";
import type {
  NotificationListeners,
  NotificationPayload,
  NotificationPermission,
  PushToken,
  ScheduledNotification,
} from "./notificationTypes";

// The web twin of NotificationService.ts. expo-notifications ships a web path,
// but it reads config keys that are no longer in the Expo schema and expects the
// long-gone `/expo-service-worker.js`, so this uses the Push API directly.
//
// iOS caveat: Safari only exposes the Push API to a web app started from the
// Home Screen ("Add to Home Screen", iOS 16.4+). In a normal Safari tab
// `PushManager` is absent and subscribe() below returns null.

// Web has no OS-level scheduler: `showNotification` only fires from a live
// service worker, and the Notification Triggers API is not shipped anywhere we
// support. Timers therefore die with the tab — the debug UI says so.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, ScheduledNotification>();

function hasNotificationApi(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function hasPushApi(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined"
  );
}

/** VAPID keys travel as base64url; `applicationServerKey` wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * True when the worker behind `registration` answers the liveness ping.
 *
 * `navigator.serviceWorker.ready` resolves for a registration this session did
 * not create, and a worker whose thread has been killed still looks registered —
 * so push would be "set up" with nothing delivering. Adapted from the same check
 * in arkade.money's wallet.
 */
export async function isServiceWorkerResponsive(
  registration: ServiceWorkerRegistration,
  timeoutMs: number = NOTIFICATION_WEB_SW_PING_TIMEOUT_MS,
): Promise<boolean> {
  const worker = registration.active;
  if (!worker) return false;
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (responsive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(responsive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event) =>
      finish((event.data as { type?: string } | null)?.type === NOTIFICATION_WEB_SW_PONG);
    try {
      worker.postMessage({ type: NOTIFICATION_WEB_SW_PING }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/** Poll interval between ping retries on the repair path. */
const PING_RETRY_INTERVAL_MS = 50;

/**
 * Keeps asking the registration's active worker until it answers the ping or the
 * deadline passes.
 *
 * A ping can be missed while the device is loaded, and a registration that has
 * just been created has no active worker yet, so one miss is not proof that the
 * worker is unusable. A pong is the only thing that ends the retry, which is also
 * what excludes the stale worker that predates the handler: it can never produce
 * one, no matter how long we wait.
 */
export async function waitForServiceWorkerPong(
  registration: ServiceWorkerRegistration,
  timeoutMs: number = NOTIFICATION_WEB_SW_ACTIVATION_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isServiceWorkerResponsive(registration)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PING_RETRY_INTERVAL_MS));
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasPushApi()) return null;
  try {
    const registration = await navigator.serviceWorker.register(NOTIFICATION_SERVICE_WORKER_PATH);
    await navigator.serviceWorker.ready;
    if (await isServiceWorkerResponsive(registration)) return registration;
    // The worker behind this registration is not answering: its thread is gone, or
    // it predates the ping handler. Unregistering it does not help while this page
    // is still controlled by it — the registration survives until the controlled
    // clients are gone, and registering again for the same scope can hand the same
    // active worker back — so force an update and require a different worker that
    // answers the ping before trusting it.
    // An unanswered ping means the worker predates the handler or its thread is
    // gone. Unregistering does not help while this page is still controlled by it,
    // so force an update so a current script installs over it, then keep asking:
    // a worker that answers after a missed ping is usable as it is, and one that
    // never answers at all is the case the update is for.
    try {
      await registration.update();
    } catch {
      // An unreachable script cannot be replaced; the retry still gives the active
      // worker its chance to answer.
    }
    return (await waitForServiceWorkerPong(registration)) ? registration : null;
  } catch {
    return null;
  }
}

export async function startNotifications(): Promise<void> {
  await getRegistration();
}

export function stopNotifications(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  // Listeners are owned by the unsubscribe `addListeners` returns, not by this
  // function — a single module-level slot would only ever remove the last
  // registration and silently leak the rest.
}

export async function getPermission(): Promise<NotificationPermission> {
  if (!hasNotificationApi()) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return "undetermined";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!hasNotificationApi()) return "denied";
  try {
    const result = await Notification.requestPermission();
    if (result === "granted") return "granted";
    if (result === "denied") return "denied";
    return "undetermined";
  } catch {
    return "denied";
  }
}

/**
 * The PushSubscription addressing this browser, serialized as JSON. Delivery to
 * it needs the matching VAPID *private* key, which only a server may hold — the
 * app can produce this token but can never send to it.
 */
export async function getPushToken(): Promise<PushToken | null> {
  if (!VAPID_PUBLIC_KEY) return null;
  const registration = await getRegistration();
  if (!registration) return null;
  const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  try {
    let existing = await registration.pushManager.getSubscription();
    // A rotated VAPID key does not invalidate the browser's stored
    // subscription, so reusing it blindly keeps handing the backend an
    // endpoint its new key cannot sign for — silently, until the user clears
    // site data. Drop it when it was issued for a different key.
    if (existing && !subscribedWithKey(existing, applicationServerKey)) {
      try {
        await existing.unsubscribe();
      } catch {}
      existing = null;
    }
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
    return { kind: "web", value: JSON.stringify(subscription.toJSON()), platform: "web" };
  } catch {
    return null;
  }
}

/** Whether an existing subscription was created for `expected`. Unknown keys
 *  count as a match: without evidence of a mismatch, dropping a working
 *  subscription would be the worse failure. */
function subscribedWithKey(subscription: PushSubscription, expected: Uint8Array): boolean {
  const actual = subscription.options?.applicationServerKey;
  if (!actual) return true;
  const bytes = new Uint8Array(actual);
  if (bytes.length !== expected.length) return false;
  return bytes.every((value, index) => value === expected[index]);
}

export async function scheduleLocal(
  payload: NotificationPayload,
  delaySeconds: number,
): Promise<string> {
  const seconds = Math.max(1, Math.round(delaySeconds));
  const id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fireAtMs = Date.now() + seconds * 1000;

  const timer = setTimeout(() => {
    timers.delete(id);
    pending.delete(id);
    void (async () => {
      const registration = await getRegistration();
      if (!registration) return;
      try {
        await registration.showNotification(payload.title, {
          body: payload.body,
          data: payload.data ?? {},
        });
      } catch {}
    })();
  }, seconds * 1000);

  timers.set(id, timer);
  pending.set(id, { id, title: payload.title, body: payload.body, fireAtMs });
  return id;
}

export async function listScheduled(): Promise<ScheduledNotification[]> {
  return Array.from(pending.values());
}

export async function cancelScheduled(id: string): Promise<void> {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  pending.delete(id);
}

export async function cancelAllScheduled(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
}

/**
 * A tap that opened the PWA from closed. The service worker cannot postMessage
 * it — the new client is not listening yet — so it carries the target in the
 * launch URL and this reads it back.
 */
export async function getInitialNotification(): Promise<NotificationPayload | null> {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const link = url.searchParams.get(NOTIFICATION_WEB_LINK_QUERY_PARAM);
    const target = url.searchParams.get(NOTIFICATION_WEB_TARGET_QUERY_PARAM);
    if (!link && !target) return null;
    // Consume them, or a reload would route again.
    url.searchParams.delete(NOTIFICATION_WEB_LINK_QUERY_PARAM);
    url.searchParams.delete(NOTIFICATION_WEB_TARGET_QUERY_PARAM);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    // Hand both on. The link wins where it validates, but readNotificationLink
    // rejects a screen this build cannot route — and then the target is the
    // fallback, exactly as on native and on an already-open client.
    const data: Record<string, unknown> = {};
    if (link) data.url = link;
    if (target) data.target = target;
    return { title: "", body: "", data };
  } catch {
    return null;
  }
}

/**
 * No-op on web. A browser rotates a subscription through the service worker's
 * `pushsubscriptionchange` event, which fires with no page attached — so it
 * cannot call back into app code. The re-subscribe on the next
 * `getPushToken()` covers it instead.
 */
export function addTokenChangeListener(_listener: () => void): () => void {
  return () => {};
}

export function addListeners(listeners: NotificationListeners): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};

  const handler = (event: MessageEvent) => {
    const message = event.data;
    if (!message || message.tag !== NOTIFICATION_WEB_MESSAGE_TAG) return;
    const payload: NotificationPayload = {
      title: String(message.title ?? ""),
      body: String(message.body ?? ""),
      data: message.data ?? {},
    };
    if (message.kind === "tapped") {
      EventBus.emit("notifications:tapped", payload);
      listeners.onTapped?.(payload);
      return;
    }
    EventBus.emit("notifications:received", payload);
    listeners.onReceived?.(payload);
  };

  navigator.serviceWorker.addEventListener("message", handler);

  return () => {
    try {
      navigator.serviceWorker.removeEventListener("message", handler);
    } catch {}
  };
}
