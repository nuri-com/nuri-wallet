// Generates the PWA icon set for the web build from assets/icon.png.
// Pure JS (pngjs box-filter downscale) so it needs no native deps (no sharp).
// Output: public/icons/* + public/favicon-32.png, consumed by public/index.html
// and public/manifest.json. Re-run with: node scripts/generate-web-pwa-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "assets", "icon.png");
const ICONS_DIR = join(ROOT, "public", "icons");

// Box-filter downscale: average every source block into one destination pixel.
function downscale(src, size) {
  const out = new PNG({ width: size, height: size });
  const sx = src.width / size;
  const sy = src.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) << 2;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) << 2;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// Maskable icon: shrink the artwork into the ~80% safe zone on a solid
// background (sampled from the source corner) so OS masks never clip content.
function maskable(src, size) {
  const out = new PNG({ width: size, height: size });
  const bg = [src.data[0], src.data[1], src.data[2], 255];
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = bg[0];
    out.data[i + 1] = bg[1];
    out.data[i + 2] = bg[2];
    out.data[i + 3] = bg[3];
  }
  const inner = Math.round(size * 0.8);
  const offset = Math.round((size - inner) / 2);
  const art = downscale(src, inner);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const si = (y * inner + x) << 2;
      const a = art.data[si + 3] / 255;
      const di = ((y + offset) * size + (x + offset)) << 2;
      out.data[di] = Math.round(art.data[si] * a + out.data[di] * (1 - a));
      out.data[di + 1] = Math.round(art.data[si + 1] * a + out.data[di + 1] * (1 - a));
      out.data[di + 2] = Math.round(art.data[si + 2] * a + out.data[di + 2] * (1 - a));
      out.data[di + 3] = 255;
    }
  }
  return out;
}

const src = PNG.sync.read(readFileSync(SOURCE));
mkdirSync(ICONS_DIR, { recursive: true });

const write = (png, path) => writeFileSync(path, PNG.sync.write(png));

write(downscale(src, 192), join(ICONS_DIR, "icon-192.png"));
write(downscale(src, 512), join(ICONS_DIR, "icon-512.png"));
write(maskable(src, 512), join(ICONS_DIR, "icon-maskable-512.png"));
write(downscale(src, 180), join(ICONS_DIR, "apple-touch-icon.png"));
write(downscale(src, 32), join(ROOT, "public", "favicon-32.png"));

console.log("Generated PWA icons -> public/icons/ + public/favicon-32.png");
