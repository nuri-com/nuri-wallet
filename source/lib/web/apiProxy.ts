/**
 * Web (PWA) ONLY: redirect backend API calls to same-origin `/api/*` paths so the
 * browser never issues a cross-origin request — which means CORS never applies.
 * nginx on the PWA host reverse-proxies `/api/<svc>/*` to the real backend
 * server-to-server (no CORS there either). The backends are therefore NOT
 * modified, so the native app and every other client are completely unaffected.
 *
 * No-op anywhere without a DOM (i.e. native). Patches both fetch and
 * XMLHttpRequest (axios uses XHR in the browser). Pairs with the `/api/*`
 * locations in the pwa.nuri.com nginx vhost.
 */

// NOTE: the Wirex (banking/wirex.nuri.com), SwapKit (swapkit.nuri.com) and
// Frankfurter (api.frankfurter.dev) backends are NOT listed here on purpose —
// they serve open CORS, so the browser calls them directly. Rewriting them to a
// same-origin /api/* path would instead route to a proxy location that doesn't
// exist and break the working direct call. Only backends WITHOUT browser CORS
// (arkade/arknode/update) belong in this table.
const REWRITES: Array<[string, string]> = [
  ["https://arkade.nuri.com", "/api/arkade"],
  ["https://arkade.computer", "/api/arknode"],
  // update.nuri.com (the must-update version gate) serves no browser CORS, so
  // the direct fetch fails on web and the gate silently defaults to "no update".
  ["https://update.nuri.com", "/api/update"],
  // nadanada.me (eSIM shop) serves no browser CORS.
  ["https://nadanada.me", "/api/nadanada"],
];

// Exported so non-fetch web callers (e.g. EventSource, which the fetch/XHR
// interceptor below does not cover) can map a backend URL to the same-origin
// proxy path using the exact same rewrite table.
export function rewriteUrl(url: string): string {
  for (const [host, path] of REWRITES) {
    if (url.startsWith(host)) return path + url.slice(host.length);
  }
  return url;
}

/**
 * LNURL is the one flow whose target host is not knowable in advance — a
 * Lightning address can live on any domain, and the `callback` URL comes from
 * that domain — so it cannot be a prefix rewrite like the table above. nginx
 * exposes an SSRF-guarded forwarder at `/api/lnurl?url=<target>` that makes the
 * outbound call server-side; routing web LNURL fetches through it is what lets
 * the page CSP keep an explicit `connect-src` host list instead of allowing
 * every https host. No-op on native, which calls the target directly.
 */
export function lnurlFetchUrl(url: string): string {
  if (typeof (globalThis as { document?: unknown }).document === "undefined") return url;
  return `/api/lnurl?url=${encodeURIComponent(url)}`;
}

export function installApiProxy(): void {
  const w = globalThis as unknown as {
    document?: unknown;
    fetch?: (input: unknown, init?: unknown) => Promise<unknown>;
    XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => unknown } };
    Request?: new (url: string, init: unknown) => unknown;
  };
  // Browser only — React Native has no `document`.
  if (typeof w.document === "undefined") return;

  const origFetch = w.fetch;
  if (origFetch && !(origFetch as { __nuriProxied?: boolean }).__nuriProxied) {
    const patched = (input: unknown, init?: unknown) => {
      try {
        if (typeof input === "string") {
          input = rewriteUrl(input);
        } else if (input && typeof (input as { url?: string }).url === "string") {
          const req = input as { url: string };
          const next = rewriteUrl(req.url);
          if (next !== req.url && w.Request) input = new w.Request(next, req);
        }
      } catch {}
      return origFetch(input, init);
    };
    (patched as { __nuriProxied?: boolean }).__nuriProxied = true;
    w.fetch = patched;
  }

  const XHR = w.XMLHttpRequest;
  if (XHR && !(XHR.prototype.open as { __nuriProxied?: boolean }).__nuriProxied) {
    const origOpen = XHR.prototype.open;
    const patchedOpen = function (this: unknown, ...args: unknown[]) {
      try {
        if (typeof args[1] === "string") args[1] = rewriteUrl(args[1] as string);
      } catch {}
      return origOpen.apply(this, args);
    };
    (patchedOpen as { __nuriProxied?: boolean }).__nuriProxied = true;
    XHR.prototype.open = patchedOpen;
  }
}
