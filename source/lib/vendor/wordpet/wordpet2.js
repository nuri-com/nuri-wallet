/* wordpet2.js - v2.  A describable pixel pet: every drawn trait has a spoken name.
   v1 (pixelpet.js) is unchanged and still supported; this is a separate algorithm.

   Differences from v1:
     - SHA-256 instead of FNV, so trait fields can be sliced from independent digest bits
     - the phrase is the identity; the drawing renders the phrase
     - 32 named species presets own the silhouette
     - an emoji trio drawn from digest bits the phrase never touches
     - 48x48 so a giraffe reads as a giraffe
*/
(function (root) {
'use strict';

var W = 48, H = 48, CX = 23.5;
var BASE_BCY = 33, GROUND = 45, FOOT = 42;

/* ================= SHA-256 (sync, integer-only, bit-identical everywhere) ============ */

var K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

function utf8(str) {
  var b = [], i, c, c2;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++;
      }
    }
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return b;
}
function sha256(str) {
  var b = utf8(str), len = b.length, bitLen = len * 8, i, j;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  for (i = 0; i < 4; i++) b.push(0);                       /* high 32 bits of length: always 0 here */
  b.push((bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);

  var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var w = new Array(64);
  for (i = 0; i < b.length; i += 64) {
    for (j = 0; j < 16; j++)
      w[j] = (b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) | (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3];
    for (j = 16; j < 64; j++) {
      var g0 = w[j - 15], g1 = w[j - 2];
      var s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
      var s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (j = 0; j < 64; j++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[j] + w[j]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & bb) ^ (a & c) ^ (bb & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  var out = [];
  for (i = 0; i < 8; i++)
    out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
  return out;                                              /* 32 bytes */
}

function normalize(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/* ============================== vocabularies ============================== */

/* 12 colours nobody argues about the name of */
var COLOURS = [
  { n: 'red',       h: 2,   s: 72, l: 54 },
  { n: 'orange',    h: 26,  s: 85, l: 55 },
  { n: 'yellow',    h: 47,  s: 85, l: 58 },
  { n: 'green',     h: 132, s: 48, l: 46 },
  { n: 'turquoise', h: 178, s: 52, l: 47 },
  { n: 'blue',      h: 214, s: 62, l: 55 },
  { n: 'purple',    h: 274, s: 44, l: 58 },
  { n: 'pink',      h: 334, s: 72, l: 70 },
  { n: 'brown',     h: 24,  s: 38, l: 38 },
  { n: 'grey',      h: 220, s: 6,  l: 58 },
  { n: 'black',     h: 222, s: 14, l: 26 },
  { n: 'white',     h: 45,  s: 22, l: 90 }
];
/* the 8 that read clearly on hats and shoes */
var ACCENTS = [11, 10, 0, 5, 3, 2, 6, 7];

/* ear:  0 none 1 round 2 pointed 3 long 4 floppy 5 tufted 6 elephant 7 horns
         8 ossicone 9 comb 10 tiny 11 round+horns 12 floppy+horns 13 big round
   snout:0 none 1 short 2 wide 3 beak 4 trunk 5 disc 6 long 7 bill
   back: 0 smooth 1 ridged 2 shell 3 fluffy 4 spiky 5 mane 6 crest
   tail: 0 none 1 stub 2 long 3 puff 4 fan 5 thick 6 curl
   limb: 0 paws 1 flippers 2 wings 3 claws 4 hooves                            */
var SPECIES = [
  { n:'elephant',  bw:10.0,bh:8.0, neck:0, hr:9.0,hy:7.5, ear:6,  snout:4, back:0, tail:1, limb:4 },
  { n:'giraffe',   bw:7.5, bh:7.0, neck:8, hr:5.5,hy:5.0, ear:8,  snout:1, back:0, tail:2, limb:4 , lift:3},
  { n:'penguin',   bw:8.0, bh:9.0, neck:0, hr:6.5,hy:6.0, ear:0,  snout:3, back:0, tail:0, limb:1, belly:1 },
  { n:'cat',       bw:7.5, bh:7.0, neck:1, hr:7.5,hy:6.5, ear:2,  snout:1, back:0, tail:2, limb:0, whisk:1 },
  { n:'dog',       bw:8.0, bh:7.0, neck:1, hr:7.5,hy:6.5, ear:4,  snout:6, back:0, tail:1, limb:0 },
  { n:'rabbit',    bw:7.5, bh:7.0, neck:0, hr:7.0,hy:6.5, ear:3,  snout:1, back:0, tail:3, limb:0 },
  { n:'bear',      bw:10.0,bh:8.0, neck:0, hr:8.5,hy:7.5, ear:1,  snout:1, back:0, tail:1, limb:0 },
  { n:'mouse',     bw:6.5, bh:6.0, neck:0, hr:6.5,hy:6.0, ear:13, snout:1, back:0, tail:2, limb:0, whisk:1 },
  { n:'fox',       bw:7.0, bh:6.5, neck:1, hr:7.0,hy:6.0, ear:2,  snout:6, back:0, tail:3, limb:0 },
  { n:'owl',       bw:8.5, bh:8.0, neck:0, hr:8.0,hy:7.0, ear:5,  snout:3, back:0, tail:4, limb:2 },
  { n:'duck',      bw:8.0, bh:7.0, neck:3, hr:6.0,hy:5.5, ear:0,  snout:7, back:0, tail:4, limb:3 },
  { n:'crocodile', bw:10.0,bh:6.5, neck:0, hr:8.0,hy:5.5, ear:0,  snout:2, back:1, tail:5, limb:3 },
  { n:'turtle',    bw:9.5, bh:7.0, neck:3, hr:6.0,hy:5.5, ear:0,  snout:1, back:2, tail:1, limb:0 },
  { n:'pig',       bw:9.5, bh:7.5, neck:0, hr:8.0,hy:7.0, ear:4,  snout:5, back:0, tail:6, limb:4 },
  { n:'cow',       bw:10.0,bh:7.5, neck:1, hr:8.0,hy:6.5, ear:11, snout:5, back:0, tail:2, limb:4 },
  { n:'sheep',     bw:9.0, bh:7.5, neck:0, hr:7.5,hy:6.5, ear:4,  snout:1, back:3, tail:1, limb:4 },
  { n:'horse',     bw:9.0, bh:7.0, neck:4, hr:6.5,hy:6.0, ear:2,  snout:6, back:5, tail:2, limb:4 , lift:2, back:6},
  { n:'monkey',    bw:7.5, bh:7.0, neck:1, hr:7.5,hy:6.5, ear:13, snout:1, back:0, tail:2, limb:0 },
  { n:'lion',      bw:9.0, bh:7.5, neck:0, hr:7.5,hy:6.5, ear:1,  snout:1, back:5, tail:1, limb:0 },
  { n:'tiger',     bw:9.5, bh:7.5, neck:0, hr:8.0,hy:6.8, ear:1,  snout:1, back:0, tail:2, limb:0, whisk:1 },
  { n:'panda',     bw:10.0,bh:8.0, neck:0, hr:8.5,hy:7.5, ear:1,  snout:1, back:0, tail:1, limb:0, patch:1 },
  { n:'chicken',   bw:7.5, bh:7.0, neck:2, hr:6.0,hy:5.5, ear:9,  snout:3, back:0, tail:4, limb:3 },
  { n:'goat',      bw:8.0, bh:7.0, neck:2, hr:6.5,hy:6.0, ear:12, snout:1, back:0, tail:1, limb:4 },
  { n:'llama',     bw:7.5, bh:7.5, neck:7, hr:5.5,hy:5.0, ear:8,  snout:1, back:3, tail:1, limb:4 , lift:2},
  { n:'squirrel',  bw:6.5, bh:6.5, neck:1, hr:6.5,hy:6.0, ear:5,  snout:1, back:0, tail:3, limb:0 },
  { n:'hedgehog',  bw:9.0, bh:6.5, neck:0, hr:6.5,hy:5.5, ear:10, snout:6, back:4, tail:1, limb:0 },
  { n:'koala',     bw:8.5, bh:7.5, neck:0, hr:8.0,hy:7.0, ear:13, snout:1, back:0, tail:0, limb:0 },
  { n:'flamingo',  bw:6.5, bh:6.5, neck:7,hr:4.5,hy:4.0, ear:0,  snout:3, back:0, tail:4, limb:3, stilts:1 , lift:6},
  { n:'dragon',    bw:9.0, bh:7.0, neck:2, hr:7.5,hy:6.0, ear:7,  snout:2, back:1, tail:5, limb:2 },
  { n:'wolf',      bw:8.5, bh:7.0, neck:1, hr:7.5,hy:6.5, ear:2,  snout:6, back:0, tail:2, limb:0 },
  { n:'seal',      bw:9.0, bh:8.0, neck:0, hr:7.0,hy:6.0, ear:0,  snout:1, back:0, tail:4, limb:1, whisk:1 , sits:1},
  { n:'kangaroo',  bw:7.5, bh:8.0, neck:2, hr:6.5,hy:6.0, ear:3,  snout:6, back:0, tail:5, limb:0 }
];

var PATTERNS = ['plain', 'spotted', 'striped', 'patched'];
var EYES = ['open eyes', 'closed eyes', 'big eyes', 'winking', 'angry eyes', 'star eyes', 'glasses', 'tiny eyes'];
var HATS = ['no hat', 'cap', 'top hat', 'beanie', 'crown', 'wizard hat', 'cowboy hat', 'headband',
            'halo', 'helmet', 'party hat', 'bow', 'sun hat', 'chef hat', 'pirate hat', 'flower crown'];
var SHOES = ['bare feet', 'boots', 'sneakers', 'sandals'];
var ITEMS = ['nothing', 'sword', 'umbrella', 'flower', 'balloon', 'fish', 'key', 'book',
             'mug', 'lantern', 'hammer', 'guitar', 'kite', 'ice cream', 'wand', 'shield'];
var MOVES = ['bob', 'hop', 'sway', 'float', 'wiggle', 'march'];

/* 150 emoji chosen to stay distinct across Apple, Google and Samsung sets.
   No near-duplicate faces, no colour-only pairs, no vendor-divergent objects. */
var EMOJI = ('🍎 🍌 🍇 🍓 🍒 🍑 🍍 🥝 🥥 🌽 🥕 🍄 🌰 🥐 🍞 🧀 🍔 🍟 🌮 🍕 🍩 🍪 🎂 🍭 🍯 ' +
  '☕ 🍵 🍺 🥤 🧊 🌶 🥑 🥚 🍤 🦀 🐙 🐚 🌊 🔥 ❄ ⚡ 🌈 ☂ ⛄ 🌙 ⭐ ☀ ☁ 🌵 🌲 🌴 🍀 🌻 🌹 🌷 ' +
  '🎈 🎁 🎃 🎄 🔔 🎺 🎸 🥁 🎹 🎤 🎧 🎬 🎨 🖌 📚 📖 ✏ 📌 📎 🔑 🔒 🗝 💡 🔦 🕯 ⌛ ⏰ 🧭 🗺 🧲 ' +
  '⚓ 🚀 ✈ 🚁 🚂 🚌 🚲 🛵 🛶 ⛵ 🏠 🏰 ⛺ 🌉 🗿 🎯 🎲 ♟ 🧩 🪁 🏀 ⚽ 🏈 🎾 🥊 🏆 🥇 🎣 🛹 ⛷ ' +
  '🐝 🐌 🦋 🐞 🕷 🦗 🐢 🐍 🦎 🐸 🐬 🐳 🦈 🐊 🦅 🦉 🦆 🐧 🦩 🦚 🐘 🦒 🐫 🦓 🦔 🦇 🐿 🦡 🐻 🦊 ' +
  '🧦 👒 🎩 👑 👓 💍 👞 🧤 🎒 ☔ 🪃 🔨 🪓 🔧 🧪 🔬 🔭 💎 🪙 🧸').split(' ').filter(Boolean);

/* ============================== traits ============================== */

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l = Math.max(0, Math.min(100, l)) / 100;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  function f(v) { var n = Math.round((v + m) * 255); n = n < 0 ? 0 : n > 255 ? 255 : n; return (n < 16 ? '0' : '') + n.toString(16); }
  return '#' + f(r) + f(g) + f(b);
}
function shade(col, dl) { return hsl(col.h, col.s, col.l + dl); }

/* Where the parts of a species land, so a later version can draw on top of a rendered pet
   without guessing.  Pure: reading it changes nothing. */
function anatomy(speciesIdx, sw) {
  var sp = SPECIES[speciesIdx];
  sw = sw || 0;
  var bcy = BASE_BCY - (sp.lift || 0), bw = sp.bw, bh = sp.bh;
  var bodyTop = bcy - bh, bodyBot = bcy + bh;
  var headCy = bodyTop - sp.neck - sp.hy + 2.5;
  var ay = bcy - 1, hands;
  if (sp.limb === 2) hands = [[CX - bw - 2, bcy + 3], [CX + bw + 2, bcy + 3]];
  else if (sp.limb === 1) hands = [[CX - (bw + 0.6), ay + 5], [CX + (bw + 0.6), ay + 5]];
  else hands = [[CX - (bw + 0.6), ay + 4.6 - sw * 0.9], [CX + (bw + 0.6), ay + 4.6 + sw * 0.9]];
  return {
    CX: CX, W: W, H: H, bw: bw, bh: bh, bcy: bcy, bodyTop: bodyTop, bodyBot: bodyBot,
    headCy: headCy, hr: sp.hr, hy: sp.hy, neck: sp.neck, limb: sp.limb, sits: !!sp.sits,
    hands: hands, foot: FOOT, ground: GROUND
  };
}

/* the full colour set a drawing needs, from three palette indices */
function paletteFor(bodyIdx, hatIdx, shoeIdx) {
  var base = COLOURS[bodyIdx], hc = COLOURS[hatIdx], sc = COLOURS[shoeIdx];
  return {
    body: shade(base, 0), light: shade(base, 13), dark: shade(base, -13),
    out: hsl(base.h, Math.min(base.s, 55), Math.max(8, base.l - 42)),
    pale: shade(base, base.l > 70 ? -22 : 30),
    hat: shade(hc, 0), hatD: shade(hc, -16), hatL: shade(hc, 16),
    shoe: shade(sc, 0), shoeD: shade(sc, -16),
    ink: '#141119', white: '#ffffff', gold: '#f5c542', steel: '#c6ced9',
    wood: '#9a6b43', leaf: '#4c9a52', red: '#d8443c', sky: '#79c0f0'
  };
}

function traitsFor(input) {
  var name = normalize(input), d = sha256(name), i;
  var hex = '';
  for (i = 0; i < d.length; i++) hex += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  /* sixteen independent 16-bit fields sliced straight out of the digest */
  function F(k) { return (d[k * 2] << 8) | d[k * 2 + 1]; }

  var t = {
    version: 2,
    name: name,
    fingerprint: hex,
    colour: F(0) % COLOURS.length,
    species: F(1) % SPECIES.length,
    pattern: F(2) % PATTERNS.length,
    eyes: F(3) % EYES.length,
    hat: F(4) % HATS.length,
    hatColour: ACCENTS[F(5) % ACCENTS.length],
    shoes: F(6) % SHOES.length,
    shoeColour: ACCENTS[F(7) % ACCENTS.length],
    item: F(8) % ITEMS.length,
    move: F(12) % MOVES.length
  };

  /* emoji trio: fields 9-11, which nothing in the phrase or the drawing reads */
  var pool = EMOJI.slice(), trio = [];
  for (i = 0; i < 3; i++) trio.push(pool.splice(F(9 + i) % pool.length, 1)[0]);
  t.emoji = trio;

  /* a species with no drawn feet is never described as wearing shoes */
  if (SPECIES[t.species].limb === 1 || SPECIES[t.species].sits) t.shoes = 0;

  t.col = paletteFor(t.colour, t.hatColour, t.shoeColour);
  var base = COLOURS[t.colour], hc = COLOURS[t.hatColour], sc = COLOURS[t.shoeColour];

  var sp = SPECIES[t.species];
  t.words = {
    colour: base.n, species: sp.n, pattern: PATTERNS[t.pattern], eyes: EYES[t.eyes],
    hat: HATS[t.hat], hatColour: hc.n, shoes: SHOES[t.shoes], shoeColour: sc.n,
    item: ITEMS[t.item], move: MOVES[t.move]
  };
  t.petName = base.n.charAt(0).toUpperCase() + base.n.slice(1) + ' ' +
              sp.n.charAt(0).toUpperCase() + sp.n.slice(1);
  t.segments = segmentsOf(t);
  t.phrase = phraseOf(t);
  return t;
}

/* Fixed slot order, so two people never describe one pet differently.
   The sentence is assembled from segments and the UI highlights the same segments,
   so the words on screen can never drift from the words in the phrase. */
function segmentsOf(t) {
  var w = t.words, seg = [];
  function lit(x) { seg.push({ text: x, trait: false }); }
  function slot(x) { seg.push({ text: x, trait: true }); }
  lit('the ');
  if (t.pattern > 0) { slot(w.pattern); lit(' '); }
  slot(w.colour); lit(' '); slot(w.species);
  lit(', ');
  if (t.hat === 0) slot('no hat'); else { slot(w.hatColour); lit(' '); slot(w.hat); }
  lit(', '); slot(w.eyes);
  lit(', ');
  if (t.shoes === 0) slot('bare feet'); else { slot(w.shoeColour); lit(' '); slot(w.shoes); }
  if (t.item === 0) { lit(', holding '); slot('nothing'); }
  else { lit(', holding ' + ('aeiou'.indexOf(w.item.charAt(0)) >= 0 ? 'an ' : 'a ')); slot(w.item); }
  return seg;
}
function phraseOf(t) {
  return segmentsOf(t).map(function (s) { return s.text; }).join('');
}

/* ============================== raster ============================== */

function P(b, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  b[y * W + x] = c;
}
function S(b, x, y, c) { P(b, x, y, c); P(b, W - 1 - Math.round(x), y, c); }
function G(b, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return null;
  return b[y * W + x];
}
function only(b, x, y, c, want) { if (G(b, x, y) === want) P(b, x, y, c); }
function ell(b, cx, cy, rx, ry, c) {
  for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      var dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.03) P(b, x, y, c);
    }
}
function ellS(b, cx, cy, rx, ry, c) { ell(b, cx, cy, rx, ry, c); ell(b, W - 1 - cx, cy, rx, ry, c); }
function ellO(b, cx, cy, rx, ry, fill, out) { ell(b, cx, cy, rx + 0.9, ry + 0.9, out); ell(b, cx, cy, rx, ry, fill); }
function rect(b, x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) P(b, x, y, c); }
function rectS(b, x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) S(b, x, y, c); }
function tri(b, ax, ay, dirY, h, c, mirror, slope) {
  slope = slope == null ? 0.75 : slope;
  for (var i = 0; i < h; i++) {
    var y = ay + dirY * i, hw = Math.round(i * slope);
    for (var x = ax - hw; x <= ax + hw; x++) { if (mirror) S(b, x, y, c); else P(b, x, y, c); }
  }
}
function topAt(b, x) { for (var y = 0; y < H; y++) if (G(b, x, y)) return y; return H; }
function line(b, x0, y0, x1, y1, c, th) {
  th = th || 1;
  var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
  for (var i = 0; i <= n; i++) {
    var x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    if (th <= 1) P(b, x, y, c); else ell(b, x, y, th / 2, th / 2, c);
  }
}

