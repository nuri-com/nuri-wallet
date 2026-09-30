#!/usr/bin/env node
// Builds and validates the WAICT integrity manifest and policy header for a
// PWA asset directory. The deploy workflow and the Cloudflare worker use it,
// and the same file ships in nuri-wallet so the published checker recomputes
// and validates the manifest with identical code.
//
// Format: draft-waict-integrity-v2, the tagged draft that Firefox Nightly's
// prototype implements:
// https://github.com/waict-wg/waict-integrity-spec/blob/draft-waict-integrity-v2/waict-integrity.md
//
// The manifest lists the SHA-256 of every file the site serves, so a browser
// that enforces WAICT refuses to run anything that is not in it. It is written
// to an immutable, hash-named URL. Its bytes depend only on the asset files and
// the origin, so anyone holding the release files can rebuild it byte for byte.
//
// Excluded: deployment.json (it references this manifest, so it cannot be in
// it) and earlier manifests under waict/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WAICT_DIR = "waict";
export const WAICT_HEADER = "Integrity-Policy-WAICT-v1";
export const WAICT_CONTENT_TYPE = "application/waict-integrity-manifest";
const EXCLUDED = new Set(["deployment.json"]);
const HASH = /^[A-Za-z0-9_-]{43}$/; // base64url, no padding, 32 bytes
const MANIFEST_PATH = /^\/waict\/[A-Za-z0-9_-]{22}$/;

const b64url = (bytes) => createHash("sha256").update(bytes).digest("base64url");

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(directory, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Not a regular file or directory: ${path}`);
  }
  return files;
}

function bareOrigin(origin) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("origin must be a bare https origin");
  }
  return base;
}

/**
 * The policy header for a manifest path. Report mode with max-age=0: failures
 * are only reported, never blocked, and no transparency proof is required.
 * Returns null for anything that is not a hash-named manifest path.
 */
export function waictPolicy(manifestPath) {
  if (!MANIFEST_PATH.test(manifestPath || "")) return null;
  return `max-age=0, mode=report, manifest="${manifestPath}"`;
}

/**
 * Parses a policy header value. Throws unless every mandatory key is present
 * and valid (max-age, mode, manifest); a browser ignores such a header.
 */
export function parseWaictPolicy(value) {
  if (!value) throw new Error(`${WAICT_HEADER}: header missing or invalid`);
  const fields = {};
  for (const part of String(value).split(",")) {
    const match = part.trim().match(/^([a-z][a-z0-9_.*-]*)(?:=(.*))?$/);
    if (!match) throw new Error(`Malformed ${WAICT_HEADER} member: ${part.trim()}`);
    fields[match[1]] = match[2] ?? "?1";
  }
  const maxAge = fields["max-age"];
  const mode = fields.mode;
  const manifest = fields.manifest?.match(/^"([^"\\]*)"$/)?.[1];
  if (!/^\d+$/.test(maxAge ?? "")) throw new Error(`${WAICT_HEADER}: max-age missing or invalid`);
  if (mode !== "enforce" && mode !== "report") {
    throw new Error(`${WAICT_HEADER}: mode missing or invalid`);
  }
  if (!manifest) throw new Error(`${WAICT_HEADER}: manifest missing or invalid`);
  return { maxAge: Number(maxAge), mode, manifest };
}

/**
 * Validates a manifest response body: `manifest JSON` LF `transparency proof`
 * LF, with every mandatory field present. Throws on anything a browser would
 * reject or mark invalid. Returns the parsed manifest.
 */
export function validateWaictManifest(body, origin) {
  const base = bareOrigin(origin);
  const lines = String(body).split("\n");
  if (lines.length !== 3 || lines[2] !== "") {
    throw new Error("WAICT manifest must be: manifest JSON, newline, proof, newline");
  }
  let manifest;
  try {
    manifest = JSON.parse(lines[0]);
  } catch {
    throw new Error("WAICT manifest is not valid JSON");
  }
  const { hashes, fallback_hashes: fallback } = manifest ?? {};
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw new Error("WAICT manifest is missing the mandatory hashes field");
  }
  const entries = Object.entries(hashes);
  if (entries.length === 0) throw new Error("WAICT manifest hashes is empty");
  for (const [url, hash] of entries) {
    if (typeof hash !== "string" || !HASH.test(hash)) {
      throw new Error(`WAICT manifest has an invalid hash for ${url}`);
    }
    const canonical = new URL(url, base);
    canonical.hash = "";
    if (canonical.href !== url) throw new Error(`WAICT manifest URL is not canonical: ${url}`);
  }
  if (fallback !== undefined) {
    const sorted = [...new Set(fallback)].sort();
    if (
      !Array.isArray(fallback) ||
      !fallback.every((h) => typeof h === "string" && HASH.test(h)) ||
      JSON.stringify(sorted) !== JSON.stringify(fallback)
    ) {
      throw new Error("WAICT manifest fallback_hashes must be sorted, unique hashes");
    }
  }
  return manifest;
}

/** Deterministic manifest body for the files in `directory`, served from `origin`. */
export function createWaictManifest(directory, origin) {
  const base = bareOrigin(origin);
  const hashes = {};
  let indexHash;
  for (const path of listFiles(directory).sort()) {
    if (EXCLUDED.has(path) || path.startsWith(`${WAICT_DIR}/`)) continue;
    if (/[?#%\\\s]/.test(path)) throw new Error(`Unsupported character in asset path: ${path}`);
    const hash = b64url(readFileSync(join(directory, path)));
    // Keys must be canonical URLs: absolute and serialized exactly as the browser's URL parser does.
    hashes[new URL(`/${path}`, base).href] = hash;
    if (path === "index.html") {
      indexHash = hash;
      hashes[base.href] = hash; // "/" serves index.html
    }
  }
  if (!indexHash) throw new Error("asset directory has no index.html");
  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
  // Every SPA deep link answers with index.html, so it is the only allowed fallback document.
  const manifest = { hashes: sorted, fallback_hashes: [indexHash] };
  // The proof line stays empty until a WAICT transparency log exists; the
  // draft allows that only with max-age=0, which is what waictPolicy() sends.
  const body = `${JSON.stringify(manifest)}\n\n`;
  validateWaictManifest(body, origin);
  return {
    body,
    path: `${WAICT_DIR}/${b64url(body).slice(0, 22)}`,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

/** Writes the manifest into `directory` and returns its path and hash. */
export function writeWaictManifest(directory, origin) {
  const result = createWaictManifest(directory, origin);
  mkdirSync(join(directory, WAICT_DIR), { recursive: true });
  writeFileSync(join(directory, result.path), result.body);
  return { path: result.path, sha256: result.sha256 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directory, origin] = process.argv.slice(2);
  if (!directory || !origin) {
    console.error("Usage: node public-release/waict.mjs <assets-dir> <https-origin>");
    process.exit(1);
  }
  const { path, sha256 } = writeWaictManifest(directory, origin);
  process.stdout.write(`waict_manifest=${path}\nwaict_manifest_sha256=${sha256}\n`);
}
