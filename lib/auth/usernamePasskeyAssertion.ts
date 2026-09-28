import { sanitizePasskeyError } from "./passkeyError";

type PreparedUsernameAssertion = {
  rpId: string;
  challengeB64u: string;
  credIdB64u: string;
};

type UsernameAssertion = {
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type UsernameAssertionFailure = {
  phase: "prepare" | "assertion" | "cache" | "submit";
  code: string;
  errorName: string;
};

type Result = { ok: true } | { ok: false; failure: UsernameAssertionFailure };

export function acquireUsernameAssertionLock(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export async function completeUsernamePasskeyAssertion({
  prepared,
  getAssertion,
  cacheAssertion,
  submit,
}: {
  prepared: PreparedUsernameAssertion | null;
  getAssertion: (prepared: PreparedUsernameAssertion) => Promise<UsernameAssertion>;
  cacheAssertion: (assertion: Omit<UsernameAssertion, "credIdB64u">) => boolean | Promise<boolean>;
  submit: () => boolean;
}): Promise<Result> {
  if (!prepared || !prepared.rpId || !prepared.challengeB64u || !prepared.credIdB64u) {
    return {
      ok: false,
      failure: { phase: "prepare", code: "missing_prefetch", errorName: "Unavailable" },
    };
  }

  let assertion: UsernameAssertion;
  try {
    assertion = await getAssertion(prepared);
  } catch (error) {
    return { ok: false, failure: { phase: "assertion", ...sanitizePasskeyError(error) } };
  }

  if (
    !assertion ||
    typeof assertion !== "object" ||
    typeof assertion.credIdB64u !== "string" ||
    typeof assertion.clientDataB64u !== "string" ||
    typeof assertion.authDataB64u !== "string" ||
    typeof assertion.sigB64u !== "string" ||
    !assertion.clientDataB64u ||
    !assertion.authDataB64u ||
    !assertion.sigB64u ||
    assertion.credIdB64u !== prepared.credIdB64u
  ) {
    return {
      ok: false,
      failure: { phase: "assertion", code: "malformed_assertion", errorName: "InvalidResult" },
    };
  }

  let cached: boolean;
  try {
    cached = await cacheAssertion({
      clientDataB64u: assertion.clientDataB64u,
      authDataB64u: assertion.authDataB64u,
      sigB64u: assertion.sigB64u,
    });
  } catch (error) {
    return { ok: false, failure: { phase: "cache", ...sanitizePasskeyError(error) } };
  }

  if (!cached) {
    return {
      ok: false,
      failure: { phase: "cache", code: "stale_prefetch", errorName: "Unavailable" },
    };
  }

  try {
    if (submit()) return { ok: true };
    return {
      ok: false,
      failure: { phase: "submit", code: "submit_unavailable", errorName: "Unavailable" },
    };
  } catch (error) {
    return { ok: false, failure: { phase: "submit", ...sanitizePasskeyError(error) } };
  }
}
