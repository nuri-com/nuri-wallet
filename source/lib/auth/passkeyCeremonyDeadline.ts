// Passkey ceremonies have no built-in deadline in the app: the WebAuthn
// `timeout` is advisory (Android Chrome ignores it), and every caller clears its
// busy flag only in the promise's continuation. A ceremony that never settles
// therefore disables the login screen's restore button forever with no error,
// which is exactly what users report as "the button does nothing".
//
// 90 s sits above the 60 s WebAuthn timeout so a user still entering a PIN is
// never cut off; it only rescues a ceremony the platform has abandoned.

export const CEREMONY_DEADLINE_MS = 90_000;
export const CEREMONY_DEADLINE_CODE = "ceremony_deadline_exceeded";

export function withCeremonyDeadline<T>(
  promise: Promise<T>,
  ms: number = CEREMONY_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(CEREMONY_DEADLINE_CODE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
