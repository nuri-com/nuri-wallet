import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function assetResponse() {
  return new Response("asset", { status: 404, headers: { "content-type": "text/plain" } });
}

test("unknown non-API paths delegate to the static assets binding", async () => {
  let received;
  const response = await worker.fetch(new Request("https://app.nuri.com/pay/@alice"), {
    ASSETS: {
      fetch: (request) => {
        received = request;
        return assetResponse();
      },
    },
  });
  assert.equal(new URL(received.url).pathname, "/pay/@alice");
  assert.equal(response.status, 404);
});

// The SPA fallback answers every unmatched path with the same mutable
// index.html under a 200, so the shell must be identified by content type.
function shellResponse() {
  return new Response("<!doctype html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("mutable static entry points are never retained across deploys", async () => {
  const env = { ASSETS: { fetch: assetResponse } };
  for (const path of ["/deployment.json", "/nuri-service-worker.js"]) {
    const response = await worker.fetch(new Request(`https://app.nuri.com${path}`), env);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0", path);
  }

  const bundle = await worker.fetch(
    new Request("https://app.nuri.com/_expo/static/js/web/index-a1b2c3.js"),
    env,
  );
  assert.equal(bundle.headers.get("cache-control"), "public, immutable, max-age=31536000");
});

test("the HTML shell is no-store under every SPA fallback path, not just /", async () => {
  const env = { ASSETS: { fetch: shellResponse } };
  for (const path of ["/", "/index.html", "/pay/@alice", "/deep/link/anything"]) {
    const response = await worker.fetch(new Request(`https://app.nuri.com${path}`), env);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0", path);
  }
});

test("a missing /_expo/ asset falls back to HTML and is never marked immutable", async () => {
  const env = { ASSETS: { fetch: shellResponse } };
  const response = await worker.fetch(
    new Request("https://app.nuri.com/_expo/static/js/web/index-deadbeef.js"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
});

test("LNURL rejects an upstream response that is not JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<script>window.pwned=1</script>", {
      headers: { "content-type": "text/html" },
    });
  try {
    const response = await worker.fetch(
      new Request("https://app.nuri.com/api/lnurl?url=https%3A%2F%2Fexample.com%2Flnurl", {
        headers: { "cf-connecting-ip": "203.0.113.1" },
      }),
      {
        ASSETS: { fetch: assetResponse },
        LNURL_RATE_LIMIT: { limit: async () => ({ success: true }) },
      },
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { status: "ERROR", reason: "invalid JSON response" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