/* ============================== the drawing ============================== */

function render(t, phase, blink) {
  var b = new Array(W * H).fill(null), c = t.col, sp = SPECIES[t.species];
  var sw = [0, 1, 0, -1][phase & 3];
  var BCY = BASE_BCY - (sp.lift || 0);
  var bw = sp.bw, bh = sp.bh, bodyTop = BCY - bh, bodyBot = BCY + bh;
  var hy = sp.hy, hr = sp.hr, headCy = bodyTop - sp.neck - hy + 2.5;
  var x, y, i;

  /* ---- tail, behind ---- */
  var tx = CX + bw + 2.5;
  if (sp.tail === 1) ellO(b, tx, BCY + 2, 2.4, 2.4, c.dark, c.out);
  else if (sp.tail === 2) line(b, tx - 2, BCY + 3, tx + 5, BCY - 6 - sw, c.dark, 2.8);
  else if (sp.tail === 3) { ellO(b, tx + 2.5, BCY - 4 - sw, 5.0, 6.0, c.dark, c.out); ell(b, tx + 2.5, BCY - 4 - sw, 2.6, 3.4, c.pale); }
  else if (sp.tail === 4) { for (i = 0; i < 4; i++) line(b, tx - 2, BCY + 2, tx + 4 + i, BCY - 4 + i * 2 - sw, c.dark, 2.4); }
  else if (sp.tail === 5) { line(b, tx - 3, BCY + 4, tx + 6, BCY - 2 - sw, c.dark, 5.0); line(b, tx + 4, BCY - 1 - sw, tx + 8, BCY - 5 - sw, c.dark, 2.4); }
  else if (sp.tail === 6) { for (i = 0; i < 8; i++) ell(b, tx + [0,1.6,2.8,3.2,2.4,1.0,0.2,0.6][i], BCY - 4 + [4,4.6,3.6,2.2,1.0,0.6,1.6,2.8][i], 1.1, 1.1, c.dark); }

  /* ---- wings, behind ---- */
  if (sp.limb === 2) {
    var fl = Math.abs(sw);
    for (var side = -1; side <= 1; side += 2)
      ellO(b, CX + side * (bw + 2.5), BCY - 1 - fl, 3.4, 5.2 - fl * 0.6, c.dark, c.out);
  }

  /* ---- legs, feet and shoes ---- */
  var legW = sp.stilts ? 1.2 : 2.2, legTop = bodyBot - 2;
  var pairs = [[CX - bw * 0.45, sw > 0 ? 0 : 1], [CX + bw * 0.45, sw > 0 ? 1 : 0]];
  if (sp.limb !== 1 && !sp.sits) {
    for (i = 0; i < 2; i++) {
      var lx = pairs[i][0], d = pairs[i][1];
      ellO(b, lx, (legTop + FOOT) / 2, legW, (FOOT - legTop) / 2 + 1, c.dark, c.out);
      var fy = FOOT + 1 - d;
      if (t.shoes === 0) {
        if (sp.limb === 4) ellO(b, lx, fy, 2.4, 1.7, c.pale, c.out);            /* hoof */
        else if (sp.limb === 3) { for (var k = -1; k <= 1; k++) ell(b, lx + k * 2, fy, 1.3, 1.2, c.gold); }
        else ellO(b, lx, fy, 3.0, 1.9, c.dark, c.out);                          /* paw */
      } else if (t.shoes === 1) { ellO(b, lx, fy - 0.5, 3.0, 2.4, c.shoe, c.out); rect(b, lx - 3, fy - 3, lx + 3, fy - 3, c.shoeD); }
      else if (t.shoes === 2) { ellO(b, lx - 0.4, fy, 3.4, 1.8, c.shoe, c.out); rect(b, lx - 3, fy - 1, lx + 2, fy - 1, c.white); }
      else { ellO(b, lx, fy + 0.4, 3.2, 1.3, c.shoe, c.out); rect(b, lx - 2, fy - 2, lx + 2, fy - 2, c.shoeD); }
    }
  }

  /* ---- body ---- */
  ell(b, CX, BCY, bw, bh, c.body);
  if (sp.belly) ell(b, CX, BCY + 1, bw * 0.62, bh * 0.78, c.pale);

  /* ---- coat pattern, body pixels only ---- */
  if (t.pattern === 1) {
    var spots = [[-4, -2], [3, 0], [0, 3], [-2, 4], [5, -3]];
    for (i = 0; i < spots.length; i++)
      ell(b, CX + spots[i][0], BCY + spots[i][1], 1.9, 1.9, G(b, CX + spots[i][0], BCY + spots[i][1]) === c.body ? c.dark : null);
  } else if (t.pattern === 2) {
    for (y = Math.round(BCY) - 5; y <= Math.round(BCY) + 5; y += 3)
      for (x = 8; x < 40; x++) only(b, x, y, c.dark, c.body);
  } else if (t.pattern === 3) {
    ell(b, CX - bw * 0.3, BCY + 1, bw * 0.45, bh * 0.55, G(b, CX - bw * 0.3, BCY + 1) === c.body ? c.pale : null);
  }

  /* ---- back decoration, sitting on the real silhouette ---- */
  if (sp.back === 1) for (i = -3; i <= 3; i++) { var rx1 = CX + i * (bw / 3.6); tri(b, rx1, topAt(b, rx1) - 3, 1, 4, c.dark, false, 0.7); }
  else if (sp.back === 4) for (i = -7; i <= 7; i++) { var rx2 = CX + i * (bw / 7.2); tri(b, rx2, topAt(b, rx2) - 5, 1, 6, c.dark, false, 0.45); }
  else if (sp.back === 3) for (i = -3; i <= 3; i++) { var rx3 = CX + i * (bw / 3.2); ell(b, rx3, topAt(b, rx3) + 1.2, 2.9, 2.6, c.light); }
  else if (sp.back === 2) { ell(b, CX, BCY - 0.6, bw * 0.96, bh * 0.96, c.dark); for (i = -1; i <= 1; i++) for (var jj = -1; jj <= 1; jj++) ell(b, CX + i * bw * 0.44, BCY - 0.6 + jj * bh * 0.44, bw * 0.17, bh * 0.17, c.pale); }
  else if (sp.back === 5) ell(b, CX, headCy + 1, hr + 3.4, hy + 3.2, c.dark);
  else if (sp.back === 6) for (i = 0; i < 7; i++) ell(b, CX + 3.2, headCy + hy - 2 + i * 1.5, 2.2, 1.8, c.dark);

  /* ---- webbed feet for the flippered ones ---- */
  if (sp.limb === 1 && !sp.sits) for (i = -1; i <= 1; i += 2) ellO(b, CX + i * 3.4, bodyBot + 0.5, 3.4, 1.6, c.gold, c.out);

  /* ---- arms, flippers, hands ---- */
  var hands = [];
  if (sp.limb !== 2) {
    for (var sd = -1; sd <= 1; sd += 2) {
      var ax = CX + sd * (bw + 0.6), ay = BCY - 1, hx, hyy;
      if (sp.limb === 1) { ellO(b, ax - sd * 0.6, ay + 1.5, 2.2, 4.0, c.dark, c.out); hx = ax; hyy = ay + 5; }
      else { var dy = sw * sd * 0.9; ellO(b, ax, ay + 1 + dy, 1.7, 3.4, c.body, c.out); hx = ax; hyy = ay + 4.6 + dy; ellO(b, hx, hyy, 1.8, 1.8, c.dark, c.out); }
      hands.push([hx, hyy]);
    }
  } else hands = [[CX - bw - 2, BCY + 3], [CX + bw + 2, BCY + 3]];

  /* ---- neck ---- */
  if (sp.neck > 0) {
    var nw = sp.neck > 6 ? 2.6 : 3.4;
    ell(b, CX, (headCy + hy + bodyTop) / 2, nw, (bodyTop - headCy - hy) / 2 + 2.5, c.body);
  }

  /* ---- ears, behind the head ---- */
  var eb = c.body, et = headCy - hy * 0.55;
  if (sp.ear === 1) { ellS(b, CX - hr * 0.70, et - 3.0, 3.2, 3.2, eb); ellS(b, CX - hr * 0.74, et - 3.4, 1.7, 1.7, c.pale); }
  else if (sp.ear === 2) { tri(b, CX - hr * 0.6, et - 6.5, 1, 7, eb, true, 0.55); tri(b, CX - hr * 0.6, et - 4.5, 1, 5, c.pale, true, 0.42); }
  else if (sp.ear === 3) { ellS(b, CX - hr * 0.42, headCy - hy - 5.5, 2.2, 6.4, eb); ellS(b, CX - hr * 0.42, headCy - hy - 5.5, 1.1, 4.4, c.pale); }
  else if (sp.ear === 4) { ellS(b, CX - hr * 0.86, et + 1.5, 2.4, 4.6, c.dark); }
  else if (sp.ear === 5) { tri(b, CX - hr * 0.5, et - 5, 1, 5, eb, true, 0.6); }
  else if (sp.ear === 6) { ellS(b, CX - hr * 1.02, headCy + 1.0, 6.2, 7.0, c.dark); ellS(b, CX - hr * 1.02, headCy + 1.5, 3.6, 4.4, c.pale); }
  else if (sp.ear === 7) { tri(b, CX - hr * 0.55, et - 6, 1, 6, c.pale, true, 0.5); }
  else if (sp.ear === 8) { rectS(b, CX - hr * 0.45 - 1, headCy - hy - 4, CX - hr * 0.45, headCy - hy + 1, c.dark); ellS(b, CX - hr * 0.45 - 0.5, headCy - hy - 4.5, 1.4, 1.4, c.dark); }
  else if (sp.ear === 9) { for (i = 0; i < 3; i++) ell(b, CX - 2 + i * 2, headCy - hy - 1.5 - (i === 1 ? 1 : 0), 1.5, 2.0, c.red); }
  else if (sp.ear === 10) { ellS(b, CX - hr * 0.6, et - 1, 1.5, 1.5, c.dark); }
  else if (sp.ear === 11) { ellS(b, CX - hr * 0.7, et - 1, 2.6, 2.4, eb); line(b, CX - hr * 0.75, et - 3, CX - hr * 1.25, et - 5.5, c.pale, 2.0); line(b, CX + hr * 0.75, et - 3, CX + hr * 1.25, et - 5.5, c.pale, 2.0); }
  else if (sp.ear === 12) { ellS(b, CX - hr * 0.86, et + 1.5, 2.2, 4.2, c.dark); line(b, CX - hr * 0.5, et - 3, CX - hr * 0.9, et - 6.5, c.pale, 2.0); line(b, CX + hr * 0.5, et - 3, CX + hr * 0.9, et - 6.5, c.pale, 2.0); }
  else if (sp.ear === 13) { ellS(b, CX - hr * 1.12, et - 0.5, 4.4, 4.4, eb); ellS(b, CX - hr * 1.28, et - 0.5, 2.4, 2.4, c.pale); }

  /* ---- head ---- */
  ell(b, CX, headCy, hr, hy, c.body);
  if (sp.patch) { ellS(b, CX - hr * 0.46, headCy - 0.6, 3.0, 3.2, '#241f2b'); }

  /* ---- snout ---- */
  var sy = headCy + hy * 0.52;
  var snoutBase = headCy + hy * 0.66;                       /* sits low enough to break the outline */
  if (sp.snout === 1) { ell(b, CX, snoutBase, hr * 0.44, hy * 0.34, c.pale); ell(b, CX, snoutBase - 1.2, 1.5, 1.1, c.ink); }
  else if (sp.snout === 2) {
    ell(b, CX, snoutBase + 2.4, hr * 0.80, hy * 0.52, c.pale);
    for (i = -3; i <= 3; i++) P(b, CX + i * 1.9, snoutBase + 4.4, c.white);
    P(b, CX - 2, snoutBase + 0.4, c.ink); P(b, CX + 2, snoutBase + 0.4, c.ink);
  }
  else if (sp.snout === 3) { tri(b, Math.round(CX), snoutBase + 5, -1, 5, c.gold, false, 0.8); tri(b, Math.round(CX) + 1, snoutBase + 5, -1, 5, c.gold, false, 0.8); }
  else if (sp.snout === 4) {
    ell(b, CX, snoutBase, 3.4, 2.6, c.pale);
    line(b, CX, snoutBase + 1, CX, snoutBase + 10, c.pale, 3.6);
    ell(b, CX, snoutBase + 10.5, 2.2, 1.7, c.pale);
    for (i = 0; i < 4; i++) rect(b, CX - 1, snoutBase + 3 + i * 2, CX + 1, snoutBase + 3 + i * 2, c.dark);
  }
  else if (sp.snout === 5) { ell(b, CX, snoutBase + 1.4, 4.0, 2.9, c.pale); P(b, CX - 1.5, snoutBase + 1.4, c.ink); P(b, CX + 1.5, snoutBase + 1.4, c.ink); }
  else if (sp.snout === 6) { ell(b, CX, snoutBase + 2.6, hr * 0.36, hy * 0.50, c.pale); ell(b, CX, snoutBase + 1.0, 1.6, 1.2, c.ink); }
  else if (sp.snout === 7) { ell(b, CX, snoutBase + 3.0, 4.8, 2.1, c.gold); }
  if (sp.whisk) { for (i = 0; i < 2; i++) { line(b, CX - hr * 0.45, sy + i * 1.6, CX - hr - 2.5, sy - 1 + i * 2.2, c.ink, 1); line(b, CX + hr * 0.45, sy + i * 1.6, CX + hr + 2.5, sy - 1 + i * 2.2, c.ink, 1); } }

  /* ---- eyes ---- */
  var ey = headCy - hy * 0.16, ex = CX - hr * 0.44, er = Math.max(1.9, hr * 0.30);
  function shut() { rectS(b, ex - er, ey, ex + er, ey, c.ink); S(b, ex - er - 1, ey - 1, c.ink); S(b, ex + er + 1, ey - 1, c.ink); }
  if (blink || t.eyes === 1) shut();
  else if (t.eyes === 0) { ellS(b, ex, ey, er, er * 1.12, c.white); ellS(b, ex, ey + 0.3, er * 0.62, er * 0.74, c.ink); S(b, ex - er * 0.4, ey - er * 0.4, c.white); }
  else if (t.eyes === 2) { ellS(b, ex, ey, er * 1.35, er * 1.5, c.white); ellS(b, ex, ey + 0.4, er * 0.85, er * 1.0, c.ink); S(b, ex - er * 0.5, ey - er * 0.6, c.white); }
  else if (t.eyes === 3) { ell(b, ex, ey, er, er * 1.12, c.white); ell(b, ex, ey + 0.3, er * 0.62, er * 0.74, c.ink); rect(b, W - 1 - Math.round(ex) - er, ey, W - 1 - Math.round(ex) + er, ey, c.ink); }
  else if (t.eyes === 4) { for (i = 0; i <= er * 2; i++) { S(b, ex - er + i, ey + 1 + Math.round(i * 0.5), c.ink); S(b, ex - er + i, ey + 2 + Math.round(i * 0.5), c.ink); } }
  else if (t.eyes === 5) { ellS(b, ex, ey, er, er * 1.1, c.ink); S(b, ex, ey - 1, c.gold); S(b, ex - 1, ey, c.gold); S(b, ex, ey, c.gold); S(b, ex + 1, ey, c.gold); S(b, ex, ey + 1, c.gold); }
  else if (t.eyes === 6) { ellS(b, ex, ey, er * 1.2, er * 1.2, c.steel); ellS(b, ex, ey, er * 0.8, er * 0.8, c.white); ellS(b, ex, ey, er * 0.35, er * 0.35, c.ink); rect(b, CX - hr * 0.2, ey, CX + hr * 0.2, ey, c.steel); }
  else { ellS(b, ex, ey, 1.2, 1.2, c.ink); }

  /* ---- hat ---- */
  var ht = headCy - hy;                                     /* top of the head */
  if (t.hat === 1) { ell(b, CX, ht + 1.5, hr * 0.78, 3.4, c.hat); rect(b, CX - hr * 0.95, ht + 3, CX + hr * 0.95, ht + 4, c.hatD); }
  else if (t.hat === 2) { rect(b, CX - hr * 0.5, ht - 7, CX + hr * 0.5, ht + 1, c.hatD); rect(b, CX - hr * 0.5, ht - 2, CX + hr * 0.5, ht - 1, c.hat); rect(b, CX - hr * 1.05, ht + 1, CX + hr * 1.05, ht + 2, c.hatD); }
  else if (t.hat === 3) { ell(b, CX, ht + 1, hr * 0.86, 4.4, c.hat); rect(b, CX - hr * 0.9, ht + 2, CX + hr * 0.9, ht + 3.5, c.hatD); ell(b, CX, ht - 4.5, 2.2, 2.2, c.hatL); }
  else if (t.hat === 4) { rect(b, CX - hr * 0.6, ht - 2, CX + hr * 0.6, ht + 1, c.hat); for (i = -2; i <= 2; i++) tri(b, CX + i * hr * 0.28, ht - 6, 1, 5, c.hat, false, 0.55); }
  else if (t.hat === 5) { tri(b, Math.round(CX), ht - 10, 1, 11, c.hatD, false, 0.62); tri(b, Math.round(CX) + 1, ht - 10, 1, 11, c.hatD, false, 0.62); rect(b, CX - hr * 1.1, ht + 1, CX + hr * 1.1, ht + 2, c.hat); P(b, CX, ht - 6, c.gold); P(b, CX + 2, ht - 3, c.gold); }
  else if (t.hat === 6) { ell(b, CX, ht + 0.5, hr * 0.62, 3.6, c.hat); for (i = -1; i <= 1; i += 2) ell(b, CX + i * hr * 1.05, ht + 2.5, 3.0, 1.6, c.hat); rect(b, CX - hr * 0.95, ht + 2, CX + hr * 0.95, ht + 3, c.hatD); }
  else if (t.hat === 7) { rect(b, CX - hr * 0.98, ht + 1, CX + hr * 0.98, ht + 2.5, c.hat); ell(b, CX + hr * 0.9, ht + 0.5, 2.0, 2.0, c.hatL); }
  else if (t.hat === 8) { var hh = ht - 5 + (sw > 0 ? 1 : 0); ell(b, CX, hh, hr * 0.6, 1.9, c.gold); ell(b, CX, hh, hr * 0.36, 0.8, null); }
  else if (t.hat === 9) { ell(b, CX, ht + 1.5, hr * 0.95, 4.6, c.hat); rect(b, CX - hr * 0.95, ht + 3, CX + hr * 0.95, ht + 4, c.hatD); rect(b, CX - 1, ht - 4, CX + 1, ht + 1, c.hatL); }
  else if (t.hat === 10) { tri(b, Math.round(CX), ht - 8, 1, 9, c.hat, false, 0.5); tri(b, Math.round(CX) + 1, ht - 8, 1, 9, c.hat, false, 0.5); ell(b, CX, ht - 9, 1.6, 1.6, c.gold); }
  else if (t.hat === 11) { for (i = -1; i <= 1; i += 2) tri(b, CX + i * 4, ht - 1, 1, 4, c.hat, false, 0.9); rect(b, CX - 1, ht - 1, CX + 1, ht + 1, c.hatD); }
  else if (t.hat === 12) { ell(b, CX, ht + 1, hr * 0.66, 2.8, c.hat); ell(b, CX, ht + 3, hr * 1.35, 1.9, c.hat); rect(b, CX - hr * 0.7, ht + 1, CX + hr * 0.7, ht + 1.5, c.hatD); }
  else if (t.hat === 13) { ell(b, CX, ht - 3, hr * 0.72, 4.2, c.white); rect(b, CX - hr * 0.62, ht - 0.5, CX + hr * 0.62, ht + 1.5, c.hat); }
  else if (t.hat === 14) { ell(b, CX, ht + 0.5, hr * 0.92, 3.4, c.hatD); rect(b, CX - hr * 1.0, ht + 2, CX + hr * 1.0, ht + 3, c.hatD); P(b, CX - 1, ht - 1, c.white); P(b, CX + 1, ht - 1, c.white); P(b, CX, ht, c.white); P(b, CX - 2, ht + 1, c.white); P(b, CX + 2, ht + 1, c.white); }
  else if (t.hat === 15) { for (i = -2; i <= 2; i++) { ell(b, CX + i * 3.4, ht + 0.5, 1.9, 1.9, i % 2 ? c.hatL : c.hat); P(b, CX + i * 3.4, ht + 0.5, c.gold); } }

  /* ---- held item, in the right hand ---- */
  if (t.item > 0 && hands.length) {
    var ix = hands[1][0] + 1, iy = hands[1][1];
    switch (t.item) {
      case 1: line(b, ix, iy, ix, iy - 11, c.steel, 2.0); rect(b, ix - 3, iy - 2, ix + 3, iy - 1, c.gold); break;
      case 2: line(b, ix, iy + 1, ix, iy - 9, c.wood, 1); for (i = 0; i < 5; i++) ell(b, ix - 6 + i * 3, iy - 9 + Math.abs(i - 2), 2.2, 1.6, i % 2 ? c.red : c.white); break;
      case 3: line(b, ix, iy, ix, iy - 5, c.leaf, 1.4); for (i = 0; i < 5; i++) ell(b, ix + [0, 2.6, 1.6, -1.6, -2.6][i], iy - 7 + [-2.6, -0.8, 2, 2, -0.8][i] + 0.5, 1.6, 1.6, c.hatL); ell(b, ix, iy - 7, 1.3, 1.3, c.gold); break;
      case 4: line(b, ix, iy, ix + 1, iy - 6, c.ink, 1); ell(b, ix + 1, iy - 10, 3.4, 3.9, c.red); P(b, ix, iy - 12, c.white); break;
      case 5: ell(b, ix, iy - 3, 4.0, 2.4, c.sky); tri(b, Math.round(ix) + 5, iy - 3, 0, 1, c.sky, false, 0); for (i = 0; i < 3; i++) rect(b, ix + 4 + i, iy - 5 + i, ix + 4 + i, iy - 1 - i, c.sky); P(b, ix - 2, iy - 4, c.ink); break;
      case 6: ell(b, ix, iy - 6, 2.4, 2.4, c.gold); ell(b, ix, iy - 6, 1.0, 1.0, null); rect(b, ix - 0.5, iy - 4, ix + 0.5, iy, c.gold); rect(b, ix, iy - 2, ix + 2, iy - 2, c.gold); break;
      case 7: rect(b, ix - 4, iy - 7, ix + 4, iy - 1, c.hat); rect(b, ix - 4, iy - 7, ix - 3, iy - 1, c.hatD); rect(b, ix - 2, iy - 5, ix + 3, iy - 5, c.white); rect(b, ix - 2, iy - 3, ix + 3, iy - 3, c.white); break;
      case 8: rect(b, ix - 3, iy - 6, ix + 2, iy - 1, c.white); rect(b, ix - 3, iy - 6, ix + 2, iy - 5, c.hat); ell(b, ix + 4, iy - 3.5, 1.6, 1.6, c.white); ell(b, ix + 4, iy - 3.5, 0.7, 0.7, null); break;
      case 9: line(b, ix, iy, ix, iy - 3, c.steel, 1); rect(b, ix - 3, iy - 9, ix + 3, iy - 4, c.gold); rect(b, ix - 3, iy - 10, ix + 3, iy - 9, c.steel); break;
      case 10: line(b, ix, iy, ix, iy - 7, c.wood, 1.8); rect(b, ix - 3, iy - 10, ix + 3, iy - 7, c.steel); break;
      case 11: ell(b, ix, iy - 3, 3.4, 4.4, c.wood); ell(b, ix, iy - 3, 1.2, 1.2, c.ink); line(b, ix, iy - 7, ix, iy - 12, c.wood, 1.6); for (i = 0; i < 3; i++) P(b, ix - 1 + i, iy - 13, c.steel); break;
      case 12: for (i = 0; i < 4; i++) tri(b, Math.round(ix), iy - 11 + i, 0, 1, c.hat, false, 0); line(b, ix - 4, iy - 8, ix + 4, iy - 8, c.hatD, 1); line(b, ix, iy - 12, ix, iy - 4, c.hatD, 1); ell(b, ix, iy - 8, 4.4, 4.4, c.hat); line(b, ix, iy - 4, ix - 1, iy, c.ink, 1); break;
      case 13: tri(b, Math.round(ix), iy, -1, 5, c.wood, false, 0.55); ell(b, ix, iy - 6, 3.0, 3.0, c.pale); ell(b, ix - 1, iy - 8, 2.2, 2.2, c.hatL); break;
      case 14: line(b, ix, iy, ix + 1, iy - 7, c.wood, 1.2); P(b, ix + 1, iy - 9, c.gold); P(b, ix, iy - 8, c.gold); P(b, ix + 1, iy - 8, c.gold); P(b, ix + 2, iy - 8, c.gold); P(b, ix + 1, iy - 7, c.gold); break;
      default: ell(b, ix, iy - 4, 4.0, 5.0, c.steel); ell(b, ix, iy - 4, 2.2, 3.0, c.hat); break;
    }
  }

  /* ---- top-light shading on the coat ---- */
  var snap = b.slice();
  for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
    if (snap[y * W + x] !== c.body) continue;
    if (G(snap, x, y - 4) === null) b[y * W + x] = c.light;
    else if (G(snap, x, y + 3) === null) b[y * W + x] = c.dark;
  }

  /* ---- 1px outline round the whole silhouette ---- */
  var snap2 = b.slice();
  for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
    if (snap2[y * W + x] !== null) continue;
    if (G(snap2, x - 1, y) || G(snap2, x + 1, y) || G(snap2, x, y - 1) || G(snap2, x, y + 1))
      b[y * W + x] = c.out;
  }
  return b;
}

