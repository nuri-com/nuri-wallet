// Handing a payment link to the Nuri app.
//
// The pay page is built for strangers: it never mounts a session and cannot pay
// from a Nuri balance. A payer who has the app, though, should not sign and pay
// from a browser wallet at all: the link opens the app, and the app shows the
// confirm screen for that person and that figure (`lib/pay/payIntent`,
// `UnifiedHomeScreen`). The page stays as the fallback, which is what a payer
// without the app needs.
//
// Two ways in, because the app is reachable two ways:
//   · installed PWA: the same origin, so it is a plain in-place navigation that
//     keeps the standalone window (`/?pay=@name&to=…&amount=…`);
//   · native app: the link scheme (`nuri://pay/@name?…`), fired through a
//     hidden frame so a phone WITHOUT the app gets no "cannot open page" dialog.
import { useEffect, useRef } from "react";

import type { PayIntent } from "./payIntent";

/** `nuri://pay/@name?to=…&amount=…`, what the native app's router reads. */
export function payIntentDeepLink(intent: PayIntent): string {
  const params = payIntentParams(intent);
  const query = params.toString();
  return `nuri://pay/@${intent.username}${query ? `?${query}` : ""}`;
}

/** `/?pay=@name&to=…&amount=…`, what the signed-in web app (and the PWA) reads. */
export function payIntentWebUrl(intent: PayIntent, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const params = payIntentParams(intent);
  params.set("pay", `@${intent.username}`);
  return `${base}/?${params.toString()}`;
}

/**
 * The settlement a link ACTUALLY asked for. A plain link asked for nothing, so
 * it carries no `to=` and the app keeps every rail the person has: sending the
 * euro default would turn it into an explicit euro request and drop a recipient
 * who can only be paid in bitcoin.
 */
function payIntentParams(intent: PayIntent): URLSearchParams {
  const params = new URLSearchParams();
  if (intent.explicit) params.set("to", intent.settle);
  if (intent.amount) params.set("amount", intent.amount);
  return params;
}

/** True inside an installed PWA (the window the app was added to). */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Opens the payment link in the app, once, as soon as the page knows the link is
 * payable. Nothing happens when the app is not there: the pay page underneath is
 * the fallback.
 */
export function usePayLinkAppHandoff(intent: PayIntent | null, enabled: boolean): void {
  const fired = useRef(false);
  useEffect(() => {
    if (!enabled || !intent || fired.current) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    fired.current = true;
    if (isInstalledApp()) {
      // Same origin: this stays inside the installed window and loads the
      // signed-in app, which opens the confirm screen for this link.
      window.location.assign(payIntentWebUrl(intent, window.location.origin));
      return;
    }
    // A phone browser: no origin change to make, so try the scheme. A frame
    // keeps an uninstalled phone quiet (a top-level navigation to an unknown
    // scheme shows the browser's own error page).
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.setAttribute("aria-hidden", "true");
    frame.src = payIntentDeepLink(intent);
    document.body.appendChild(frame);
    const timer = window.setTimeout(() => frame.remove(), 2_000);
    return () => {
      window.clearTimeout(timer);
      frame.remove();
    };
  }, [enabled, intent]);
}
