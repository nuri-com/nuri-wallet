import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Arkade Lightning v2 migration", () => {
  it("does not use the v1 SwapKit transport", () => {
    const source = readFileSync(
      new URL("./SwapKitArkadeLightningSendService.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(source).toContain('from "./SwapKitV2Service"');
    expect(source).not.toContain('from "./SwapKitService"');
  });
});
