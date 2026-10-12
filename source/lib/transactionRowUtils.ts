import { getAppLocale } from "./i18n";

/** Format an ISO string or unix timestamp (seconds) to "HH:MM" local time. */
const formatTxTime = (iso?: string | null, unixSeconds?: number | null): string => {
  try {
    const d = unixSeconds ? new Date(unixSeconds * 1000) : iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
};

/** Prepend time to an existing subtitle. Returns "HH:MM · subtitle" or just "HH:MM" or just subtitle. */
export const withTxTime = (time: string, subtitle: string): string => {
  if (time && subtitle) return `${time} · ${subtitle}`;
  return time || subtitle;
};

/**
 * Activity-row time: "HH:MM" for today, otherwise a locale short date
 * (e.g. "Sat, Jul 4"). The row sublabel carries the day now that the
 * ActivitySheet sections are months, not days.
 */
export const formatActivityTime = (iso?: string | null, unixSeconds?: number | null): string => {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTxTime(iso, unixSeconds);
  return d.toLocaleDateString(getAppLocale(), { weekday: "short", day: "numeric", month: "short" });
};
