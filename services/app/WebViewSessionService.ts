// Simple module to control shared cookie usage in WebViews
// Allows a one-shot disable of sharedCookiesEnabled to simulate a fresh install

let sharedCookiesNextEnabled: boolean | null = null;

export function disableSharedCookiesOnce(): void {
  sharedCookiesNextEnabled = false;
}

export function consumeSharedCookiesFlag(defaultValue = true): boolean {
  const value = sharedCookiesNextEnabled;
  sharedCookiesNextEnabled = null; // reset after consumption
  return typeof value === "boolean" ? value : defaultValue;
}
