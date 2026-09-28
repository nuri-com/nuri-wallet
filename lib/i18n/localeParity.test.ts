import { describe, expect, it } from "vitest";
import { de } from "./de";
import { en } from "./en";

// Locale fallback is off: a key present in one locale and missing in the other
// renders as its own name on screen. The "Max X available" figure reached
// production German that way, so the two trees are compared as a whole rather
// than key by key as each is noticed.
function paths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("locale parity", () => {
  it("defines the same keys in every locale", () => {
    const enKeys = new Set(paths(en));
    const deKeys = new Set(paths(de));

    expect([...enKeys].filter((key) => !deKeys.has(key))).toEqual([]);
    expect([...deKeys].filter((key) => !enKeys.has(key))).toEqual([]);
  });
});
