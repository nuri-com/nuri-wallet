#!/usr/bin/env node
// Checks received bytes against an independently trusted manifest. This does not
// authenticate the manifest, prove a reproducible build, or inspect backend code.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(directory, path));
        files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
      } else throw new Error(`Not a regular file or directory: ${path}`);
    }
  }
  walk();
  return validateManifest({ schema_version: 1, source_sha: sourceSha, files: files.sort(byPath) });
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
  // Verify the actual homepage as well as /index.html; a Worker can serve them differently.
  if (!manifest.files.some((file) => file.path === "index.html")) {
    throw new Error("Web manifest must include index.html");
  }
  for (const file of manifest.files) {
    const paths = [file.path.split("/").map(encodeURIComponent).join("/")];
    if (file.path === "index.html") paths.push("");
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
      "Usage: web-integrity.mjs create <assets> <manifest> <source-sha> | verify <manifest> <assets> | verify-url <trusted-manifest> <https-origin>",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
