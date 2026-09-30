import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createManifest,
  validateManifest,
  verifyLocal,
  verifyUrl,
  verifyWaict,
  verifyWaictHeader,
} from "./verify.mjs";
import { createWaictManifest, validateWaictManifest, writeWaictManifest } from "./waict.mjs";

const source = "1".repeat(40);
const script = fileURLToPath(new URL("./verify.mjs", import.meta.url));

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

test("the cosigner guard checks the nested web source instead of an empty repository root", (t) => {
  const { root } = fixture(t);
  const sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
  const guard = join(sourceRoot, "scripts/check-no-legacy-cosigner.sh");
  const shipped = fileURLToPath(
    new URL("./source/scripts/check-no-legacy-cosigner.sh", import.meta.url),
  );
  if (!existsSync(shipped)) return t.skip("runs in the published repository, where source/ exists");
  cpSync(shipped, guard);
  writeFileSync(join(sourceRoot, "App.tsx"), 'const endpoint = "https://arkade.nuri.com";');
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "source/App.tsx"]);
  assert.match(
    execFileSync("bash", [guard], { encoding: "utf8", stdio: "pipe" }),
    /boundary clean/,
  );
  writeFileSync(join(sourceRoot, "App.tsx"), 'const endpoint = "https://sign.nuri.com";');
  assert.throws(() => execFileSync("bash", [guard], { stdio: "pipe" }));
});

test("a deployment changing during the check fails verification", async (t) => {
  const { assets } = fixture(t);
  writeFileSync(join(assets, "deployment.json"), '{"release_id":"test"}\n');
  const manifest = createManifest(assets, source);
  let metadataRequests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (path === "deployment.json" && ++metadataRequests === 3) return new Response("changed");
    return new Response(readFileSync(join(assets, path)));
  });
  await assert.rejects(verifyUrl("https://wallet.example", manifest), /mismatch: deployment.json/);
  assert.equal(metadataRequests, 3);
});

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
    assert.throws(() =>
      validateManifest({
        ...manifest,
        files: [{ ...manifest.files[0], path }],
      }),
    );
  }
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      validateManifest({
        ...manifest,
        files: [{ ...manifest.files[0], bytes }],
      }),
    );
  }
  assert.throws(() => validateManifest({ ...manifest, source_sha: "not-a-commit" }));
  assert.throws(() => validateManifest({ ...manifest, files: [] }));
  assert.throws(() =>
    validateManifest({
      ...manifest,
      files: [manifest.files[0], manifest.files[0]],
    }),
  );
  assert.throws(() =>
    validateManifest({
      ...manifest,
      files: [{ ...manifest.files[0], sha256: "bad" }],
    }),
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
  assert.equal(requested.length, manifest.files.length);
  assert.ok(!requested.includes("/index.html"));
  assert.ok(requested.includes("/"));
  assert.ok(requested.includes("/_expo/chunk.js"));
  assert.ok(requested.includes("/nuri-service-worker.js"));
  assert.ok(requested.includes("/space%3F%23.txt"));
});

