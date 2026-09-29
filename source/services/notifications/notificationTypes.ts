import { canonicalInternalLink } from "../../lib/internalLinks";

// Shared shapes for the notification module. Native (expo-notifications) and
// web (Push API + VAPID) implement the same surface, so callers never branch on
// platform — see NotificationService.ts / NotificationService.web.ts.

/** Which transport a token belongs to. Determines how a sender addresses it. */
export type PushTokenKind = "expo" | "web";

export type PushToken = {
  kind: PushTokenKind;
  /** Expo: `ExponentPushToken[…]`. Web: the JSON-serialized PushSubscription. */
  value: string;
  /** "ios" | "android" | "web" — informational, for the dev registry listing. */
  platform: string;
};

export type NotificationPermission = "granted" | "denied" | "undetermined";

export type NotificationPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

/** Tab a tapped notification should land on. Mirrors App.tsx's `activeTab`, so
 *  the server can only ever name a screen that already exists. */
export type NotificationTarget = "bitcoin" | "wallet" | "card";

export const NOTIFICATION_TARGETS: readonly NotificationTarget[] = ["bitcoin", "wallet", "card"];

export function readNotificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== "object") return null;
  const target = (data as { target?: unknown }).target;
  return NOTIFICATION_TARGETS.includes(target as NotificationTarget)
    ? (target as NotificationTarget)
    : null;
}

/**
 * Whether the push came from the wirex rails — card spend, a SEPA movement, a
 * used-up card limit or a 3DS challenge. Every one of them targets the card tab
 * and means the card account just changed, so the caller can act on the source
 * alone; the payload's `kind` only matters to a screen that wants to say which
 * event it was.
 */
export function isWirexNotification(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as { source?: unknown }).source === "wirex";
}

/**
 * The internal link a tapped notification should open, or null. Validated
 * against the router's own destination list, so a payload naming a screen this
 * build does not have is ignored instead of dead-ending navigation.
 */
export function readNotificationLink(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" ? canonicalInternalLink(url) : null;
}

export type PushRegistrationState =
  | {
      kind: "disabled";
      reason: "no-server" | "permission" | "no-token" | "not-bound" | "opted-out";
    }
  /** `subscriptionId` is a client-minted bearer secret, not a wallet identity —
   *  there is nothing to impersonate, so registration needs no auth. */
  | { kind: "registered"; token: string; subscriptionId: string }
  | { kind: "error"; message: string };

export type ScheduledNotification = {
  id: string;
  title: string;
  body: string;
  /** Epoch ms when it should fire, or null when the OS owns the schedule and
   *  this process did not create it (e.g. after an app restart). */
  fireAtMs: number | null;
};

export type NotificationListeners = {
  /** Fired while the app is in the foreground. */
  onReceived?: (payload: NotificationPayload) => void;
  /** Fired when the user taps the notification. */
  onTapped?: (payload: NotificationPayload) => void;
};

/** A device a developer can address from the debug tools. */
export type DevDevice = {
  label: string;
  token: string;
  kind: PushTokenKind;
  platform: string;
  addedAtMs: number;
};
