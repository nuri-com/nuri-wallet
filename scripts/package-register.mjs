import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const srcDir = path.join(projectRoot, "secure-passkey");
const outDir = path.join(projectRoot, "build-register");

const mustCopy = [
  "register.html",
  "nuri.svg",
  "icon-nuri.svg",
  "dark-short.png",
  "passkey.png",
  "nuri-background-v5.webp",
  "upscale-hand-v2.webp",
  "SharpGroteskBold25.woff",
  "SharpGroteskBold25.woff2",
  "Harriet-v2-Display-Thin.woff",
  "Harriet-v2-Display-Thin.woff2",
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

// Prepare output
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Copy main HTML and assets
for (const file of mustCopy) {
  const s = path.join(srcDir, file);
  if (fs.existsSync(s)) copyFile(s, path.join(outDir, file));
}

// Copy dist bundles (must run secure-passkey build before)
const distSrc = path.join(srcDir, "dist");
const distOut = path.join(outDir, "dist");
if (!fs.existsSync(distSrc)) {
  console.error("ERROR: secure-passkey/dist not found. Run: cd secure-passkey && npm run build");
  process.exit(1);
}
copyDir(distSrc, distOut);

console.log("Packaged register page to", outDir);
