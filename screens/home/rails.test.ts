import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));

import { clearPendingHomeRail, openHomeRail, takePendingHomeRail } from "./rails";

// A cold start resolves its link before the home exists: the initial URL and the
// notification that launched the app are read during startup, while the sign-in
// and unlock gates are still ahead of the home's listener. Emitting then reaches
// nobody, so the request has to survive until the home mounts.
describe("pending home rail", () => {
  beforeEach(() => clearPendingHomeRail());

  it("hands a cold-start request to the home that mounts later", () => {
    openHomeRail("arkade");
    expect(takePendingHomeRail()).toBe("arkade");
  });

  it("is drained, so a remount does not reopen it", () => {
    openHomeRail("iban");
    takePendingHomeRail();
    expect(takePendingHomeRail()).toBeNull();
  });

  it("keeps the last request when several arrive before the home exists", () => {
    openHomeRail("wallet");
    openHomeRail("visa");
    expect(takePendingHomeRail()).toBe("visa");
  });

  it("is cleared on teardown, so a new identity inherits no link", () => {
    openHomeRail("onchain");
    clearPendingHomeRail();
    expect(takePendingHomeRail()).toBeNull();
  });
});
