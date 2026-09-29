// screens/home/rails.ts
// The funding rails the unified home lists, and the one way to ask it to open a
// rail's asset screen.
//
// A deep link resolves to a RAIL, not to a screen instance: the home may not be
// mounted yet when the link arrives (cold start), and the link handler lives in
// App. Routing through an event keeps App free of any knowledge of the home's
// internals and gives the home a single entry point for every caller.
import { EventBus } from "../../services/events/AppEventBusService";

// `visa` and `visaUsd` are the SAME card seen per currency it settles in: the
// home lists the card once (its screen itemises the currencies), while a move
// has to name which pocket it fills — a euro top-up and a dollar top-up send
// different tokens to the same address.
export type RailKey = "wallet" | "dollar" | "onchain" | "arkade" | "iban" | "visa" | "visaUsd";

export const HOME_OPEN_RAIL_EVENT = "nav:openHomeRail";

// A cold start resolves its link BEFORE the home exists — the initial URL and
// the notification that launched the app are both read during startup, while the
// sign-in and unlock gates are still ahead of the home's listener. An event
// emitted then reaches nobody, and the link is silently lost. So the request is
// parked and the home drains it when it mounts.
let pendingRail: RailKey | null = null;

/** Open a rail's asset screen on the unified home, now or as soon as it exists. */
export function openHomeRail(key: RailKey): void {
  pendingRail = key;
  try {
    EventBus.emit<RailKey>(HOME_OPEN_RAIL_EVENT, key);
  } catch {}
}

/**
 * The rail a link asked for while nothing was listening, cleared as it is read.
 * Called by the home on mount; a rail already opened by the live event above is
 * simply reopened, which is a no-op for the user.
 */
export function takePendingHomeRail(): RailKey | null {
  const key = pendingRail;
  pendingRail = null;
  return key;
}

/** Session teardown: a new identity must not inherit the previous one's link. */
export function clearPendingHomeRail(): void {
  pendingRail = null;
}
