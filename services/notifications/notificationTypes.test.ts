import { describe, expect, it } from "vitest";

import { readNotificationLink, readNotificationTarget } from "./notificationTypes";

describe("readNotificationLink", () => {
  it("accepts a link the deep-link router knows", () => {
    expect(readNotificationLink({ url: "nuri://show-iban" })).toBe("nuri://show-iban");
  });

  it("accepts the dev and preview schemes", () => {
    expect(readNotificationLink({ url: "nuri-dev://card" })).toBe("nuri-dev://card");
  });

  it("rejects a screen this build cannot route", () => {
    // A payload naming an unknown screen must land nowhere rather than
    // dead-ending navigation on a route that does not exist.
    expect(readNotificationLink({ url: "nuri://not-a-screen" })).toBeNull();
  });

  it("rejects anything that is not an internal link", () => {
    expect(readNotificationLink({ url: "https://nuri.com/card" })).toBeNull();
    expect(readNotificationLink({ url: 42 })).toBeNull();
    expect(readNotificationLink(null)).toBeNull();
  });
});

describe("readNotificationTarget", () => {
  it("accepts only the three tabs", () => {
    expect(readNotificationTarget({ target: "wallet" })).toBe("wallet");
    expect(readNotificationTarget({ target: "settings" })).toBeNull();
  });
});

describe("link canonicalisation", () => {
  it("accepts the keys alias the router still handles", () => {
    // App.tsx routes `case "keys"` to the wallet tab; rejecting it here would
    // make link notifications silently do nothing for a URL that works
    // everywhere else in the app.
    expect(readNotificationLink({ url: "nuri://keys" })).toBe("nuri://keys");
  });

  it("strips a query so nothing untrusted reaches the logs", () => {
    // EventBus logs string payloads, and the payload comes from the server.
    expect(readNotificationLink({ url: "nuri://card?token=secret" })).toBe("nuri://card");
    expect(readNotificationLink({ url: "nuri://card#secret" })).toBe("nuri://card");
  });
});
