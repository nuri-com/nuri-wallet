// Contact avatars: the contact's name drawn as a wordpet (lib/vendor/wordpet).
// The same name gives the same pet on every device, with nothing stored or
// synced. Rendered to a crisp, nearest-neighbour upscaled indexed PNG here
// (no image library in the app); a data URI any <Image> can show.
// A real profile picture (Nuri users, once the directory serves one) replaces it.
import { renderFull, traitsFor, W, H } from "../vendor/wordpet/wordpet5";

/** Where a hole in the scene would show: the DS lilac soft surface. */
const EMPTY = "#ebe3ff";

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream of stored (uncompressed) deflate blocks: tiny images, no deps. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** An 8-bit indexed PNG of a colour grid, each pixel scaled to scale×scale. */
export function encodePixelPng(
  pixels: Array<string | null>,
  width: number,
  height: number,
  scale: number,
): Uint8Array {
  const palette: string[] = [];
  const index = new Map<string, number>();
  const idx = pixels.map((c) => {
    const colour = (c ?? EMPTY).toLowerCase();
    let i = index.get(colour);
    if (i === undefined) {
      i = palette.length;
      if (i > 255) throw new Error("more than 256 colours");
      palette.push(colour);
      index.set(colour, i);
    }
    return i;
  });
  const w = width * scale;
  const h = height * scale;
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const row = y * (w + 1);
    raw[row] = 0; // filter: none
    const src = Math.floor(y / scale) * width;
    for (let x = 0; x < w; x++) raw[row + 1 + x] = idx[src + Math.floor(x / scale)];
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((hex, i) => {
    const n = Number.parseInt(hex.slice(1), 16);
    plte[i * 3] = n >>> 16;
    plte[i * 3 + 1] = (n >>> 8) & 0xff;
    plte[i * 3 + 2] = n & 0xff;
  });
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[n >>> 18] + B64[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Pixel scale per use: 48pt list rows and the 96pt contact page, sharp at @3x. */
const SCALE = { list: 2, hero: 4 } as const;
// Recently drawn pets, least recently used first. Bounded: a list row's pet is
// ~28 KB of base64, so a whole 2,000-contact book must never stay resident.
export const AVATAR_CACHE_MAX = 64;
const cache = new Map<string, { uri: string }>();

/** Forget every drawn pet (wallet changed). */
export function clearAvatarCache(): void {
  cache.clear();
}

/** How many pets are held now (tests). */
export function avatarCacheSize(): number {
  return cache.size;
}

/** The contact's pet as an image source. Same name (any case/spacing) → same pet. */
export function petAvatar(name: string, size: keyof typeof SCALE = "list"): { uri: string } {
  const traits = traitsFor(name);
  // The fingerprint is the hash every drawn trait comes from: two names share
  // it only if they draw the same pet.
  const key = `${size}:${traits.fingerprint}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const png = encodePixelPng(renderFull(traits, 0, false), W, H, SCALE[size]);
  const source = { uri: `data:image/png;base64,${base64(png)}` };
  cache.set(key, source);
  if (cache.size > AVATAR_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return source;
}

/** The pet's name, for accessibility ("Purple Chicken"). */
export function petName(name: string): string {
  return traitsFor(name).petName;
}

/**
 * The word a contact's pet is drawn from: their Nuri username when they have
 * one (the same pet on everyone's phone), otherwise the name they're saved as.
 */
export function avatarSeed(contact: { label: string; nuriUsername?: string }): string {
  const username = (contact.nuriUsername ?? "").trim().replace(/^@/, "").toLowerCase();
  return username || contact.label;
}

/** The contact's pet (see avatarSeed). */
export function contactAvatar(
  contact: { label: string; nuriUsername?: string },
  size: "list" | "hero" = "list",
): { uri: string } {
  return petAvatar(avatarSeed(contact), size);
}
