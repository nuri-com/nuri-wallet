import { describe, expect, it } from "vitest";
import { applyVerifiedHomeHandle } from "./homeIdentity";

const ENS_PARENT = "nuri.eth";

describe("applyVerifiedHomeHandle", () => {
  it("applies a verified handle that arrives after Home mounted", () => {
    expect(applyVerifiedHomeHandle(null, "  EMINO  ", ENS_PARENT)).toEqual({
      handle: "emino",
      username: "Emino",
      ensName: "emino.nuri.eth",
    });
  });

  it("never erases a known identity for an empty hydration status", () => {
    const known = applyVerifiedHomeHandle(null, "emino", ENS_PARENT);
    expect(applyVerifiedHomeHandle(known, "", ENS_PARENT)).toBe(known);
    expect(applyVerifiedHomeHandle(known, null, ENS_PARENT)).toBe(known);
  });
});
