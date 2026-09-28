/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Designed to be safe inside `||` priority chains:
 *   - Error with non-empty `.message` → the message
 *   - non-empty string thrown directly → the string
 *   - plain object with non-empty string `.message` → that message
 *     (covers React Native native modules / SDKs that throw Error-like
 *     objects without an Error prototype)
 *   - anything else (null/undefined/0/"", `new Error("")`, plain objects
 *     without `.message`, numbers, etc.) → `fallback` (default `""`)
 *
 * Always returns a string. Returns `""` (falsy) when there is no usable
 * message and no fallback provided, so chains like
 * `errMsg(a) || errMsg(b) || "default"` short-circuit correctly.
 *
 * Use this for the common `catch (e: unknown)` shape where the body just
 * needs a string for logging, error reporting, or `setError(...)`. Catch
 * blocks that read `.code`, `.name`, or `.stack` should use `errName()`
 * (or read the field directly) since this helper only returns the message.
 */
export function errMsg(e: unknown, fallback = ""): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}

/**
 * Extract `.name` from an unknown caught value as a string.
 *
 * Works on `Error` instances and on Error-like plain objects (common when
 * native fetch / native modules throw `{ name: "AbortError", ... }` without
 * an Error prototype). Returns `undefined` when no usable name is present.
 *
 * Use this for control flow that branches on `name === "AbortError"` and
 * similar — checking `instanceof Error` first would miss real timeouts
 * thrown by RN/native code as plain objects.
 */
export function errName(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null) {
    const n = (e as { name?: unknown }).name;
    if (typeof n === "string" && n) return n;
  }
  return undefined;
}

/**
 * The parts of a caught value that are safe to LOG: its class and its code,
 * each bounded.
 *
 * The message is deliberately not among them. A provider message is
 * attacker-influenced, unbounded, and has carried credential identifiers,
 * addresses and key material in other stacks — none of which belongs in a log
 * that outlives the failure and travels with a support report. The class and
 * code say which failure it was, which is what a report needs.
 *
 * Use this instead of `errMsg` wherever a caught value crosses into a log or a
 * report. `errMsg` remains right for control flow and for text a user reads.
 */
export function errDescription(e: unknown): { errClass: string; errCode?: string } {
  const name = errName(e) || Object.prototype.toString.call(e).slice(8, -1);
  const raw = (e as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  return {
    errClass: name.slice(0, 64),
    ...(code ? { errCode: code.slice(0, 64) } : {}),
  };
}
