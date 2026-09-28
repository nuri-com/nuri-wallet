import { describe, expect, it } from "vitest";
import { sanitizePasskeyError } from "./passkeyError";

describe("sanitizePasskeyError", () => {
  it("keeps only bounded class and code fields", () => {
    expect(
      sanitizePasskeyError({
        code: "assertion_failed",
        name: "GetCredentialException",
        message: "credential=secret assertion=secret",
      }),
    ).toEqual({ code: "assertion_failed", errorName: "GetCredentialException" });
    expect(
      sanitizePasskeyError(
        Object.assign(new Error("GetCredentialCancellationException: provider secret"), {
          code: "assertion_failed",
        }),
      ),
    ).toEqual({ code: "assertion_failed", errorName: "GetCredentialCancellationException" });
    expect(sanitizePasskeyError({ code: "secret value with spaces", name: "bad/name" })).toEqual({
      code: "unknown",
      errorName: "unknown",
    });
    expect(
      sanitizePasskeyError(
        Object.assign(new Error("QuotedProviderCredentialException"), {
          name: "ActualError",
        }),
      ),
    ).toEqual({ code: "unknown", errorName: "ActualError" });
  });
});
