#!/usr/bin/env node
// Checks received bytes against an independently trusted manifest. This does not
// authenticate the manifest or inspect backend code. Authenticate the release
// with its GitHub attestation (see README) and prove the build with `rebuild`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createWaictManifest, parseWaictPolicy, validateWaictManifest } from "./waict.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const DEFAULT_ORIGIN = "https://app.nuri.com";
const WAICT_HEADER = "integrity-policy-waict-v1";
const WAICT_CONTENT_TYPE = "application/waict-integrity-manifest";
// Written at deploy time, not by Expo: deployment metadata and the WAICT manifest.
const isDeployMetadata = (path) => path === "deployment.json" || path.startsWith("waict/");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function validateManifest(value) {
  if (
    value?.schema_version !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.source_sha ?? "") ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw new Error("Invalid or empty integrity manifest");
  }
  const paths = new Set();
  for (const file of value.files) {
    if (
      typeof file?.path !== "string" ||
      /[\\\p{Cc}]/u.test(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error("Invalid or duplicate integrity manifest entry");
    }
    paths.add(file.path);
  }
  return value;
}

export function createManifest(directory, sourceSha) {
  const files = [];
  function walk(prefix = "") {
    for (const entry of readdirSync(join(directory, prefix), {
      withFileTypes: true,
    })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(directory, path));
        files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
      } else throw new Error(`Not a regular file or directory: ${path}`);
    }
  }
  walk();
  return validateManifest({
    schema_version: 1,
    source_sha: sourceSha,
    files: files.sort(byPath),
  });
}

export function verifyLocal(directory, manifest) {
  validateManifest(manifest);
  const actual = createManifest(directory, manifest.source_sha);
  const expected = manifest.files
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort(byPath);
  if (JSON.stringify(actual.files) !== JSON.stringify(expected)) {
    throw new Error("Local files differ from manifest (missing, extra or changed files)");
  }
}

/**
 * The WAICT manifest named in deployment.json must be exactly what waict.mjs
 * computes from `directory`, so it lists the hash of every application file.
 * Returns the manifest path, or null for releases published before WAICT.
 */
export function verifyWaict(directory, deploymentDirectory, origin) {
  const deployment = JSON.parse(readFileSync(join(deploymentDirectory, "deployment.json"), "utf8"));
  if (!deployment.waict_manifest) return null;
  const expected = createWaictManifest(directory, origin);
  const recorded = readFileSync(join(deploymentDirectory, deployment.waict_manifest));
  validateWaictManifest(recorded.toString("utf8"), origin);
  if (
    deployment.waict_manifest !== expected.path ||
    !recorded.equals(Buffer.from(expected.body)) ||
    deployment.waict_manifest_sha256 !== expected.sha256
  ) {
    throw new Error("WAICT manifest does not match the application files");
  }
  return expected.path;
}

/**
 * The live homepage must send a valid WAICT policy (every mandatory key
 * present) naming the recorded manifest, and that manifest must be served
 * with the WAICT content type. A browser ignores anything less.
 */
