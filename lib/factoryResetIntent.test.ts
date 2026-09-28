import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetFactoryResetIntentForTests,
  armFactoryResetIfAutoAccessInFlight,
  consumePendingFactoryReset,
  noteAutoAccessSettled,
  noteAutoAccessStarted,
} from "./factoryResetIntent";

// The factory-reset deep link must reach Delete wallet across the cold-start
// race, WITHOUT trapping normal opens into a second authentication. The flag is
// tied to the live auto-access lifecycle, so these prove each ordering.
describe("factoryResetIntent lifecycle", () => {
  beforeEach(() => __resetFactoryResetIntentForTests());

  it("auto success (race): arm while auto in flight → consumed on the unlock", () => {
    noteAutoAccessStarted(); // launch auto-unlock started
    armFactoryResetIfAutoAccessInFlight(); // deep link arrives mid-flight
    // Unlock lands → the listener consumes it → re-present reset mode.
    expect(consumePendingFactoryReset()).toBe(true);
    noteAutoAccessSettled(true);
    // Nothing lingers.
    expect(consumePendingFactoryReset()).toBe(false);
  });

  it("auto cancel/failure: settling without unlock clears the armed flag", () => {
    noteAutoAccessStarted();
    armFactoryResetIfAutoAccessInFlight();
    noteAutoAccessSettled(false); // biometric cancelled / failed — no unlock coming
    // A later manual Access Wallet must dismiss normally, not be intercepted.
    expect(consumePendingFactoryReset()).toBe(false);
  });

  it("already-settled auto: arming after the attempt ends does nothing", () => {
    noteAutoAccessStarted();
    noteAutoAccessSettled(false); // auto already settled before the deep link ran
    armFactoryResetIfAutoAccessInFlight();
    expect(consumePendingFactoryReset()).toBe(false);
  });

  it("no auto / normal open: nothing in flight → nothing armed", () => {
    armFactoryResetIfAutoAccessInFlight();
    expect(consumePendingFactoryReset()).toBe(false);
  });
});
