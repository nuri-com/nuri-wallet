import { describe, expect, it } from "vitest";
import { hasOpenSurface, noteSurfaceOpened, subscribeOpenSurfaces } from "./openSurfaces";

describe("openSurfaces", () => {
  it("reports a clear screen when nothing is open", () => {
    expect(hasOpenSurface()).toBe(false);
  });

  it("stays open until every surface has closed", () => {
    // A sheet opened from within a sheet: the screen is not clear again until
    // both are gone, or the update toast appears over the one still up.
    const closeOuter = noteSurfaceOpened();
    const closeInner = noteSurfaceOpened();
    expect(hasOpenSurface()).toBe(true);
    closeInner();
    expect(hasOpenSurface()).toBe(true);
    closeOuter();
    expect(hasOpenSurface()).toBe(false);
  });

  it("ignores a surface closing twice", () => {
    const close = noteSurfaceOpened();
    close();
    close();
    expect(hasOpenSurface()).toBe(false);
  });

  it("notifies subscribers on both edges", () => {
    const seen: number[] = [];
    const off = subscribeOpenSurfaces((open) => seen.push(open));
    const close = noteSurfaceOpened();
    close();
    off();
    noteSurfaceOpened();
    expect(seen).toEqual([1, 0]);
  });
});
