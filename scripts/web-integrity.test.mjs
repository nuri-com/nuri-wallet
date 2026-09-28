import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createManifest, validateManifest, verifyLocal, verifyUrl } from "./web-integrity.mjs";

const source = "1".repeat(40);
const script = fileURLToPath(new URL("./web-integrity.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nuri-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, "assets");
  mkdirSync(join(assets, "_expo"), { recursive: true });
  for (const [name, content] of Object.entries({
    "index.html": '<script src="/_expo/main.js"></script>',
    "_expo/main.js": "console.log('main')",
    "_expo/chunk.js": "console.log('chunk')",
    "nuri-service-worker.js": "self.addEventListener('push', () => {})",
    "style.css": "body { color: black }",
    "empty.txt": "",
    "space?#.txt": "encoded filename",
  }))
    writeFileSync(join(assets, name), content);
  return { root, assets, manifest: createManifest(assets, source) };
}

test("manifest is stable and local verification requires the complete file set", (t) => {
  const { assets, manifest } = fixture(t);
  assert.equal(manifest.files.length, 7);
  assert.deepEqual(createManifest(assets, source), manifest);
  verifyLocal(assets, manifest);
  verifyLocal(assets, { ...manifest, files: [...manifest.files].reverse() });
  const chunk = join(assets, "_expo/chunk.js");
  const original = readFileSync(chunk);
  writeFileSync(chunk, "changed");
  assert.throws(() => verifyLocal(assets, manifest), /differ/);
  rmSync(chunk);
  assert.throws(() => verifyLocal(assets, manifest), /differ/);
  writeFileSync(chunk, original);
  writeFileSync(join(assets, "unexpected.js"), "extra");
  assert.throws(() => verifyLocal(assets, manifest), /differ/);
});

test("rejects invalid identities, hashes, sizes, duplicate paths and traversal", (t) => {
  const { manifest } = fixture(t);
  for (const path of ["", "/root", "../outside", "a/../b", "a//b", "a\\b", "a\nb", "."]) {
    assert.throws(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0], path }] }));
  }
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      validateManifest({ ...manifest, files: [{ ...manifest.files[0], bytes }] }),
    );
  }
  assert.throws(() => validateManifest({ ...manifest, source_sha: "not-a-commit" }));
  assert.throws(() => validateManifest({ ...manifest, files: [] }));
  assert.throws(() =>
    validateManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }),
  );
  assert.throws(() =>
    validateManifest({ ...manifest, files: [{ ...manifest.files[0], sha256: "bad" }] }),
  );
});

test("refuses symlinks instead of exporting files outside the asset tree", (t) => {
  const { root, assets } = fixture(t);
  writeFileSync(join(root, "outside"), "must not be included");
  symlinkSync(join(root, "outside"), join(assets, "link"));
  assert.throws(() => createManifest(assets, source), /Not a regular file/);
});

test("URL verification checks every listed file and the actual homepage", async (t) => {
  const { assets, manifest } = fixture(t);
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://wallet.example");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    requested.push(url.pathname);
    const path = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    return new Response(readFileSync(join(assets, path)));
  });
  await verifyUrl("https://wallet.example", manifest);
  assert.equal(requested.length, manifest.files.length + 1);
  assert.ok(requested.includes("/"));
  assert.ok(requested.includes("/_expo/chunk.js"));
  assert.ok(requested.includes("/nuri-service-worker.js"));
  assert.ok(requested.includes("/space%3F%23.txt"));
});

test("URL verification fails on altered bytes, HTTP errors, oversize responses and redirects", async (t) => {
  const { manifest } = fixture(t);
  for (const response of [
    new Response("", { status: 404 }),
    new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }),
    new Response("x".repeat(1_000)),
    new Response("wrong"),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(verifyUrl("https://wallet.example", manifest));
    mock.mock.restore();
  }
});

test("a matching index.html does not excuse a changed homepage", async (t) => {
  const { assets, manifest } = fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.pathname === "/") return new Response("different homepage");
    return new Response(readFileSync(join(assets, decodeURIComponent(url.pathname.slice(1)))));
  });
  await assert.rejects(verifyUrl("https://wallet.example", manifest), /mismatch: \/$/);
});

test("rejects unsafe origins and incomplete web manifests before contacting a server", async (t) => {
  const { manifest } = fixture(t);
  const mock = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  for (const origin of [
    "http://wallet.example",
    "https://user:password@wallet.example",
    "https://wallet.example/path",
    "https://wallet.example/?x=1",
    "https://wallet.example/#x",
  ]) {
    await assert.rejects(verifyUrl(origin, manifest));
  }
  await assert.rejects(
    verifyUrl("https://wallet.example", {
      ...manifest,
      files: manifest.files.filter((file) => file.path !== "index.html"),
    }),
  );
  assert.equal(mock.mock.callCount(), 0);
});

test("CLI creates an external manifest, verifies locally, and refuses overwrites/self-reference", (t) => {
  const { root, assets } = fixture(t);
  const output = join(root, "integrity.json");
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });
  run("create", assets, output, source);
  assert.match(run("verify", output, assets), /Verified 7 listed files/);
  assert.throws(() => run("create", assets, output, source));
  assert.throws(() => run("create", assets, join(assets, "integrity.json"), source));
  symlinkSync(assets, join(root, "alias"), "dir");
  assert.throws(() => run("create", assets, join(root, "alias/integrity.json"), source));
});
