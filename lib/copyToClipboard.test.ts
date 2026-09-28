import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard, registerCopiedToast } from "./copyToClipboard";

// vitest.config aliases "expo-clipboard" -> __mocks__/expo-stub.ts (default {}),
// so mock the resolved stub to give copyToClipboard a controllable setStringAsync.
const { setStringAsync } = vi.hoisted(() => ({ setStringAsync: vi.fn() }));

vi.mock("../__mocks__/expo-stub.ts", () => ({ default: {}, setStringAsync }));

afterEach(() => {
  vi.clearAllMocks();
  registerCopiedToast(null);
});

describe("copyToClipboard", () => {
  it("returns true and fires the toast on a confirmed write", async () => {
    setStringAsync.mockResolvedValueOnce(undefined);
    const toast = vi.fn();
    registerCopiedToast(toast);

    const ok = await copyToClipboard("bc1qaddress");

    expect(ok).toBe(true);
    expect(setStringAsync).toHaveBeenCalledWith("bc1qaddress");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("returns false and never fires the toast when the write rejects", async () => {
    setStringAsync.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const toast = vi.fn();
    registerCopiedToast(toast);

    // Must resolve (not reject) so fire-and-forget callers don't crash, and
    // must report failure so callers gate their own success UI on it.
    const ok = await copyToClipboard("bc1qaddress");

    expect(ok).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
