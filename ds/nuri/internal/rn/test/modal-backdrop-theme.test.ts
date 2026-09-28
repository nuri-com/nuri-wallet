import { describe, expect, it } from "vitest";
import { buildNuriTheme } from "../runtime/theme-payload";

// The full-mode Modal backdrop is painted from the ACTIVE theme's
// chrome.canvas.bg (Modal.tsx). Pin both modes so a hardcoded literal cannot
// silently regress: light #fffdf2, dark #12110b (generated data/tokens.ts).
describe("full-modal backdrop theme", () => {
  it("light: backdrop equals chrome.canvas.bg (#fffdf2)", () => {
    expect(buildNuriTheme("lilac", "light").chrome.canvas.bg).toBe("#fffdf2");
  });

  it("dark: backdrop equals chrome.canvas.bg (#12110b)", () => {
    expect(buildNuriTheme("lilac", "dark").chrome.canvas.bg).toBe("#12110b");
  });
});
