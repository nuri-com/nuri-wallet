/**
 * `String.prototype.isWellFormed` for Hermes, which does not have it.
 *
 * `@scure/base` (the text coder under `@scure/btc-signer`) checks for this method once at load and
 * falls back to its own check when it is missing. Metro folds that check at BUILD time, on the
 * build machine's Node, which has the method, so the app bundle always calls it and every Bitcoin
 * transaction encode fails on the phone with "undefined is not a function". Defining it here gives
 * that call a real method to land on.
 */
export function isWellFormedString(value: string): boolean {
  // encodeURI throws on a lone UTF-16 surrogate, which is exactly what "not well formed" means.
  try {
    encodeURI(value);
    return true;
  } catch {
    return false;
  }
}

export function installStringIsWellFormed(): void {
  if (typeof String.prototype.isWellFormed === "function") return;
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function isWellFormed(this: unknown): boolean {
      if (this === null || this === undefined) {
        throw new TypeError("String.prototype.isWellFormed called on null or undefined");
      }
      return isWellFormedString(String(this));
    },
  });
}

installStringIsWellFormed();
