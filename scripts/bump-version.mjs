#!/usr/bin/env node

// Bumps `appVersion` in app.config.ts. Defaults to a minor bump for regular
// releases (e.g. 0.83.0 → 0.84.0); pass --patch for hotfixes (0.83.0 → 0.83.1).
// Major bumps are intentionally not automated — they're rare enough to edit by
// hand, and a flag for them just invites accidents.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const isPatch = args.includes("--patch");
const isMinor = args.includes("--minor");
const asJson = args.includes("--json");

if (isPatch && isMinor) {
  console.error("Error: pass either --patch or --minor, not both.");
  process.exit(1);
}

const bumpKind = isPatch ? "patch" : "minor";

function log(message) {
  if (asJson) return;
  console.log(message);
}

function parseVersion(version) {
  const segments = version.split(".");
  if (segments.length !== 3) {
    throw new Error(`Invalid version "${version}": must be major.minor.patch (3 segments).`);
  }
  const numeric = segments.map((s) => Number.parseInt(s, 10));
  if (numeric.some((n) => Number.isNaN(n) || n < 0)) {
    throw new Error(`Invalid version "${version}": all segments must be non-negative integers.`);
  }
  const [major, minor, patch] = numeric;
  return { major, minor, patch };
}

function bumpVersion(currentVersion, kind) {
  const { major, minor, patch } = parseVersion(currentVersion);
  if (kind === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  // minor bump resets patch to 0, matching SemVer conventions
  return `${major}.${minor + 1}.0`;
}

function main() {
  const filePath = path.join(projectRoot, "app.config.ts");
  const source = fs.readFileSync(filePath, "utf8");

  const versionPattern = /const\s+appVersion\s*=\s*"([\d.]+)";/;
  const match = source.match(versionPattern);
  if (!match) {
    throw new Error(`Could not find appVersion in ${filePath}`);
  }

  const currentVersion = match[1];
  const nextVersion = bumpVersion(currentVersion, bumpKind);

  log(`appVersion (${bumpKind}): ${currentVersion} -> ${nextVersion}`);

  if (dryRun) {
    log("Dry run: no files changed.");
    if (asJson) {
      console.log(JSON.stringify({ kind: bumpKind, currentVersion, nextVersion, dryRun: true }));
    }
    return;
  }

  const updated = source.replace(versionPattern, `const appVersion = "${nextVersion}";`);
  fs.writeFileSync(filePath, updated);
  log(`Updated ${path.relative(projectRoot, filePath)}`);
  if (asJson) {
    console.log(JSON.stringify({ kind: bumpKind, currentVersion, nextVersion, dryRun: false }));
  }
}

main();
