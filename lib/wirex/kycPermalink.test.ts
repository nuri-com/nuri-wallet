import { describe, expect, it } from "vitest";
import { canResumeWirexKyc, wirexKycPermalink } from "./kycPermalink";

const BASE = "https://banking.nuri.com";

describe("wirexKycPermalink", () => {
  it("builds the stable KYC permalink from the authenticated username", () => {
    expect(wirexKycPermalink(" Alexei76 ", BASE)).toBe("https://banking.nuri.com/mcp/kyc/alexei76");
  });

  it("rejects missing or path-shaped usernames", () => {
    expect(wirexKycPermalink(null, BASE)).toBeNull();
    expect(wirexKycPermalink("alexei76/other", BASE)).toBeNull();
  });

  it("normalizes a trailing slash on the configured host", () => {
    expect(wirexKycPermalink("emino", `${BASE}/`)).toBe("https://banking.nuri.com/mcp/kyc/emino");
  });
});

describe("canResumeWirexKyc", () => {
  it.each(["Applied", "Pending", "In review"])("resumes known unfinished status %s", (status) => {
    expect(canResumeWirexKyc(status, false, false)).toBe(true);
  });

  it("does not resume before an account exists or after a final status", () => {
    expect(canResumeWirexKyc("unknown", false, false)).toBe(false);
    expect(canResumeWirexKyc("", false, false)).toBe(false);
    expect(canResumeWirexKyc("Approved", false, false)).toBe(false);
    expect(canResumeWirexKyc("Rejected", false, false)).toBe(false);
  });
});