test("URL verification fails on altered bytes, HTTP errors, oversize responses and redirects", async (t) => {
  const { manifest } = fixture(t);
  for (const response of [
    new Response("", { status: 404 }),
    new Response("", {
      status: 302,
      headers: { location: "https://elsewhere.example" },
    }),
    new Response("x".repeat(1_000)),
    new Response("wrong"),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(verifyUrl("https://wallet.example", manifest));
    mock.mock.restore();
  }
});

test("verification detects a changed homepage without relying on the index.html redirect", async (t) => {
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

test("local and rebuild commands verify the snapshot and distinguish deployment metadata", (t) => {
  const { root, assets } = fixture(t);
  writeFileSync(join(assets, "deployment.json"), '{"release_id":"test"}\n');
  const manifest = createManifest(assets, source);
  cpSync(assets, join(root, "web"), { recursive: true });
  cpSync(assets, join(root, "source/dist"), { recursive: true });
  rmSync(join(root, "source/dist/deployment.json"));
  writeFileSync(join(root, "release.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "verify.mjs"), readFileSync(script));
  writeFileSync(join(root, "waict.mjs"), readFileSync(new URL("./waict.mjs", import.meta.url)));
  const run = (command) =>
    execFileSync(process.execPath, [join(root, "verify.mjs"), command], {
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run("local"), /PASS: 8 local files/);
  assert.match(run("rebuild"), /PASS: 7 rebuilt application files/);
  writeFileSync(join(root, "source/dist/_expo/chunk.js"), "changed");
  assert.throws(() => run("rebuild"));
  rmSync(join(root, "web/deployment.json"));
  assert.throws(() => run("local"));
});

test("CLI creates an external manifest, verifies locally, and refuses overwrites/self-reference", (t) => {
  const { root, assets } = fixture(t);
  const output = join(root, "integrity.json");
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
  run("create", assets, output, source);
  assert.match(run("verify", output, assets), /Verified 7 listed files/);
  assert.throws(() => run("create", assets, output, source));
  assert.throws(() => run("create", assets, join(assets, "integrity.json"), source));
  symlinkSync(assets, join(root, "alias"), "dir");
  assert.throws(() => run("create", assets, join(root, "alias/integrity.json"), source));
});

const origin = "https://wallet.example";

// A deployed release: application files + WAICT manifest + deployment.json naming it.
function waictFixture(t) {
  const f = fixture(t);
  rmSync(join(f.assets, "space?#.txt"));
  return f;
}

function deployed(t) {
  const f = waictFixture(t);
  const waict = writeWaictManifest(f.assets, `${origin}/`);
  writeFileSync(
    join(f.assets, "deployment.json"),
    JSON.stringify({ waict_manifest: waict.path, waict_manifest_sha256: waict.sha256 }),
  );
  return { ...f, waict, manifest: createManifest(f.assets, source) };
}

test("WAICT manifest lists every application file under canonical URLs and is deterministic", (t) => {
  const { assets } = waictFixture(t);
  const first = createWaictManifest(assets, origin);
  assert.deepEqual(createWaictManifest(assets, `${origin}/`), first);
  assert.match(first.path, /^waict\/[A-Za-z0-9_-]{22}$/);
  assert.ok(first.body.endsWith("\n\n"));
  const body = validateWaictManifest(first.body, origin);
  assert.deepEqual(Object.keys(body.hashes), [
    `${origin}/`,
    `${origin}/_expo/chunk.js`,
    `${origin}/_expo/main.js`,
    `${origin}/empty.txt`,
    `${origin}/index.html`,
    `${origin}/nuri-service-worker.js`,
    `${origin}/style.css`,
  ]);
  assert.deepEqual(body.fallback_hashes, [body.hashes[`${origin}/`]]);
  for (const hash of Object.values(body.hashes)) {
    assert.equal(Buffer.from(hash, "base64url").length, 32);
  }
  // deployment.json and earlier manifests are not application files.
  writeWaictManifest(assets, origin);
  writeFileSync(join(assets, "deployment.json"), "{}");
  assert.equal(createWaictManifest(assets, origin).body, first.body);
  writeFileSync(join(assets, "_expo/chunk.js"), "changed");
  assert.notEqual(createWaictManifest(assets, origin).path, first.path);
  writeFileSync(join(assets, "bad?name.js"), "x");
  assert.throws(() => createWaictManifest(assets, origin), /Unsupported character/);
});

test("verifyWaict accepts the recorded manifest and rejects any drift", (t) => {
  const { assets, waict } = deployed(t);
  assert.equal(verifyWaict(assets, assets, origin), waict.path);
  writeFileSync(join(assets, waict.path), "{}\n\n");
  assert.throws(() => verifyWaict(assets, assets, origin), /mandatory hashes/);
  writeWaictManifest(assets, origin);
  writeFileSync(join(assets, "_expo/chunk.js"), "changed");
  assert.throws(() => verifyWaict(assets, assets, origin), /WAICT manifest does not match/);
});

test("releases published before WAICT still verify", (t) => {
  const { assets } = waictFixture(t);
  writeFileSync(join(assets, "deployment.json"), "{}");
  assert.equal(verifyWaict(assets, assets, origin), null);
});

test("WAICT manifests missing mandatory fields or malformed are rejected", () => {
  const good = { hashes: { [`${origin}/`]: "A".repeat(43) } };
  const body = (manifest, proof = "") => `${JSON.stringify(manifest)}\n${proof}\n`;
  assert.ok(validateWaictManifest(body(good), origin));
  for (const [bad, why] of [
    [body({ url_hashes: good.hashes }), /mandatory hashes/],
    [body({}), /mandatory hashes/],
    [body({ hashes: {} }), /empty/],
    [body({ hashes: { [`${origin}/`]: "short" } }), /invalid hash/],
    [body({ hashes: { "/relative": "A".repeat(43) } }), /not canonical/],
    [body({ ...good, fallback_hashes: ["B".repeat(43), "A".repeat(43)] }), /sorted/],
    [`${JSON.stringify(good)}\n`, /newline/],
    ["not json\n\n", /not valid JSON/],
  ]) {
    assert.throws(() => validateWaictManifest(bad, origin), why);
  }
});

test("a recorded manifest in the old field layout is rejected", (t) => {
  const { assets, waict } = deployed(t);
  const manifest = JSON.parse(readFileSync(join(assets, waict.path), "utf8").split("\n")[0]);
  const old = `${JSON.stringify({ url_hashes: manifest.hashes })}\n\n`;
  writeFileSync(join(assets, waict.path), old);
  assert.throws(() => verifyWaict(assets, assets, origin), /mandatory hashes/);
});

test("the live site must send a valid WAICT policy and serve its manifest", async (t) => {
  const { waict } = deployed(t);
  const serve = (header, type = "application/waict-integrity-manifest") =>
    t.mock.method(globalThis, "fetch", async (url) =>
      url.pathname === "/"
        ? new Response("<html>", {
            headers: header ? { "integrity-policy-waict-v1": header } : {},
          })
        : new Response("{}", { headers: { "content-type": type } }),
    );
  let mock = serve(`max-age=0, mode=report, manifest="/${waict.path}"`);
  await verifyWaictHeader(origin, waict.path);
  mock.mock.restore();
  for (const [header, type, why] of [
    [null, undefined, /missing or invalid/],
    [`max-age=0, mode-script=report, manifest="/${waict.path}"`, undefined, /mode missing/],
    [`mode=report, manifest="/${waict.path}"`, undefined, /max-age missing/],
    [`max-age=0, mode=report, manifest="/waict/other"`, undefined, /names/],
    [`max-age=0, mode=report, manifest="/${waict.path}"`, "application/json", /is not served as/],
  ]) {
    mock = serve(header, type);
    await assert.rejects(verifyWaictHeader(origin, waict.path), why, String(header));
    mock.mock.restore();
  }
});

test("rebuild recomputes the WAICT manifest from the rebuilt files", (t) => {
  const { root, assets, manifest } = deployed(t);
  cpSync(assets, join(root, "web"), { recursive: true });
  cpSync(assets, join(root, "source/dist"), { recursive: true });
  rmSync(join(root, "source/dist/deployment.json"));
  rmSync(join(root, "source/dist/waict"), { recursive: true });
  writeFileSync(join(root, "release.json"), JSON.stringify({ ...manifest, origin }));
  for (const file of ["verify.mjs", "waict.mjs"]) {
    writeFileSync(
      join(root, file),
      readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url))),
    );
  }
  const run = (command) =>
    execFileSync(process.execPath, [join(root, "verify.mjs"), command], {
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run("local"), /WAICT manifest: \/waict\//);
  assert.match(run("rebuild"), /PASS: 6 rebuilt application files/);
  writeFileSync(join(root, "source/dist/_expo/chunk.js"), "changed");
  assert.throws(() => run("rebuild"));
});
