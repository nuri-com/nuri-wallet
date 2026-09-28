import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { ANDROID_NOTIFICATION_CHANNEL_ID } from "../../config/constants";
import { EventBus } from "../events/AppEventBusService";
import type {
  NotificationListeners,
  NotificationPayload,
  NotificationPermission,
  PushToken,
  ScheduledNotification,
} from "./notificationTypes";

// Remote push is an OS capability, not a JS one: iOS needs the `aps-environment`
// entitlement and Android needs FCM, both baked into the binary. That makes this
// module a fingerprint source — it can never reach an existing build over OTA.

// The OS owns a scheduled notification once it is handed over, and it reports no
// fire date back. We remember the ones this process scheduled so the debug
// countdown is exact; after a restart the entry is gone and fireAtMs reads null.
const fireDates = new Map<string, number>();

let listenerSubscriptions: Notifications.EventSubscription[] = [];
let handlerConfigured = false;
// How many token fetches are in flight. `getExpoPushTokenAsync` internally
// fetches the device token, which fires the push-token listener — so a listener
// that re-registers would call straight back into here. Expo documents exactly
// this trap ("you should not call getDevicePushTokenAsync inside this
// function... may lead to an infinite loop"), and the loop is not merely
// wasteful: it hammers exp.host every frame, starving the network and the JS
// thread.
//
// A counter, not a boolean: two overlapping fetches are entirely possible (the
// sign-in sync and an opt-in, say), and with a boolean the first one to finish
// would clear the guard while the second is still running — letting that
// second fetch's own echo through as if it were a real rotation.
let inFlightTokenFetches = 0;

function toPayload(content: Notifications.NotificationContent): NotificationPayload {
  return {
    title: content.title ?? "",
    body: content.body ?? "",
    data: content.data ?? {},
  };
}

function toPermission(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return "granted";
  if (status.canAskAgain) return "undetermined";
  return "denied";
}

/** Foreground presentation. Without this the OS silently swallows notifications
 *  that arrive while the app is open, which reads as "push is broken". */
function configureHandler() {
  if (handlerConfigured) return;
  handlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Android needs an explicit high-importance channel or notifications arrive
 *  silently with no heads-up banner. No-op on iOS. */
async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_NOTIFICATION_CHANNEL_ID, {
      name: "Nuri",
      importance: Notifications.AndroidImportance.MAX,
    });
  } catch {}
}

export async function startNotifications(): Promise<void> {
  configureHandler();
  await ensureAndroidChannel();
}

export function stopNotifications(): void {
  for (const subscription of listenerSubscriptions) {
    try {
      subscription.remove();
    } catch {}
  }
  listenerSubscriptions = [];
}

export async function getPermission(): Promise<NotificationPermission> {
  try {
    return toPermission(await Notifications.getPermissionsAsync());
  } catch {
    return "undetermined";
  }
}

export async function requestPermission(): Promise<NotificationPermission> {
  try {
    return toPermission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      }),
    );
  } catch {
    return "denied";
  }
}

/**
 * The Expo push token addressing this install. Requires granted permission and
 * a build carrying the push entitlement/FCM config — it throws in Expo Go and
 * on simulators without those, so callers get null rather than an exception.
 */
export async function getPushToken(): Promise<PushToken | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== "string" || !projectId) return null;
  // Android needs the channel to exist before a token is requested. The boot
  // effect calls startNotifications() fire-and-forget, so a cold start with
  // permission already granted can reach this first and come back empty —
  // which would silently skip registration until the next sign-in. Both calls
  // are idempotent, so ensuring it here costs nothing.
  await startNotifications();
  inFlightTokenFetches += 1;
  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { kind: "expo", value: token.data, platform: Platform.OS };
  } catch {
    return null;
  } finally {
    inFlightTokenFetches -= 1;
  }
}

/**
 * Hands a notification to the OS scheduler. It fires even if the app is killed
 * in the meantime, which is what makes it a usable "close the app and wait" test
 * of presentation — it does not exercise APNs/FCM, only local delivery.
 */
export async function scheduleLocal(
  payload: NotificationPayload,
  delaySeconds: number,
): Promise<string> {
  const seconds = Math.max(1, Math.round(delaySeconds));
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
      channelId: ANDROID_NOTIFICATION_CHANNEL_ID,
    },
  });
  fireDates.set(id, Date.now() + seconds * 1000);
  return id;
}

export async function listScheduled(): Promise<ScheduledNotification[]> {
  try {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    return requests.map((request) => ({
      id: request.identifier,
      title: request.content.title ?? "",
      body: request.content.body ?? "",
      fireAtMs: fireDates.get(request.identifier) ?? null,
    }));
  } catch {
    return [];
  }
}

export async function cancelScheduled(id: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {}
  fireDates.delete(id);
}

export async function cancelAllScheduled(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {}
  fireDates.clear();
}

/**
 * The notification whose tap launched the app, if any. A cold-start tap happens
 * before any listener can exist, so it is delivered here instead of through
 * `addListeners` — without this, tapping a notification on a killed app just
 * opens the home tab.
 */
export async function getInitialNotification(): Promise<NotificationPayload | null> {
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    if (!response) return null;
    // The OS keeps the last response indefinitely, so without clearing it every
    // later cold start would re-route to that same stale notification. Consume
    // it exactly once.
    await Notifications.clearLastNotificationResponseAsync().catch(() => {});
    return toPayload(response.notification.request.content);
  } catch {
    return null;
  }
}

/**
 * Fires when APNs/FCM rotates this device's token. Sign-in sync alone would
 * leave a long-running session pushing to a dead token until the next login, so
 * the caller re-registers from here. Returns an unsubscribe function.
 */
export function addTokenChangeListener(listener: () => void): () => void {
  const subscription = Notifications.addPushTokenListener(() => {
    // Ignore the echo of our own fetch; only a rotation we did not ask for is
    // worth re-registering for.
    if (inFlightTokenFetches > 0) return;
    listener();
  });
  return () => {
    try {
      subscription.remove();
    } catch {}
  };
}

/** Subscribes to foreground arrivals and taps. Returns an unsubscribe function. */
export function addListeners(listeners: NotificationListeners): () => void {
  const subscriptions: Notifications.EventSubscription[] = [];

  subscriptions.push(
    Notifications.addNotificationReceivedListener((event) => {
      const payload = toPayload(event.request.content);
      EventBus.emit("notifications:received", payload);
      listeners.onReceived?.(payload);
    }),
  );

  subscriptions.push(
    Notifications.addNotificationResponseReceivedListener((event) => {
      const payload = toPayload(event.notification.request.content);
      // Expo stores this response process-wide and `getInitialNotification()`
      // reads the same slot on every cold start. Handling a tap here without
      // clearing it means the next ordinary launch replays this target as if
      // the user had tapped again.
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      EventBus.emit("notifications:tapped", payload);
      listeners.onTapped?.(payload);
    }),
  );

  listenerSubscriptions = listenerSubscriptions.concat(subscriptions);

  return () => {
    for (const subscription of subscriptions) {
      try {
        subscription.remove();
      } catch {}
      listenerSubscriptions = listenerSubscriptions.filter((entry) => entry !== subscription);
    }
  };
}
