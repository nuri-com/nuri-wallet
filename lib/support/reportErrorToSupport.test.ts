import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  sendSupportDump: vi.fn(async () => undefined),
}));

vi.mock("../../services/events/AppEventBusService", () => ({ EventBus: { emit: mocks.emit } }));
vi.mock("../../services/support/SupportDumpService", () => ({
  sendSupportDump: mocks.sendSupportDump,
}));
vi.mock("../nostr/unread", () => ({ SUPPORT_PUBKEY: "npub-support" }));

import { reportErrorToSupport, wasReportedToSupport } from "./reportErrorToSupport";

beforeEach(() => vi.clearAllMocks());

// One failure, one report: a failed card withdrawal on the Move sheet is
// reported by the withdrawal ("Card withdrawal failed") and must not be
// reported again by the sheet that shows it ("Move transfer failed").
describe("wasReportedToSupport", () => {
  it("knows an error that was already reported, and only that one", async () => {
    const reported = new Error("wirex_withdraw_failed");
    const other = new Error("wirex_withdraw_failed");

    await reportErrorToSupport({ error: reported, userMessage: "Card withdrawal failed" });

    expect(wasReportedToSupport(reported)).toBe(true);
    expect(wasReportedToSupport(other)).toBe(false);
    expect(wasReportedToSupport("a string")).toBe(false);
    expect(mocks.sendSupportDump).toHaveBeenCalledTimes(1);
  });
});
