import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SOURCE = join(ROOT, "assets", "icon.png");
const SPLASH_SOURCE = join(ROOT, "assets", "nuri-splash-screen.png");
const OUTPUT_ROOT = join(ROOT, "assets", "app-variants");

const variants = {
  production: {
    badge: null,
  },
  development: {
    badge: {
      label: "DEV",
      accent: [16, 185, 129, 255],
      text: [255, 255, 255, 255],
      border: [12, 148, 109, 255],
    },
  },
  preview: {
    badge: {
      label: "PRE",
      accent: [245, 158, 11, 255],
      text: [41, 37, 36, 255],
      border: [217, 119, 6, 255],
    },
  },
};

const GLYPHS = {
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
};

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function clonePng(image) {
  const clone = new PNG({ width: image.width, height: image.height });
  image.data.copy(clone.data);
  return clone;
}

function writePng(path, image) {
  ensureDir(dirname(path));
  writeFileSync(path, PNG.sync.write(image));
}

function blendPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;

  const [r, g, b, a] = color;
  const offset = (image.width * y + x) * 4;
  const alpha = a / 255;
  const inverse = 1 - alpha;

  image.data[offset] = Math.round(r * alpha + image.data[offset] * inverse);
  image.data[offset + 1] = Math.round(g * alpha + image.data[offset + 1] * inverse);
  image.data[offset + 2] = Math.round(b * alpha + image.data[offset + 2] * inverse);
  image.data[offset + 3] = 255;
}

function fillRect(image, left, top, width, height, color) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      blendPixel(image, x, y, color);
    }
  }
}

function fillCircle(image, cx, cy, radius, color) {
  const radiusSq = radius * radius;
  const left = Math.max(0, Math.floor(cx - radius));
  const right = Math.min(image.width - 1, Math.ceil(cx + radius));
  const top = Math.max(0, Math.floor(cy - radius));
  const bottom = Math.min(image.height - 1, Math.ceil(cy + radius));

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radiusSq) {
        blendPixel(image, x, y, color);
      }
    }
  }
}

function fillRoundedRect(image, left, top, width, height, radius, color) {
  const right = left + width;
  const bottom = top + height;
  const radiusSq = radius * radius;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const rx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
      const ry = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
      const dx = x - rx;
      const dy = y - ry;

      if (dx * dx + dy * dy <= radiusSq) {
        blendPixel(image, x, y, color);
      }
    }
  }
}

function drawGlyph(image, glyph, x, y, scale, color) {
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] !== "1") continue;
      fillRect(image, x + col * scale, y + row * scale, scale, scale, color);
    }
  }
}

function measureText(text, scale) {
  const glyphWidth = 5 * scale;
  const gap = scale;
  return text.length * glyphWidth + Math.max(0, text.length - 1) * gap;
}

function drawText(image, text, x, y, scale, color) {
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      cursor += 6 * scale;
      continue;
    }
    drawGlyph(image, glyph, cursor, y, scale, color);
    cursor += 6 * scale;
  }
}

function addIconBadge(image, badge) {
  const borderWidth = Math.round(image.width * 0.026);
  const badgeRadius = Math.round(image.width * 0.115);
  const badgeCx = image.width - Math.round(image.width * 0.155);
  const badgeCy = Math.round(image.height * 0.155);
  const shadowColor = [0, 0, 0, 90];
  const scale = Math.max(10, Math.round(image.width * 0.012));
  const textWidth = measureText(badge.label, scale);
  const textHeight = 7 * scale;

  fillRect(image, 0, 0, image.width, borderWidth, badge.border);
  fillRect(image, 0, image.height - borderWidth, image.width, borderWidth, badge.border);
  fillRect(image, 0, 0, borderWidth, image.height, badge.border);
  fillRect(image, image.width - borderWidth, 0, borderWidth, image.height, badge.border);

  fillCircle(
    image,
    badgeCx + Math.round(image.width * 0.01),
    badgeCy + Math.round(image.width * 0.01),
    badgeRadius,
    shadowColor,
  );
  fillCircle(image, badgeCx, badgeCy, badgeRadius, badge.accent);
  drawText(
    image,
    badge.label,
    Math.round(badgeCx - textWidth / 2),
    Math.round(badgeCy - textHeight / 2),
    scale,
    badge.text,
  );
}

function addSplashBadge(image, badge) {
  const pillWidth = Math.round(image.width * 0.28);
  const pillHeight = Math.round(image.height * 0.08);
  const pillLeft = Math.round((image.width - pillWidth) / 2);
  const pillTop = Math.round(image.height * 0.12);
  const radius = Math.round(pillHeight / 2);
  const shadowOffset = Math.round(image.width * 0.008);
  const shadowColor = [0, 0, 0, 48];
  const scale = Math.round(image.width * 0.012);
  const textWidth = measureText(badge.label, scale);
  const textHeight = 7 * scale;

  fillRoundedRect(
    image,
    pillLeft,
    pillTop + shadowOffset,
    pillWidth,
    pillHeight,
    radius,
    shadowColor,
  );
  fillRoundedRect(image, pillLeft, pillTop, pillWidth, pillHeight, radius, badge.accent);
  drawText(
    image,
    badge.label,
    Math.round((image.width - textWidth) / 2),
    Math.round(pillTop + (pillHeight - textHeight) / 2),
    scale,
    badge.text,
  );
}

function buildVariantAssets(variant, badge) {
  const icon = clonePng(readPng(ICON_SOURCE));
  const splash = clonePng(readPng(SPLASH_SOURCE));

  if (badge) {
    addIconBadge(icon, badge);
    addSplashBadge(splash, badge);
  }

  const variantDir = join(OUTPUT_ROOT, variant);
  writePng(join(variantDir, "icon.png"), icon);
  writePng(join(variantDir, "splash.png"), splash);
}

for (const [variant, config] of Object.entries(variants)) {
  buildVariantAssets(variant, config.badge);
}

console.log(`Generated app variant assets in ${OUTPUT_ROOT}`);
