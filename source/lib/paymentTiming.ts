// Payment timing, dev builds only (__DEV__): one line per step of a payment,
// from the user's tap to the passkey and on to the funding, so a local run can
// show where the phone spends its time. Each line carries the time since the
// payment started and the step's own duration:
//
//   ⏱ PAY send +1840ms swapkit.swap.commit took=1203ms
//
// Nothing here changes behaviour; in release builds every call returns at once.

type Fields = Record<string, string | number | boolean | null | undefined>;

/** A payment not marked for this long is over; the next mark starts a new one. */
const IDLE_MS = 120_000;

let current: { label: string; startedAt: number; lastAt: number } | null = null;

const enabled = (): boolean => typeof __DEV__ !== "undefined" && __DEV__;

/** Whether timing lines are written (dev builds). */
export const paymentTimingEnabled = enabled;

const format = (fields?: Fields): string =>
  fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => ` ${key}=${String(value)}`)
        .join("")
    : "";

/** A payment starts now (the user's tap). */
export function paymentTimingStart(label: string, fields?: Fields): void {
  if (!enabled()) return;
  const now = Date.now();
  current = { label, startedAt: now, lastAt: now };
  console.log(`⏱ PAY ${label} start at=${new Date(now).toISOString()}${format(fields)}`);
}

/** One step reached. Starts a payment when none is running. */
export function paymentTimingMark(step: string, fields?: Fields): void {
  if (!enabled()) return;
  const now = Date.now();
  if (!current || now - current.lastAt > IDLE_MS) paymentTimingStart("auto");
  const run = current;
  if (!run) return;
  console.log(`⏱ PAY ${run.label} +${now - run.startedAt}ms ${step}${format(fields)}`);
  run.lastAt = now;
}

/** Time one awaited step; its line carries its own duration, success or not. */
export async function paymentTimed<T>(
  step: string,
  fn: () => Promise<T>,
  fields?: Fields,
): Promise<T> {
  if (!enabled()) return fn();
  const started = Date.now();
  let ok = false;
  try {
    const result = await fn();
    ok = true;
    return result;
  } finally {
    paymentTimingMark(step, {
      ...fields,
      took: `${Date.now() - started}ms`,
      ...(ok ? {} : { failed: true }),
    });
  }
}
