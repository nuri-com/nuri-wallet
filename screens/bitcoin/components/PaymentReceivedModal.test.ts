// Repo convention is pure vitest (no RN render harness), so the dismiss button
// is verified at the seams this codebase can actually run: the i18n keys the
// new "Claim later" button reads must exist in every locale, or German users
// would see the raw key. The button itself only wires onClose (App-level
// suppress + home pending-sweep row already own the rest).
import { describe, expect, it } from "vitest";
import { de } from "../../../lib/i18n/de";
import { en } from "../../../lib/i18n/en";

const KEYS = ["title", "unlockButton", "laterButton"] as const;

describe("PaymentReceivedModal dismiss strings", () => {
  it.each([
    ["en", en.screen.PaymentReceivedModal],
    ["de", de.screen.PaymentReceivedModal],
  ] as const)(
    "%s defines all claim-screen strings incl. the dismiss button",
    (_locale, strings) => {
      for (const key of KEYS) {
        expect(typeof strings[key]).toBe("string");
        expect((strings[key] as string).length).toBeGreaterThan(0);
      }
    },
  );
});
