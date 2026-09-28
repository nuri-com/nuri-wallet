import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("redacts bearer session ids (JSON and key=value forms)", () => {
    expect(redact('{"session_id":"abcdef1234567890"}')).toBe('{"session_id":"[REDACTED]"}');
    expect(redact("register_session_id=xyz789abcdef")).toBe("register_session_id=[REDACTED]");
    expect(redact("sessionId: 0f8a19cc42ee")).toContain("[REDACTED]");
    // The bearer value itself must not survive anywhere in the output.
    expect(redact('{"register_session_id":"secret-bearer-value"}')).not.toContain(
      "secret-bearer-value",
    );
  });

  it("does not touch the presence booleans we log instead", () => {
    expect(redact("session_id_present: false")).toBe("session_id_present: false");
    expect(redact('{"register_session_id_present":true}')).toBe(
      '{"register_session_id_present":true}',
    );
  });

  it("still redacts private key material", () => {
    const pk = redact('privateKey: "deadbeefdeadbeef"');
    expect(pk).toContain("[REDACTED]");
    expect(pk).not.toContain("deadbeefdeadbeef");
    expect(redact("mnemonic=abandonabandonabandon")).toContain("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("onboard: start ok")).toBe("onboard: start ok");
  });
});
