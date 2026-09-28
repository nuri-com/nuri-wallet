import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * These tests drive the loader exactly the way Metro's compiled async-require
 * helper does (see the web bundle):
 *
 *   const loader = global[`${__METRO_GLOBAL_PREFIX__}__loadBundleAsync`];
 *   if (loader != null) { const p = paths[String(moduleId)]; if (p != null) return loader(p); }
 *   // …otherwise fall straight through to a synchronous require of moduleId
 *
 * So the contract under test is: the global exists under the prefixed name, it
 * resolves only after the chunk has executed, and it loads the chunk by
 * appending a `<script src>` (the one form the page CSP `script-src 'self'`
 * allows — there is no `unsafe-eval`).
 */

type FakeScript = {
  src: string;
  async?: boolean;
  type?: string;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
  parentNode: { removeChild: (script: FakeScript) => void } | null;
};

type FakeDocument = {
  appended: FakeScript[];
  removed: FakeScript[];
  createElement: (tag: string) => FakeScript;
  head: { appendChild: (script: FakeScript) => void };
};

function fakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    appended: [],
    removed: [],
    createElement: (tag: string) => {
      if (tag !== "script") throw new Error(`unexpected element ${tag}`);
      return { src: "", onload: null, onerror: null, parentNode: null };
    },
    head: {
      appendChild: (script: FakeScript) => {
        script.parentNode = { removeChild: (s) => doc.removed.push(s) };
        doc.appended.push(script);
      },
    },
  };
  return doc;
}

const host = globalThis as unknown as Record<string, unknown>;

/** Remove a global outright; assigning `undefined` would leave the key present. */
function clearGlobal(key: string): void {
  Reflect.deleteProperty(host, key);
}

/** Metro's helper, as compiled into the web bundle. */
function metroAsyncRequire(
  moduleId: number,
  paths: Record<string, string>,
  requireSync: (id: number) => unknown,
): Promise<unknown> {
  const prefix = (host.__METRO_GLOBAL_PREFIX__ as string | undefined) ?? "";
  const loader = host[`${prefix}__loadBundleAsync`] as
    | ((path: string) => Promise<void>)
    | undefined;
  const path = paths[String(moduleId)];
  const chunk = loader != null && path != null ? loader(path) : undefined;
  const importAll = () => requireSync(moduleId);
  // Metro's helper calls importAll() directly when there is no chunk to fetch,
  // so a missing module throws synchronously at the import site.
  return chunk != null ? chunk.then(importAll) : (importAll() as Promise<unknown>);
}

async function installFresh(): Promise<void> {
  const { installMetroAsyncRequire } = await import("./metroAsyncRequire");
  installMetroAsyncRequire();
}

const LOADER_KEY = "__loadBundleAsync";

