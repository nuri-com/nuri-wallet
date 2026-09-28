import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHomeCarouselSettleController,
  homeCarouselIndexAfterAction,
  homeCarouselIndexForKey,
  homeCarouselLoopTargetAtOffset,
} from "./homeCardCarouselSelection";

const keys: readonly (string | null)[] = [null, "visa", "bitcoin", "euro"];

describe("home carousel selection", () => {
  afterEach(() => vi.useRealTimers());

  it("maps rendered offsets and wraps both clone boundaries", () => {
    expect(homeCarouselLoopTargetAtOffset(keys, 300, 300)).toEqual({
      key: null,
      canonicalIndex: 1,
      shouldReset: false,
    });
    expect(homeCarouselLoopTargetAtOffset(keys, 600, 300)).toEqual({
      key: "visa",
      canonicalIndex: 2,
      shouldReset: false,
    });
    expect(homeCarouselLoopTargetAtOffset(keys, 0, 300)).toEqual({
      key: "euro",
      canonicalIndex: 4,
      shouldReset: true,
    });
    expect(homeCarouselLoopTargetAtOffset(keys, 5 * 300, 300)).toEqual({
      key: null,
      canonicalIndex: 1,
      shouldReset: true,
    });
  });

  it("keeps selection attached to its stable key after reordering", () => {
    expect(homeCarouselIndexForKey(keys, "bitcoin")).toBe(2);
    expect(homeCarouselIndexForKey([null, "bitcoin", "visa", "euro"], "bitcoin")).toBe(1);
  });

  it("maps only explicit accessibility and keyboard actions", () => {
    expect(homeCarouselIndexAfterAction(1, 4, "increment")).toBe(2);
    expect(homeCarouselIndexAfterAction(1, 4, "ArrowRight")).toBe(2);
    expect(homeCarouselIndexAfterAction(1, 4, "decrement")).toBe(0);
    expect(homeCarouselIndexAfterAction(1, 4, "ArrowLeft")).toBe(0);
    expect(homeCarouselIndexAfterAction(1, 4, "activate")).toBeNull();
    expect(homeCarouselIndexAfterAction(0, 4, "ArrowLeft")).toBe(3);
    expect(homeCarouselIndexAfterAction(3, 4, "ArrowRight")).toBe(0);
    expect(homeCarouselIndexAfterAction(0, 0, "ArrowRight")).toBeNull();
  });

  it("does not settle a paused partial drag until release", () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const controller = createHomeCarouselSettleController({ delayMs: 100, onSettle });

    controller.start();
    controller.scroll(160);
    vi.advanceTimersByTime(1_000);
    expect(onSettle).not.toHaveBeenCalled();

    controller.end();
    vi.advanceTimersByTime(100);
    expect(onSettle).toHaveBeenCalledOnce();
    expect(onSettle).toHaveBeenCalledWith(160);
  });

  it("settles the final momentum offset rather than the release offset", () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const controller = createHomeCarouselSettleController({ delayMs: 100, onSettle });

    controller.start();
    controller.scroll(160);
    controller.end();
    controller.scroll(240);
    controller.scroll(300);
    vi.advanceTimersByTime(100);

    expect(onSettle).toHaveBeenCalledOnce();
    expect(onSettle).toHaveBeenCalledWith(300);
  });

  it("ignores initial clone-offset/programmatic scrolls until actual input", () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const controller = createHomeCarouselSettleController({ delayMs: 100, onSettle });
    expect(controller.scroll(0)).toBe(false);
    controller.end(0);
    expect(controller.settle(0)).toBe(false);
    vi.runAllTimers();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it.each([40, 90, 110])(
    "explicit reset at %ims cancels pending and late gesture events",
    (delay) => {
      vi.useFakeTimers();
      const onSettle = vi.fn();
      const controller = createHomeCarouselSettleController({ delayMs: 100, onSettle });
      controller.start();
      controller.scroll(160);
      controller.end();
      vi.advanceTimersByTime(delay);
      controller.reset();
      onSettle.mockClear();
      expect(controller.scroll(0)).toBe(false);
      controller.end(0);
      expect(controller.settle(0)).toBe(false);
      vi.runAllTimers();
      expect(onSettle).not.toHaveBeenCalled();

      // A new touch at the explicit target must not inherit the old offset.
      controller.start(300);
      controller.end();
      vi.runAllTimers();
      expect(onSettle).toHaveBeenLastCalledWith(300);
    },
  );

  it("accepts fresh wheel scrolling after reset without a touch release", () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const controller = createHomeCarouselSettleController({ delayMs: 100, onSettle });
    controller.reset();
    controller.wheel();
    expect(controller.scroll(600)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(onSettle).toHaveBeenCalledWith(600);
  });
});
