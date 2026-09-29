#!/usr/bin/env node
// Project rule (AGENTS.md): production code must not dynamically import() app modules — the web
// single-file bundle can drop the target, and the failure surfaces only at runtime
// ("Requiring unknown module"), mid-swap. Detection is whole-file and formatting-independent:
// comments and string literals are stripped first, then `import` followed by `(` is matched even
// across newlines — so awaited, bare (Promise.all), returned, void, and line-wrapped forms are
// all caught.
//
// Documented exceptions (must carry the EXCEPTION comment in code):
//  - lib/secureKeyStorage.ts — expo-local-authentication is a native-optional module behind the
//    Android-only guard; a load-time throw IS the desired behavior on old binaries (OTA
//    constraint, commit 1533b4ed).
//  - services/arkade/internal/resumeLightningClaims.ts — the void import("./receiveAutoClaim")
//    edge breaks the receiveAutoClaim → resumeLightningClaims → receiveAutoClaim cycle (#875);
//    receiveAutoClaim is statically imported by ArkadeReceiveUnlockService and receiveAutoSweep,
//    so it is always in the bundle.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Every directory (and root file) that ships in the app bundle. Deliberately explicit: a new
// production dir must be added here, which the AGENTS.md rule calls out.
const SCAN_ROOTS = [
  "App.tsx",
  "cloudflare/src",
  "components",
  "config",
  "config-plugins",
  "ds",
  "lib",
  "native-modules",
  "screens",
  "services",
];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const TEST_PATTERN = /\.test\.[jt]sx?$|\.spec\.[jt]sx?$|__tests__|__mocks__/;

const ALLOWLIST = [
  { file: "lib/secureKeyStorage.ts", target: "expo-local-authentication" },
  { file: "services/arkade/internal/resumeLightningClaims.ts", target: "./receiveAutoClaim" },
];

/** Find executable import() call sites. TypeScript import types are distinct AST nodes. */
function findDynamicImports(source, fileName) {
  // Let TypeScript derive ScriptKind from the real extension. In particular,
  // parsing a .ts file as TSX turns `<T>(x: T) => import("./x")` into malformed
  // JSX and can hide the executable call from the AST visitor.
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = [];

  const visit = (node) => {
    // Runtime import() is a CallExpression whose callee is ImportKeyword.
    // Type-only `typeof import("./x")` / `keyof typeof import("./x")` is parsed
    // as ImportTypeNode instead, so it is erased and never reaches this branch.
    // This syntax distinction avoids punctuation heuristics: a ternary colon,
    // object-property colon, or comparison `<` cannot exempt executable code.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const at = node.expression.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(at);
      const original = source
        .split("\n")
        .slice(line, line + 3)
        .join(" ");
      hits.push({ line: line + 1, snippet: original.trim().slice(0, 160) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const violations = [];
for (const root of SCAN_ROOTS) {
  if (!fs.existsSync(root)) continue;
  const files = fs.statSync(root).isDirectory() ? [...walk(root)] : [root];
  for (const file of files) {
    if (!EXTENSIONS.has(path.extname(file))) continue;
    if (TEST_PATTERN.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const hit of findDynamicImports(source, file)) {
      const allowed = ALLOWLIST.some((a) => file === a.file && hit.snippet.includes(a.target));
      if (!allowed) violations.push(`${file}:${hit.line}: ${hit.snippet}`);
    }
  }
}

if (violations.length) {
  console.error(
    `Dynamic import() in production code is forbidden on the web bundle (AGENTS.md):\n${violations.join("\n")}`,
  );
  process.exit(1);
}

// Detector self-test: every executable form must be caught, comments/strings must not.
const positives = [
  'const m = await import("./x");',
  'const m = import("./x");',
  'return import("./x");',
  'void import("./x").then(() => {});',
  '  import("./x"),',
  'const m = await import ("./x");',
  'const m = import\n("./x");', // newline between import and paren (review finding)
  'const m = await import(\n  "./x",\n);',
  'const s = `${await import("./x")}`;', // executable interpolation inside a template literal
  'const s = `prefix ${import("./x").then((m) => m.x)} suffix`;',
  'const picked = condition ? a : typeof import("./money");', // ternary colon is runtime
  'const record = { kind: typeof import("./money") };', // object-property colon is runtime
  'const compared = value < typeof import("./money");', // comparison angle is runtime
  'const generic = <T>(x: T) => import("./money");', // valid .ts generic arrow, malformed JSX
];
const negatives = [
  '// const m = await import("./x");',
  '/* import("./x") */',
  'const s = "no import(\\"./x\\") here";',
  'const t = `template import("./x") text`;',
  'import { x } from "./x";',
  'obj.import("./x");',
  'reimport("./x");',
  "const meta = import.meta.url;",
  "type T = keyof typeof import('./tokens').size;", // TS type query — erased, no runtime require
  'const t = `literal text import("./x") with ${safe} interpolation`;', // import( as template TEXT
];
for (const code of positives) {
  if (findDynamicImports(code, "detector-selftest.ts").length === 0) {
    console.error(`detector missed positive fixture: ${JSON.stringify(code)}`);
    process.exit(1);
  }
}
for (const code of negatives) {
  if (findDynamicImports(code, "detector-selftest.ts").length !== 0) {
    console.error(`detector false-positive on fixture: ${JSON.stringify(code)}`);
    process.exit(1);
  }
}

// Guard the walker too: a fixture written into a scanned dir must be found end-to-end. This
// catches SCAN_ROOTS/extension regressions, not just regex ones.
const fixtureDir = path.join("services", "__dynimp_selftest__");
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureFile = path.join(fixtureDir, "fixture.tsx");
try {
  fs.writeFileSync(fixtureFile, 'export const p = import\n("./dropped-module");\n');
  const found = findDynamicImports(fs.readFileSync(fixtureFile, "utf8"), fixtureFile);
  const walked = [...walk("services")].includes(fixtureFile);
  if (found.length === 0 || !walked) {
    console.error("detector end-to-end self-test failed (walker or AST regression)");
    process.exit(1);
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log("no dynamic imports in production code (detector + walker self-tests passed)");
