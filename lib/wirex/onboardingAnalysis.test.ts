import { describe, expect, it } from "vitest";
import {
  getKycSdkTokenFromPayload,
  hasActiveCard,
  hasActiveSepa,
  hasOnboardingStep,
  isExpectedStepIssue,
  isStepHealthy,
  needsOnDeviceAaBootstrap,
} from "./onboardingAnalysis";

describe("Wirex onboarding analysis", () => {
  it.each([
    ["already-created user", "create_user", "already_exists", 409, {}, true],
    [
      "already-verified KYC link",
      "kyc_link",
      "",
      400,
      { error_description: "User is already verified" },
      true,
    ],
    [
      "already-verified KYC token",
      "kyc_token",
      "",
      400,
      { error_description: "already VERIFIED" },
      true,
    ],
    ["SEPA activation 400", "activate_bank_sepa", "", 400, {}, true],
    ["sandbox ACH activation", "sandbox_activate_ach_customer", "", 500, {}, true],
    [
      "unexpected KYC error",
      "kyc_link",
      "",
      500,
      { error_description: "server unavailable" },
      false,
    ],
  ] as const)("marks %s expected=%s", (_label, name, note, status, payload, expected) => {
    expect(isExpectedStepIssue(name, note, status, payload)).toBe(expected);
  });

  it.each([
    [{ ok: true }, true],
    [{ ok: false, note: "accepted" }, true],
    [{ ok: false, note: "skipped_existing_card" }, true],
    [
      {
        ok: false,
        name: "kyc_token",
        status: 400,
        payload: { error_description: "already verified" },
      },
      true,
    ],
    [{ ok: false, name: "kyc_token", status: 500, payload: { error_description: "boom" } }, false],
  ])("classifies step health for %#", (step, expected) => {
    expect(isStepHealthy(step)).toBe(expected);
  });

  it("gates active SEPA and card status case-insensitively", () => {
    expect(
      hasActiveSepa([
        { account_type: "ach", status: "active" },
        { account_type: "SEPA", status: "ACTIVE" },
      ]),
    ).toBe(true);
    expect(hasActiveSepa([{ account_type: "sepa", status: "pending" }])).toBe(false);
    expect(hasActiveCard([{ status: "inactive" }, { status: "Active" }])).toBe(true);
    expect(hasActiveCard([{ status: "blocked" }])).toBe(false);
  });

  it("extracts KYC SDK token and detects onboarding bootstrap gates", () => {
    const payload = {
      steps: [
        { name: "create_user", note: "ok", payload: { token: "ignored" } },
        { name: "kyc_token", payload: { token: " sdk-token " } },
      ],
    };
    expect(getKycSdkTokenFromPayload(payload)).toBe("sdk-token");
    expect(hasOnboardingStep(payload, "create_user", "ok")).toBe(true);
    expect(needsOnDeviceAaBootstrap({ error: "aa_bootstrap_required_on_device" })).toBe(true);
    expect(
      needsOnDeviceAaBootstrap({
        steps: [{ name: "create_user", note: "not_registered_onchain" }],
      }),
    ).toBe(true);
    expect(needsOnDeviceAaBootstrap(payload)).toBe(false);
  });
});
