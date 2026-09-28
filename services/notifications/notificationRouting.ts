import { EventBus } from "../events/AppEventBusService";
import {
  isWirexNotification,
  type NotificationListeners,
  type NotificationPayload,
  type NotificationTarget,
  readNotificationLink,
  readNotificationTarget,
} from "./notificationTypes";

// What a delivered notification does to the app. Split out of App.tsx because
// the arrival and the tap do deliberately different things, and that difference
// is what a foregrounded 3DS push depends on — see below.

/**
 * The listener pair `addListeners` takes, plus the same tap handler for the
 * cold-start read: a tap that launched the app predates any listener, so it
 * arrives through `getInitialNotification()` instead.
 *
 * `onReceived` refreshes but never navigates. A push arriving while the user is
 * mid-task must not yank them elsewhere; only their own tap may do that.
 *
 * `onTapped` refreshes too, because a tap can be the FIRST time we see a
 * payload — the app may have been backgrounded or not running when it arrived.
 */
export function createNotificationRouter(deps: {
  /** Where a `target`-only payload lands. The host maps it onto a real screen. */
  navigateToTarget: (target: NotificationTarget) => void;
}): Required<NotificationListeners> {
  // Every wirex push means the card account just changed — a spend, a SEPA
  // movement, a used-up limit, or a 3DS challenge waiting on the user.
  // `card:refresh` re-reads the account and re-polls pending 3DS, which is what
  // surfaces the approve/decline modal.
  //
  // This has to run on ARRIVAL, not only on the tap: a push delivered while the
  // app is already foregrounded produces no AppState transition, and the user
  // may never touch the banner. Without it the challenge would sit unseen until
  // something else polls — and they have only a couple of minutes before it
  // expires. Refreshing is idempotent, so a tap after an arrival costs one
  // extra read and nothing else.
  const onReceived = (payload: NotificationPayload): void => {
    if (isWirexNotification(payload.data)) EventBus.emit("card:refresh");
  };

  const onTapped = (payload: NotificationPayload): void => {
    onReceived(payload);
    // A `nuri://` link goes through the same router as a real deep link, so a
    // notification can reach any screen that link can — no second navigation
    // path to keep in sync. `target` stays supported for tab-only payloads.
    const link = readNotificationLink(payload.data);
    if (link) {
      EventBus.emit("app:openInternalLink", link);
      return;
    }
    // The server may only name a known target (readNotificationTarget rejects
    // anything else), so a malformed or future payload lands nowhere instead of
    // breaking navigation.
    const target = readNotificationTarget(payload.data);
    if (target) deps.navigateToTarget(target);
  };

  return { onReceived, onTapped };
}
