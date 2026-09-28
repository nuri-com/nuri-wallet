import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingCardDetail,
  peekPendingCardDetail,
  setPendingCardDetail,
} from "./cardDetailIntent";

describe("cardDetailIntent", () => {
  beforeEach(() => clearPendingCardDetail());

  it("parks a target until it is drained (survives a not-yet-ready screen)", () => {
    expect(peekPendingCardDetail()).toBeNull();
    setPendingCardDetail("bank");
    // Peeked repeatedly without clearing: the intent persists until the screen
    // is mounted and its data is ready.
    expect(peekPendingCardDetail()).toBe("bank");
    expect(peekPendingCardDetail()).toBe("bank");
    clearPendingCardDetail();
    expect(peekPendingCardDetail()).toBeNull();
  });

  it("keeps the latest target", () => {
    setPendingCardDetail("card");
    setPendingCardDetail("bank");
    expect(peekPendingCardDetail()).toBe("bank");
  });
});