function motion(t, f) {
  var TAU = Math.PI * 2, s = Math.sin(f * TAU), o = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 }, u;
  switch (t.move) {
    case 0: o.dy = s * 1.6; break;
    case 1: u = Math.abs(s); o.dy = -u * 6; o.sy = 1 + u * 0.07; o.sx = 1 - u * 0.05; break;
    case 2: o.rot = s * 0.08; o.dy = -Math.abs(s); break;
    case 3: o.dy = s * 3; o.sx = 1 + s * 0.03; break;
    case 4: o.dx = s * 1.8; o.rot = s * 0.04; break;
    default: o.dy = -Math.abs(Math.sin(f * TAU * 2)) * 2.2; break;
  }
  return o;
}

var api = {
  W: W, H: H, version: 2, normalize: normalize, sha256: sha256,
  traitsFor: traitsFor, render: render, motion: motion, paletteFor: paletteFor, anatomy: anatomy, phraseOf: phraseOf, segmentsOf: segmentsOf,
  COLOURS: COLOURS, SPECIES: SPECIES, PATTERNS: PATTERNS, EYES: EYES,
  HATS: HATS, SHOES: SHOES, ITEMS: ITEMS, MOVES: MOVES, EMOJI: EMOJI, ACCENTS: ACCENTS
};
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Wordpet2 = api;
})(typeof self !== 'undefined' ? self : this);