describe("installMetroAsyncRequire", () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = fakeDocument();
    host.document = doc;
    host.__METRO_GLOBAL_PREFIX__ = "";
    clearGlobal(LOADER_KEY);
  });

  afterEach(() => {
    clearGlobal("document");
    clearGlobal("__METRO_GLOBAL_PREFIX__");
    clearGlobal(LOADER_KEY);
  });

  it("installs the loader Metro looks for under the global prefix", async () => {
    await installFresh();
    expect(typeof host[LOADER_KEY]).toBe("function");
  });

  it("honours a non-empty Metro global prefix", async () => {
    host.__METRO_GLOBAL_PREFIX__ = "__nuri";
    await installFresh();
    expect(typeof host.__nuri__loadBundleAsync).toBe("function");
    expect(host[LOADER_KEY]).toBeUndefined();
    clearGlobal("__nuri__loadBundleAsync");
  });

  it("is a no-op without a document (native): the dynamic import is unchanged", async () => {
    clearGlobal("document");
    await installFresh();
    expect(host[LOADER_KEY]).toBeUndefined();
  });

  it("does not replace a loader that is already installed", async () => {
    const existing = () => Promise.resolve();
    host[LOADER_KEY] = existing;
    await installFresh();
    expect(host[LOADER_KEY]).toBe(existing);
  });

  /**
   * The regression: this is the failure seen on the deployed PWA. Without the
   * loader, Metro's helper requires a module that only exists inside a chunk it
   * never fetched.
   */
  it("without the loader, a dependency's dynamic import requires a module from an unfetched chunk", async () => {
    const paths = { "3493": "/_expo/static/js/web/fetch-5872398.js" };
    const requireSync = (id: number) => {
      throw new Error(`Requiring unknown module "${id}".`);
    };

    await expect(() => metroAsyncRequire(3493, paths, requireSync)).toThrow(
      'Requiring unknown module "3493".',
    );
    expect(doc.appended).toHaveLength(0);
  });

  it("with the loader, the chunk is fetched and executed before the module is required", async () => {
    await installFresh();

    const paths = { "3493": "/_expo/static/js/web/fetch-5872398.js" };
    const registry = new Map<number, unknown>();
    const requireSync = (id: number) => {
      const found = registry.get(id);
      if (!found) throw new Error(`Requiring unknown module "${id}".`);
      return found;
    };

    const pending = metroAsyncRequire(3493, paths, requireSync);

    expect(doc.appended).toHaveLength(1);
    const script = doc.appended[0];
    expect(script.src).toBe("/_expo/static/js/web/fetch-5872398.js");
    // Executing the chunk is what registers its modules.
    registry.set(3493, { fetch: (): void => undefined });
    script.onload?.();

    await expect(pending).resolves.toEqual({ fetch: expect.any(Function) });
  });

  it("loads a chunk over the network, not through eval (CSP has no unsafe-eval)", async () => {
    await installFresh();
    const loader = host[LOADER_KEY] as (p: string) => Promise<void>;

    void loader("/_expo/static/js/web/fetch-5872398.js");

    expect(doc.appended).toHaveLength(1);
    expect(doc.appended[0].src).toBe("/_expo/static/js/web/fetch-5872398.js");
    expect(doc.appended[0].async).toBe(true);
  });

  it("makes a chunk path absolute so a nested route cannot 404 it", async () => {
    await installFresh();
    const loader = host[LOADER_KEY] as (p: string) => Promise<void>;

    void loader("_expo/static/js/web/fetch-5872398.js");

    expect(doc.appended[0].src).toBe("/_expo/static/js/web/fetch-5872398.js");
  });

  it("passes an absolute URL through untouched", async () => {
    await installFresh();
    const loader = host[LOADER_KEY] as (p: string) => Promise<void>;

    void loader("https://cdn.example/_expo/static/js/web/fetch-5872398.js");

    expect(doc.appended[0].src).toBe("https://cdn.example/_expo/static/js/web/fetch-5872398.js");
  });

  it("fetches a chunk once for repeated imports and drops the script tag after load", async () => {
    await installFresh();
    const loader = host[LOADER_KEY] as (p: string) => Promise<void>;

    const first = loader("/_expo/static/js/web/fetch-5872398.js");
    const second = loader("/_expo/static/js/web/fetch-5872398.js");
    expect(doc.appended).toHaveLength(1);

    doc.appended[0].onload?.();
    await Promise.all([first, second]);
    expect(doc.removed).toHaveLength(1);

    await loader("/_expo/static/js/web/fetch-5872398.js");
    expect(doc.appended).toHaveLength(1);
  });

  it("retries after a failed chunk load instead of caching the failure", async () => {
    await installFresh();
    const loader = host[LOADER_KEY] as (p: string) => Promise<void>;

    const failing = loader("/_expo/static/js/web/fetch-5872398.js");
    doc.appended[0].onerror?.();
    await expect(failing).rejects.toThrow(
      "Failed to load async bundle /_expo/static/js/web/fetch-5872398.js",
    );
    expect(doc.removed).toHaveLength(1);

    const retry = loader("/_expo/static/js/web/fetch-5872398.js");
    expect(doc.appended).toHaveLength(2);
    doc.appended[1].onload?.();
    await expect(retry).resolves.toBeUndefined();
  });
});
