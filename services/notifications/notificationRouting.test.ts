import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../events/AppEventBusService";
import { createNotificationRouter } from "./notificationRouting";
import type { NotificationTarget } from "./notificationTypes";

const WIREX_3DS = {
  title: "Confirm your payment",
  body: "127.15 EUR at Amazon UK · card ···0333.",
  data: { source: "wirex", kind: "3ds", target: "card", transaction_id: "tx-1" },
};

type TargetNavigator = (target: NotificationTarget) => void;
type BusListener = (payload?: unknown) => void;

let navigateToTarget: ReturnType<typeof vi.fn<TargetNavigator>>;
let cardRefresh: ReturnType<typeof vi.fn<BusListener>>;
let openLink: ReturnType<typeof vi.fn<BusListener>>;
let offCardRefresh: () => void;
let offOpenLink: () => void;

beforeEach(() => {
  navigateToTarget = vi.fn<TargetNavigator>();
  cardRefresh = vi.fn<BusListener>();
  openLink = vi.fn<BusListener>();
  offCardRefresh?.();
  offOpenLink?.();
  offCardRefresh = EventBus.on("card:refresh", cardRefresh);
  offOpenLink = EventBus.on("app:openInternalLink", openLink);
});

describe("wirex arrivals", () => {
  it("refreshes on ARRIVAL, without waiting for a tap", () => {
    // The regression that matters: a 3DS push delivered while the app is
    // already foregrounded produces no AppState transition, and the user may
    // never touch the banner. Handling only the tap leaves the approve/decline
    // modal unseen until the challenge expires — minutes later.
    createNotificationRouter({ navigateToTarget }).onReceived(WIREX_3DS);

    expect(cardRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not navigate on arrival — only the user's own tap may move them", () => {
    createNotificationRouter({ navigateToTarget }).onReceived(WIREX_3DS);

    expect(navigateToTarget).not.toHaveBeenCalled();
  });

  it("also refreshes on tap, since a tap can be the first sight of the payload", () => {
    // Backgrounded or not running at delivery time: no arrival was ever seen.
    createNotificationRouter({ navigateToTarget }).onTapped(WIREX_3DS);

    expect(cardRefresh).toHaveBeenCalledTimes(1);
    expect(navigateToTarget).toHaveBeenCalledWith("card");
  });

  it("leaves non-wirex pushes alone", () => {
    createNotificationRouter({ navigateToTarget }).onReceived({
      title: "Payment received",
      body: "…",
      data: { target: "bitcoin" },
    });

    expect(cardRefresh).not.toHaveBeenCalled();
  });
});

describe("tap navigation", () => {
  it("prefers an internal link over the bare target", () => {
    createNotificationRouter({ navigateToTarget }).onTapped({
      title: "t",
      body: "b",
      data: { url: "nuri://show-iban", target: "wallet" },
    });

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(navigateToTarget).not.toHaveBeenCalled();
  });

  it("lands nowhere on a payload naming a screen this build does not have", () => {
    createNotificationRouter({ navigateToTarget }).onTapped({
      title: "t",
      body: "b",
      data: { target: "vault" },
    });

    expect(navigateToTarget).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });
});
