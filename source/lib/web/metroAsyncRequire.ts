/**
 * Web (PWA) ONLY: install Metro's async-bundle loader.
 *
 * Metro compiles a dynamic `import()` into a helper that first asks the global
 * `__loadBundleAsync` to fetch the chunk holding the target module, and only
 * then requires it. When that global is missing the helper skips the fetch and
 * synchronously requires a module that lives in a chunk which was never loaded,
 * so the call fails with `Requiring unknown module "<id>"`.
 *
 * Nothing in this app assigned that global: the loader ships inside
 * `@expo/metro-runtime`, which is a dependency of the Expo web setup but is
 * imported nowhere here. Our own code is barred from dynamic import by the lint
 * gate (see AGENTS.md), so the failures came from dependencies — the Arkade
 * SDK's `await import("expo/fetch")` fell back to a plain fetch on every stream
 * open, with the SDK warning that streaming may not be fully supported.
 *
 * Why this instead of importing `@expo/metro-runtime`: that entry also installs
 * HMR, fast-refresh effects, an error overlay, a location polyfill and the RSC
 * runtime, and in development its loader path evaluates the fetched chunk with
 * `eval` — which the page CSP (`script-src 'self'`, no `unsafe-eval`) refuses.
 * The loader below only ever appends a `<script src>` tag pointing at a
 * same-origin `/_expo/static/js/web/*.js` chunk, which `'self'` allows, in both
 * development and production.
 *
 * No-op on native: iOS and Android have no `document`, their bundle carries
 * every module, and they keep the real `expo/fetch`.
 */

type AsyncBundleLoader = (bundlePath: string) => Promise<void>;

/** Metro reads the loader under this prefix; Expo's web bundle sets it to "". */
function loaderGlobalKey(): string {
  const prefix = (globalThis as { __METRO_GLOBAL_PREFIX__?: string }).__METRO_GLOBAL_PREFIX__;
  return `${prefix ?? ""}__loadBundleAsync`;
}

/**
 * Chunk paths arrive as the serializer wrote them (`/_expo/static/js/web/x.js`).
 * Keep them same-origin and absolute: a relative src would resolve against the
 * current route (`/settings/...`) and 404.
 */
function bundleUrl(bundlePath: string): string {
  if (/^https?:\/\//.test(bundlePath)) return bundlePath;
  return `/${bundlePath.replace(/^\/+/, "")}`;
}

function loadChunkViaScriptTag(bundlePath: string): Promise<void> {
  const url = bundleUrl(bundlePath);
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => {
      script.parentNode?.removeChild(script);
      resolve();
    };
    script.onerror = () => {
      script.parentNode?.removeChild(script);
      reject(new Error(`Failed to load async bundle ${url}`));
    };
    document.head.appendChild(script);
  });
}

export function installMetroAsyncRequire(): void {
  // Browser only — React Native has no `document`.
  if (typeof document === "undefined") return;

  const host = globalThis as unknown as Record<string, AsyncBundleLoader | undefined>;
  const key = loaderGlobalKey();
  // Never fight an existing loader (e.g. if @expo/metro-runtime ever lands in
  // the graph): the first one installed owns the chunk cache.
  if (typeof host[key] === "function") return;

  const inFlight = new Map<string, Promise<void>>();

  host[key] = (bundlePath: string): Promise<void> => {
    const cached = inFlight.get(bundlePath);
    if (cached) return cached;
    // A failed load is not cached: the next dynamic import may succeed (the
    // chunk request can fail on a flaky network mid-session).
    const promise = loadChunkViaScriptTag(bundlePath).catch((error) => {
      inFlight.delete(bundlePath);
      throw error;
    });
    inFlight.set(bundlePath, promise);
    return promise;
  };
}
