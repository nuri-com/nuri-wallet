import { describe, expect, it, vi } from "vitest";
import {
  acquireUsernameAssertionLock,
  completeUsernamePasskeyAssertion,
} from "./usernamePasskeyAssertion";

const prepared = { rpId: "nuri.com", challengeB64u: "challenge", credIdB64u: "credential" };
const assertion = {
  credIdB64u: "credential",
  clientDataB64u: "client-data",
  authDataB64u: "auth-data",
  sigB64u: "signature",
};

describe("completeUsernamePasskeyAssertion", () => {
  it("caches a bound assertion and submits exactly once", async () => {
    const cacheAssertion = vi.fn(async () => true);
    const submit = vi.fn(() => true);

    await expect(
      completeUsernamePasskeyAssertion({
        prepared,
        getAssertion: vi.fn(async () => assertion),
        cacheAssertion,
        submit,
      }),
    ).resolves.toEqual({ ok: true });
    expect(cacheAssertion).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("surfaces provider cancellation without caching or submitting", async () => {
    const cacheAssertion = vi.fn(() => true);
    const submit = vi.fn(() => true);
    const error = Object.assign(new Error("provider detail must not escape"), {
      code: "assertion_failed",
      name: "GetCredentialCancellationException",
    });

    await expect(
      completeUsernamePasskeyAssertion({
        prepared,
        getAssertion: vi.fn(async () => {
          throw error;
        }),
        cacheAssertion,
        submit,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        phase: "assertion",
        code: "assertion_failed",
        errorName: "GetCredentialCancellationException",
      },
    });
    expect(cacheAssertion).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not fall through when prefetch is missing", async () => {
    const getAssertion = vi.fn(async () => assertion);
    const submit = vi.fn(() => true);
    const result = await completeUsernamePasskeyAssertion({
      prepared: null,
      getAssertion,
      cacheAssertion: vi.fn(() => true),
      submit,
    });

    expect(result).toMatchObject({ ok: false, failure: { phase: "prepare" } });
    expect(getAssertion).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects stale prefetch instead of starting an unbound claim", async () => {
    const submit = vi.fn(() => true);
    const result = await completeUsernamePasskeyAssertion({
      prepared,
      getAssertion: vi.fn(async () => assertion),
      cacheAssertion: vi.fn(() => false),
      submit,
    });

    expect(result).toMatchObject({ ok: false, failure: { phase: "cache" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a cache exception without submitting", async () => {
    const submit = vi.fn(() => true);
    const result = await completeUsernamePasskeyAssertion({
      prepared,
      getAssertion: vi.fn(async () => assertion),
      cacheAssertion: vi.fn(() => {
        throw Object.assign(new Error("cache detail"), { code: "cache_failed" });
      }),
      submit,
    });

    expect(result).toEqual({
      ok: false,
      failure: { phase: "cache", code: "cache_failed", errorName: "Error" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an assertion for a different credential", async () => {
    const submit = vi.fn(() => true);
    const result = await completeUsernamePasskeyAssertion({
      prepared,
      getAssertion: vi.fn(async () => ({ ...assertion, credIdB64u: "other-credential" })),
      cacheAssertion: vi.fn(() => true),
      submit,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { phase: "assertion", code: "malformed_assertion" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("allows a successful retry after a provider failure", async () => {
    const submit = vi.fn(() => true);
    const getAssertion = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("cancelled"), { code: "assertion_failed" }))
      .mockResolvedValueOnce(assertion);
    const run = () =>
      completeUsernamePasskeyAssertion({
        prepared,
        getAssertion,
        cacheAssertion: vi.fn(() => true),
        submit,
      });

    await expect(run()).resolves.toMatchObject({ ok: false });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("reports a no-op submit so the caller can release its lock", async () => {
    const result = await completeUsernamePasskeyAssertion({
      prepared,
      getAssertion: vi.fn(async () => assertion),
      cacheAssertion: vi.fn(async () => true),
      submit: vi.fn(() => false),
    });

    expect(result).toEqual({
      ok: false,
      failure: { phase: "submit", code: "submit_unavailable", errorName: "Unavailable" },
    });
  });

  it("classifies a thrown submit separately from cache failure", async () => {
    const result = await completeUsernamePasskeyAssertion({
      prepared,
      getAssertion: vi.fn(async () => assertion),
      cacheAssertion: vi.fn(async () => true),
      submit: vi.fn(() => {
        throw Object.assign(new Error("claim failed"), { code: "claim_failed" });
      }),
    });

    expect(result).toEqual({
      ok: false,
      failure: { phase: "submit", code: "claim_failed", errorName: "Error" },
    });
  });
});

describe("acquireUsernameAssertionLock", () => {
  it("blocks a duplicate tap before React can rerender", () => {
    const lock = { current: false };
    expect(acquireUsernameAssertionLock(lock)).toBe(true);
    expect(acquireUsernameAssertionLock(lock)).toBe(false);
  });
});
