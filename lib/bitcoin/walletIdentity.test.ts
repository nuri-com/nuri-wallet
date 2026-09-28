import { describe, expect, it } from "vitest";
import { isSameWalletIdentity } from "./walletIdentity";

describe("isSameWalletIdentity", () => {
  it("accepts an unchanged identity", () => {
    expect(
      isSameWalletIdentity({ credId: "cred-a", epoch: 7 }, { credId: "cred-a", epoch: 7 }),
    ).toBe(true);
  });

  // The race: the identity was replaced (epoch bumped, other credential loaded) while keys resolved.
  it("refuses an install started under another credential", () => {
    expect(
      isSameWalletIdentity({ credId: "cred-a", epoch: 7 }, { credId: "cred-b", epoch: 8 }),
    ).toBe(false);
  });

  it("refuses when only the epoch moved", () => {
    expect(
      isSameWalletIdentity({ credId: "cred-a", epoch: 7 }, { credId: "cred-a", epoch: 8 }),
    ).toBe(false);
  });

  it("refuses when the credential became unknown", () => {
    expect(isSameWalletIdentity({ credId: "cred-a", epoch: 7 }, { credId: null, epoch: 7 })).toBe(
      false,
    );
  });
});