export async function verifyWaictHeader(origin, manifestPath) {
  const response = await fetch(new URL("/", origin), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`HTTP ${response.status} for /`);
  const policy = parseWaictPolicy(response.headers.get(WAICT_HEADER));
  if (policy.manifest !== `/${manifestPath}`) {
    throw new Error(`Live ${WAICT_HEADER} names ${policy.manifest}, release has /${manifestPath}`);
  }
  const served = await fetch(new URL(`/${manifestPath}`, origin), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  await served.body?.cancel();
  const type = (served.headers.get("content-type") ?? "").split(";")[0].trim();
  if (served.status !== 200 || type !== WAICT_CONTENT_TYPE) {
    throw new Error(`/${manifestPath} is not served as ${WAICT_CONTENT_TYPE}`);
  }
}

export async function verifyUrl(origin, manifest) {
  validateManifest(manifest);
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error("Use an HTTPS origin without credentials, path, query or fragment");
  }
  // Cloudflare redirects /index.html to /. Check the actual HTML entrypoint.
  if (!manifest.files.some((file) => file.path === "index.html")) {
    throw new Error("Web manifest must include index.html");
  }
  const metadata = manifest.files.find((file) => file.path === "deployment.json");
  // Reject a deployment changing while its files are being checked.
  const files = metadata ? [metadata, ...manifest.files, metadata] : manifest.files;
  for (const file of files) {
    const paths = [
      file.path === "index.html" ? "" : file.path.split("/").map(encodeURIComponent).join("/"),
    ];
    for (const path of paths) {
      const url = new URL(base);
      url.pathname = `/${path}`;
      const response = await fetch(url, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200 || !response.body) {
        throw new Error(`HTTP ${response.status} for ${path || "/"}`);
      }
      let size = 0;
      const hash = createHash("sha256");
      // Hash decoded bytes without buffering an unbounded response in memory.
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > file.bytes) throw new Error(`Response too large: ${path || "/"}`);
        hash.update(chunk);
      }
      if (size !== file.bytes || hash.digest("hex") !== file.sha256) {
        throw new Error(`Hash or size mismatch: ${path || "/"}`);
      }
    }
  }
}

async function main() {
  const [command, input, target, sourceSha] = process.argv.slice(2);
  if (!command || ((command === "local" || command === "rebuild") && process.argv.length === 3)) {
    const root = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(root, "release.json"));
    const manifest = validateManifest(JSON.parse(raw));
    const origin = manifest.origin ?? DEFAULT_ORIGIN;
    const web = join(root, "web");
    verifyLocal(web, manifest);
    const waict = verifyWaict(web, web, origin);
    if (command === "rebuild") {
      // Deployment metadata and the WAICT manifest are written at deploy
      // time, not emitted by Expo. The WAICT manifest is then recomputed
      // from the rebuilt files, so it too is proven by the rebuild.
      const application = {
        ...manifest,
        files: manifest.files.filter((file) => !isDeployMetadata(file.path)),
      };
      const dist = join(root, "source/dist");
      verifyLocal(dist, application);
      if (waict) verifyWaict(dist, web, origin);
      console.log(
        `PASS: ${application.files.length} rebuilt application files match release ${manifest.source_sha}`,
      );
    } else {
      if (!command) {
        await verifyUrl(origin, manifest);
        if (waict) await verifyWaictHeader(origin, waict);
      }
      console.log(
        `PASS: ${manifest.files.length} ${command ? "local" : "live"} files match release ${manifest.source_sha}`,
      );
    }
    if (waict) console.log(`WAICT manifest: /${waict}`);
    console.log(`Release manifest SHA-256: ${digest(raw)}`);
    return;
  }
  if (command === "create" && input && target && sourceSha && process.argv.length === 6) {
    const output = relative(
      realpathSync(input),
      join(realpathSync(dirname(resolve(target))), basename(target)),
    );
    if (!isAbsolute(output) && output !== ".." && !output.startsWith(`..${sep}`)) {
      throw new Error("Write the manifest outside the asset directory");
    }
    writeFileSync(target, `${JSON.stringify(createManifest(input, sourceSha), null, 2)}\n`, {
      flag: "wx",
    });
  } else if (
    (command === "verify" || command === "verify-url") &&
    input &&
    target &&
    process.argv.length === 5
  ) {
    const manifest = validateManifest(JSON.parse(readFileSync(input, "utf8")));
    if (command === "verify") verifyLocal(target, manifest);
    else await verifyUrl(target, manifest);
    console.log(`Verified ${manifest.files.length} listed files for source ${manifest.source_sha}`);
  } else {
    throw new Error(
      "Usage: node verify.mjs [local|rebuild] | create <assets> <manifest> <source-sha> | verify <manifest> <assets> | verify-url <manifest> <https-origin>",
    );
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
