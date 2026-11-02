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
//
// Either way the app has to be able to PAY the link, or the payer lands on a
// sign-in screen instead of the page (#1814): an installed PWA with no wallet
// in it stays on the page, and a native app with no wallet sends the link
// back here with `?browser=1`, which keeps the page from handing it over again.
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

/**
 * Query flag the native app adds when it hands a link back to the browser
 * because it holds no wallet to pay it from: the page must not hand it over again.
 */
export const PAY_LINK_STAY_PARAM = "browser";

/** The pay page for this link, marked so it stays in the browser. */
export function payLinkBrowserUrl(intent: PayIntent, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const params = payIntentParams(intent);
  params.set(PAY_LINK_STAY_PARAM, "1");
  return `${base}/pay/@${intent.username}?${params.toString()}`;
}

/** Whether the page was opened by the app handing the link back (`?browser=1`). */
export function staysInBrowser(search: string): boolean {
  try {
    return new URLSearchParams(String(search || "")).get(PAY_LINK_STAY_PARAM) === "1";
  } catch {
    return false;
  }
}

export type PayLinkHandoff = "installed-app" | "scheme" | "none";

/**
 * Where a payable link goes. The installed PWA and any browser tab of this site
 * share this origin's storage, so the page can see whether it holds a wallet:
 * with one, the link opens the app's send flow for that person; without one an
 * installed PWA would only show its sign-in screen, so the page stays. The
 * native app is checked on its own side (it sends a link it cannot pay back
 * with `?browser=1`).
 */
export function planPayLinkHandoff(opts: {
  installed: boolean;
  walletOnDevice: boolean;
  staysInBrowser: boolean;
}): PayLinkHandoff {
  if (opts.staysInBrowser) return "none";
  // A wallet on this origin pays the link in the app's own send flow, whether
  // the page opened in the installed PWA or in a browser tab of the same site.
  if (opts.walletOnDevice) return "installed-app";
  if (opts.installed) return "none";
  return "scheme";
}

/** True inside an installed PWA (the window the app was added to). */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Opens the payment link in the app, once, as soon as the page knows the link is
 * payable. Nothing happens when the app is not there or cannot pay it: the pay
 * page underneath is the fallback. `walletOnDevice` reads this origin's wallet
 * storage (injected so the page never imports key storage itself).
 */
export function usePayLinkAppHandoff(
  intent: PayIntent | null,
  enabled: boolean,
  walletOnDevice: () => Promise<boolean>,
): void {
  const fired = useRef(false);
  useEffect(() => {
    if (!enabled || !intent || fired.current) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    fired.current = true;
    const stay = staysInBrowser(window.location.search);
    if (stay) {
      // Drop the flag from the address bar, so a copied link hands over again.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete(PAY_LINK_STAY_PARAM);
        window.history?.replaceState?.(window.history.state, "", url.pathname + url.search);
      } catch {}
      return;
    }
    let cancelled = false;
    let decided = false;
    let frame: HTMLIFrameElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const installed = isInstalledApp();
      const hasWallet = await walletOnDevice().catch(() => false);
      if (cancelled) return;
      decided = true;
      const plan = planPayLinkHandoff({
        installed,
        walletOnDevice: hasWallet,
        staysInBrowser: false,
      });
      if (plan === "installed-app") {
        // Same origin: this stays inside the installed window and loads the
        // signed-in app, which opens the confirm screen for this link.
        window.location.assign(payIntentWebUrl(intent, window.location.origin));
        return;
      }
      if (plan !== "scheme") return;
      // A phone browser: no origin change to make, so try the scheme. A frame
      // keeps an uninstalled phone quiet (a top-level navigation to an unknown
      // scheme shows the browser's own error page).
      const node = document.createElement("iframe");
      node.style.display = "none";
      node.setAttribute("aria-hidden", "true");
      node.src = payIntentDeepLink(intent);
      document.body.appendChild(node);
      frame = node;
      timer = setTimeout(() => node.remove(), 2_000);
    })();
    return () => {
      cancelled = true;
      // Torn down before the wallet check answered: nothing was handed over,
      // so the next run may still do it.
      if (!decided) fired.current = false;
      if (timer) clearTimeout(timer);
      frame?.remove();
    };
  }, [enabled, intent, walletOnDevice]);
}
