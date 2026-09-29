// Which notifications the user wants, per category. Pure (no RN/Expo), so the
// rules are unit-testable; NotificationRegistrationService stores and applies
// them.
//
// A category is a notification-server namespace:
//   bitcoin  arkade — Lightning / bitcoin payments received
//   banking  wirex  — card spend, SEPA movements, card limits, 3DS
export const NOTIFICATION_CATEGORIES = ["bitcoin", "banking"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationPreferences = Record<NotificationCategory, boolean>;

/** Nothing chosen yet = everything on, which is how the app behaved before the choice existed. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  bitcoin: true,
  banking: true,
};

export function parseNotificationPreferences(
  raw: string | null | undefined,
): NotificationPreferences {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const entry = parsed as Record<string, unknown>;
    const out = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    for (const category of NOTIFICATION_CATEGORIES) {
      if (typeof entry[category] === "boolean") out[category] = entry[category] as boolean;
    }
    return out;
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function anyNotificationEnabled(preferences: NotificationPreferences): boolean {
  return NOTIFICATION_CATEGORIES.some((category) => preferences[category]);
}
