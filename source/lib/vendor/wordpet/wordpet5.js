/* wordpet5.js - v5.  Its own renderer and its own look.
   Independent of v1-v4 except for sha256 and normalize, which are pure utilities.

   The style, in four rules:
     1. one soft blob        head almost as wide as the body, heavy overlap, no neck
     2. volume, not flat     every material gets a 4-tone vertical ramp plus a rim light
     3. big eyes             mask, sclera, wide pupil, two highlights
     4. tiny limbs           small feet and arms against a large body reads as young

   72 x 72, so a giraffe, a hippo and a snail can all be themselves.
*/
(function (root) {
'use strict';

var node = (typeof module !== 'undefined' && module.exports);
var V2 = node ? require('./wordpet2.js') : root.Wordpet2;
if (!V2) throw new Error('wordpet5 needs wordpet2 loaded first (for sha256 and normalize)');

var W = 72, H = 72, CX = 35.5;
var GROUND = 64, FOOT = 60;
var BCY = 45, HCY = 27;                        /* body centre, head centre */

/* ============================== colour ============================== */

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  function f(v) { var n = Math.round((v + m) * 255); n = n < 0 ? 0 : n > 255 ? 255 : n; return (n < 16 ? '0' : '') + n.toString(16); }
  return '#' + f(r) + f(g) + f(b);
}
/* a material is four tones plus the rim, so the ramp pass can shade any surface */
function ramp(h, s, l) {
  return {
    rim:    hsl(h - 6, s * 0.55, Math.min(96, l + 26)),
    light:  hsl(h - 3, s * 0.85, l + 12),
    base:   hsl(h, s, l),
    mid:    hsl(h + 4, s * 1.05, l - 9),
    shadow: hsl(h + 8, s * 1.1, l - 17)
  };
}

/* ============================== vocabulary ============================== */

var NONE = '🚫';

/* 9 colours with an unmistakable emoji circle */
var COLOURS = [
  { w: 'red',    e: '🔴', h: 2,   s: 62, l: 56 },
  { w: 'orange', e: '🟠', h: 26,  s: 76, l: 57 },
  { w: 'yellow', e: '🟡', h: 46,  s: 76, l: 61 },
  { w: 'green',  e: '🟢', h: 133, s: 42, l: 48 },
  { w: 'blue',   e: '🔵', h: 213, s: 54, l: 57 },
  { w: 'purple', e: '🟣', h: 275, s: 40, l: 60 },
  { w: 'brown',  e: '🟤', h: 24,  s: 34, l: 42 },
  { w: 'black',  e: '⚫', h: 250, s: 12, l: 30 },
  { w: 'white',  e: '⚪', h: 40,  s: 18, l: 88 }
];

/* ear  0 none 1 round 2 pointed 3 long 4 floppy 5 tufted 6 fan 7 horns 8 ossicone
        9 comb 10 tiny 11 round+horns 12 floppy+horns 13 big round 14 antlers
        15 crest 16 curl horns 17 fin
   nose 0 none 1 short 2 wide 3 beak 4 trunk 5 disc 6 long 7 bill 8 nose horn
        9 big jaw 10 hooked beak 11 buck teeth
   back 0 smooth 1 ridged 2 shell 3 fluffy 4 spiky 5 mane 6 crest 7 hump
   tail 0 none 1 stub 2 long 3 puff 4 fan 5 thick 6 curl 7 paddle 8 plume
   limb 0 paws 1 flippers 2 wings 3 claws 4 hooves 5 stubby
   mark 0 none 1 eye mask 2 pale face 3 cheek patches                        */
var SPECIES = [
  ['elephant','🐘',{bw:19,bh:16,hw:16,hh:15,ear:6,nose:4,tail:1,limb:5,belly:0}],
  ['giraffe','🦒',{bw:14,bh:14,hw:11,hh:10,neck:13,ear:8,nose:1,tail:2,limb:4}],
  ['penguin','🐧',{bw:16,bh:17,hw:15,hh:14,merge:1,ear:0,nose:3,tail:0,limb:1,belly:1,mark:1,foot:'orange'}],
  ['cat','🐱',{bw:15,bh:14,hw:15,hh:14,ear:2,nose:1,tail:2,limb:0,whisk:1}],
  ['dog','🐶',{bw:16,bh:14,hw:15,hh:14,ear:4,nose:6,tail:1,limb:0}],
  ['rabbit','🐰',{bw:15,bh:14,hw:14,hh:13,ear:3,nose:1,tail:3,limb:0}],
  ['bear','🐻',{bw:18,bh:16,hw:16,hh:15,ear:1,nose:1,tail:1,limb:0,belly:1}],
  ['mouse','🐭',{bw:13,bh:12,hw:13,hh:12,ear:13,nose:1,tail:2,limb:0,whisk:1}],
  ['fox','🦊',{bw:14,bh:13,hw:14,hh:13,ear:2,nose:6,tail:3,limb:0,mark:2}],
  ['owl','🦉',{bw:16,bh:16,hw:16,hh:14,merge:1,ear:5,nose:3,tail:4,limb:2,belly:1}],
  ['duck','🦆',{bw:15,bh:14,hw:12,hh:11,neck:4,ear:0,nose:7,tail:4,limb:3,foot:'orange'}],
  ['crocodile','🐊',{bw:19,bh:12,hw:16,hh:10,ear:0,nose:2,back:1,tail:5,limb:3}],
  ['turtle','🐢',{bw:18,bh:14,hw:12,hh:11,neck:4,ear:0,nose:1,back:2,tail:1,limb:5}],
  ['pig','🐷',{bw:18,bh:15,hw:16,hh:14,ear:4,nose:5,tail:6,limb:4}],
  ['cow','🐮',{bw:19,bh:15,hw:16,hh:13,ear:11,nose:5,tail:2,limb:4,mark:3}],
  ['sheep','🐑',{bw:17,bh:15,hw:14,hh:13,ear:4,nose:1,back:3,tail:1,limb:4}],
  ['horse','🐴',{bw:17,bh:14,hw:13,hh:12,neck:6,ear:2,nose:6,back:5,tail:2,limb:4}],
  ['monkey','🐵',{bw:14,bh:13,hw:14,hh:13,ear:13,nose:1,tail:2,limb:0,mark:2}],
  ['lion','🦁',{bw:17,bh:15,hw:14,hh:13,ear:1,nose:1,back:5,tail:1,limb:0}],
  ['tiger','🐯',{bw:18,bh:15,hw:16,hh:14,ear:1,nose:1,tail:2,limb:0,whisk:1,mark:2}],
  ['panda','🐼',{bw:18,bh:16,hw:16,hh:15,ear:1,nose:1,tail:1,limb:0,mark:1,belly:1}],
  ['chicken','🐔',{bw:14,bh:13,hw:11,hh:10,neck:3,ear:9,nose:3,tail:4,limb:3,foot:'orange'}],
  ['goat','🐐',{bw:15,bh:13,hw:12,hh:11,neck:3,ear:12,nose:1,tail:1,limb:4}],
  ['llama','🦙',{bw:14,bh:14,hw:11,hh:10,neck:11,ear:8,nose:1,back:3,tail:1,limb:4}],
  ['squirrel','🐿️',{bw:12,bh:12,hw:13,hh:12,ear:5,nose:1,tail:3,limb:0,belly:1}],
  ['hedgehog','🦔',{bw:17,bh:12,hw:12,hh:11,ear:10,nose:6,back:4,tail:1,limb:0}],
  ['koala','🐨',{bw:16,bh:15,hw:16,hh:14,ear:13,nose:5,tail:0,limb:0}],
  ['flamingo','🦩',{bw:12,bh:12,hw:9,hh:8,neck:15,ear:0,nose:10,tail:4,limb:3,stilt:1,foot:'orange'}],
  ['dragon','🐲',{bw:17,bh:14,hw:14,hh:12,neck:3,ear:7,nose:2,back:1,tail:5,limb:2}],
  ['wolf','🐺',{bw:16,bh:14,hw:15,hh:13,ear:2,nose:6,tail:2,limb:0,mark:2}],
  ['seal','🦭',{bw:17,bh:16,hw:14,hh:13,merge:1,ear:0,nose:1,tail:4,limb:1,sits:1,whisk:1,belly:1}],
  ['kangaroo','🦘',{bw:14,bh:16,hw:12,hh:12,neck:3,ear:3,nose:6,tail:5,limb:0,belly:1}],
  ['sloth','🦥',{bw:16,bh:14,hw:14,hh:13,ear:10,nose:1,tail:1,limb:3,mark:2}],
  ['otter','🦦',{bw:15,bh:14,hw:14,hh:13,ear:10,nose:1,tail:2,limb:0,whisk:1,belly:1}],
  ['skunk','🦨',{bw:15,bh:13,hw:13,hh:12,ear:1,nose:6,back:6,tail:3,limb:0}],
  ['badger','🦡',{bw:17,bh:13,hw:14,hh:12,ear:10,nose:6,tail:1,limb:3,mark:1}],
  ['raccoon','🦝',{bw:15,bh:14,hw:15,hh:13,ear:2,nose:6,tail:2,limb:0,mark:1}],
  ['hamster','🐹',{bw:14,bh:12,hw:14,hh:12,ear:1,nose:1,tail:1,limb:0,belly:1,whisk:1}],
  ['rhino','🦏',{bw:20,bh:15,hw:16,hh:12,ear:10,nose:8,tail:1,limb:4}],
  ['hippo','🦛',{bw:20,bh:15,hw:17,hh:13,ear:10,nose:9,tail:1,limb:4}],
  ['gorilla','🦍',{bw:19,bh:16,hw:15,hh:14,ear:1,nose:5,back:5,tail:0,limb:0,mark:2}],
  ['ram','🐏',{bw:16,bh:14,hw:13,hh:12,ear:16,nose:1,back:3,tail:1,limb:4}],
  ['peacock','🦚',{bw:13,bh:12,hw:10,hh:9,neck:8,ear:15,nose:3,tail:8,limb:3}],
  ['parrot','🦜',{bw:13,bh:14,hw:12,hh:11,neck:2,ear:15,nose:10,tail:2,limb:3,belly:1}],
  ['swan','🦢',{bw:15,bh:13,hw:9,hh:8,neck:16,ear:0,nose:7,tail:4,limb:3}],
  ['beaver','🦫',{bw:16,bh:14,hw:14,hh:13,ear:10,nose:11,tail:7,limb:0}],
  ['lizard','🦎',{bw:16,bh:11,hw:12,hh:10,ear:0,nose:6,back:1,tail:2,limb:3}],
  ['snake','🐍',{bw:17,bh:12,hw:12,hh:11,coil:1,ear:0,nose:1,tail:0,limb:6,forked:1}]
].map(function (r) {
  var o = r[2]; o.w = r[0]; o.e = r[1];
  o.neck = o.neck || 0; o.ear = o.ear || 0; o.nose = o.nose || 0;
  o.back = o.back || 0; o.tail = o.tail || 0; o.limb = o.limb === undefined ? 0 : o.limb;
  o.mark = o.mark || 0; o.belly = o.belly || 0;
  return o;
});

var HATS = [
  { w: 'no hat', e: NONE }, { w: 'cap', e: '🧢' }, { w: 'top hat', e: '🎩' },
  { w: 'crown', e: '👑' }, { w: 'helmet', e: '🪖' }, { w: 'sun hat', e: '👒' },
  { w: 'bow', e: '🎀' }, { w: 'flower crown', e: '🌸' },
  { w: 'graduation cap', e: '🎓' }, { w: 'headphones', e: '🎧' }
];
var CLOTHES = [
  { w: 'nothing', e: NONE }, { w: 'scarf', e: '🧣' }, { w: 'tie', e: '👔' },
  { w: 'medal', e: '🏅' }, { w: 'bell', e: '🔔' }, { w: 'necklace', e: '📿' },
  { w: 'backpack', e: '🎒' }, { w: 'shirt', e: '👕' }, { w: 'dress', e: '👗' },
  { w: 'coat', e: '🧥' }, { w: 'vest', e: '🦺' }
];
var EYES = [
  { w: 'open eyes', e: '👁️' }, { w: 'closed eyes', e: '😴' }, { w: 'big eyes', e: '👀' },
  { w: 'winking', e: '😉' }, { w: 'angry eyes', e: '😠' }, { w: 'glasses', e: '👓' },
  { w: 'sunglasses', e: '🕶️' }, { w: 'heart eyes', e: '😍' },
  { w: 'sleepy eyes', e: '🥱' }, { w: 'surprised eyes', e: '😲' }
];
var SHOES = [
  { w: 'bare feet', e: NONE }, { w: 'boots', e: '👢' }, { w: 'sneakers', e: '👟' },
  { w: 'sandals', e: '🩴' }, { w: 'socks', e: '🧦' }, { w: 'ice skates', e: '⛸️' },
  { w: 'ballet shoes', e: '🩰' }, { w: 'slippers', e: '🥿' }
];
var ITEMS = [
  { w: 'nothing', e: NONE }, { w: 'sword', e: '🗡️' }, { w: 'umbrella', e: '☔' },
  { w: 'flower', e: '🌹' }, { w: 'balloon', e: '🎈' }, { w: 'fish', e: '🐟' },
  { w: 'key', e: '🔑' }, { w: 'book', e: '📕' }, { w: 'mug', e: '☕' },
  { w: 'lantern', e: '🏮' }, { w: 'hammer', e: '🔨' }, { w: 'guitar', e: '🎸' },
  { w: 'kite', e: '🪁' }, { w: 'ice cream', e: '🍦' }, { w: 'wand', e: '✨' },
  { w: 'shield', e: '🛡️' }, { w: 'apple', e: '🍎' }, { w: 'cake', e: '🍰' },
  { w: 'candle', e: '🕯️' }, { w: 'camera', e: '📷' }, { w: 'phone', e: '📱' },
  { w: 'star', e: '⭐' }, { w: 'heart', e: '❤️' }, { w: 'pizza', e: '🍕' }
];
var COMPANIONS = [
  { w: 'alone', e: NONE }, { w: 'bee', e: '🐝' }, { w: 'butterfly', e: '🦋' },
  { w: 'snail', e: '🐌' }, { w: 'frog', e: '🐸' }, { w: 'ladybug', e: '🐞' },
  { w: 'bird', e: '🐦' }, { w: 'crab', e: '🦀' }, { w: 'worm', e: '🪱' },
  { w: 'ant', e: '🐜' }, { w: 'spider', e: '🕷️' }, { w: 'mushroom', e: '🍄' }
];
var SCENES = [
  { w: 'on a plain background', e: NONE }, { w: 'in the snow', e: '❄️' },
  { w: 'at night', e: '🌙' }, { w: 'in the forest', e: '🌲' },
  { w: 'on the beach', e: '🏖️' }, { w: 'in the rain', e: '🌧️' },
  { w: 'in the desert', e: '🏜️' }, { w: 'in space', e: '🌌' },
  { w: 'in the city', e: '🏙️' }, { w: 'in the mountains', e: '🏔️' },
  { w: 'in a meadow', e: '🌷' }, { w: 'underwater', e: '🌊' }
];

var TRAIT_EMOJI = {};
[COLOURS, SPECIES, HATS, CLOTHES, EYES, SHOES, ITEMS, COMPANIONS, SCENES].forEach(function (l) {
  l.forEach(function (o) { TRAIT_EMOJI[o.e] = true; });
});
var SEAL_POOL = V2.EMOJI.filter(function (e) { return !TRAIT_EMOJI[e]; });
var SLOTS = ['creature', 'hat', 'clothes', 'eyes', 'feet', 'hands', 'companion', 'scene'];

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
function ell(b, cx, cy, rx, ry, c) {
  for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      var dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.02) P(b, x, y, c);
    }
}
function ellS(b, cx, cy, rx, ry, c) { ell(b, cx, cy, rx, ry, c); ell(b, W - 1 - cx, cy, rx, ry, c); }
function ellO(b, cx, cy, rx, ry, fill, out) { ell(b, cx, cy, rx + 1, ry + 1, out); ell(b, cx, cy, rx, ry, fill); }
function rect(b, x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) P(b, x, y, c); }
function rectS(b, x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) S(b, x, y, c); }
function line(b, x0, y0, x1, y1, c, th) {
  th = th || 1;
  var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
  for (var i = 0; i <= n; i++) {
    var x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    if (th <= 1) P(b, x, y, c); else ell(b, x, y, th / 2, th / 2, c);
  }
}
function tri(b, ax, ay, dirY, h, c, mirror, slope) {
  for (var i = 0; i < h; i++) {
    var y = ay + dirY * i, hw = Math.round(i * slope);
    for (var x = ax - hw; x <= ax + hw; x++) { if (mirror) S(b, x, y, c); else P(b, x, y, c); }
  }
}
function topAt(b, x) { for (var y = 0; y < H; y++) if (G(b, x, y)) return y; return H; }

/* The volume pass.  Every vertical run of a material's base colour is shaded
   from a rim light at the top down to a shadow at the bottom, then the trailing
   edge of each row is darkened one step because the light sits upper-left. */
function shade(b, materials) {
  var base = {}, i, m;
  for (i = 0; i < materials.length; i++) base[materials[i].base] = materials[i];
  var snap = b.slice();
  for (var x = 0; x < W; x++) {
    var y = 0;
    while (y < H) {
      var c = snap[y * W + x];
      if (!base[c]) { y++; continue; }
      var y0 = y, y1 = y;
      while (y1 + 1 < H && snap[(y1 + 1) * W + x] === c) y1++;
      m = base[c];
      var len = y1 - y0 + 1;
      for (var yy = y0; yy <= y1; yy++) {
        var t = len < 2 ? 0.5 : (yy - y0) / (len - 1);
        var tone = t < 0.10 ? m.rim : t < 0.34 ? m.light : t < 0.68 ? m.base : t < 0.87 ? m.mid : m.shadow;
        if (len <= 2) tone = m.base;
        b[yy * W + x] = tone;
      }
      y = y1 + 1;
    }
  }
  /* trailing edge one step darker, so the blob turns away from the light */
  var snap2 = b.slice();
  for (var yr = 0; yr < H; yr++) {
    for (var xr = W - 1; xr >= 1; xr--) {
      var v = snap2[yr * W + xr];
      if (!v) continue;
      if (snap2[yr * W + xr + 1] || xr === W - 1) {
        for (i = 0; i < materials.length; i++) {
          m = materials[i];
          if (v === m.light) { b[yr * W + xr] = m.base; break; }
          if (v === m.base) { b[yr * W + xr] = m.mid; break; }
          if (v === m.rim) { b[yr * W + xr] = m.light; break; }
        }
      }
      break;
    }
  }
}

function outlineAll(b, col) {
  var snap = b.slice();
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    if (snap[y * W + x] !== null) continue;
    if (G(snap, x - 1, y) || G(snap, x + 1, y) || G(snap, x, y - 1) || G(snap, x, y + 1))
      b[y * W + x] = col;
  }
}


/* ============================== geometry ============================== */

var SCALE = 0.82, BODY_BOT = 56, FOOT_Y = 61;

function geom(sp) {
  var bw = sp.bw * SCALE, bh = sp.bh * SCALE;
  var hw = sp.hw * SCALE, hh = sp.hh * SCALE;
  var neck = Math.min(sp.neck, 13) * SCALE;
  var bcy = BODY_BOT - bh;
  if (sp.sits || sp.coil) bcy += 4;
  var bodyTop = bcy - bh;
  var hcy = bodyTop - neck - hh + (neck ? 2 : 7);
  return { bw: bw, bh: bh, hw: hw, hh: hh, neck: neck, bcy: bcy,
           bodyTop: bodyTop, bodyBot: bcy + bh, hcy: hcy,
           headTop: hcy - hh, headBot: hcy + hh,
           legTop: bcy + bh - 2, footY: FOOT_Y };
}

/* ============================== traits ============================== */

function normalize(s) { return V2.normalize(s); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function art(w) { return 'aeiou'.indexOf(w.charAt(0)) >= 0 ? 'an ' : 'a '; }

function traitsFor(input) {
  var name = normalize(input), d = V2.sha256(name), i;
  var hex = '';
  for (i = 0; i < d.length; i++) hex += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  function F(k) { return (d[k * 2] << 8) | d[k * 2 + 1]; }

  var t = {
    version: 5, name: name, fingerprint: hex,
    colour: F(0) % COLOURS.length,
    species: F(1) % SPECIES.length,
    hat: F(2) % HATS.length,
    hatColour: F(3) % COLOURS.length,
    clothes: F(4) % CLOTHES.length,
    clothesColour: F(5) % COLOURS.length,
    eyes: F(6) % EYES.length,
    shoes: F(7) % SHOES.length,
    shoeColour: F(8) % COLOURS.length,
    item1: F(12) % ITEMS.length,
    item2: F(13) % ITEMS.length,
    companion: F(14) % COMPANIONS.length,
    scene: F(15) % SCENES.length
  };
  var sp = SPECIES[t.species];
  if (sp.sits || sp.coil || sp.limb === 1) t.shoes = 0;   /* nothing to put a shoe on */
  if (sp.limb === 2 || sp.limb === 6) { t.item1 = 0; t.item2 = 0; }
  if (t.item1 === 0) t.item2 = 0;

  var pool = SEAL_POOL.slice();
  t.seal = [];
  for (i = 0; i < 3; i++) t.seal.push(pool.splice(F(9 + i) % pool.length, 1)[0]);

  var C = COLOURS[t.colour], HC = COLOURS[t.hatColour], CC = COLOURS[t.clothesColour],
      SC = COLOURS[t.shoeColour];
  t.mat = {
    coat:    ramp(C.h, C.s, C.l),
    belly:   ramp(C.h, C.s * 0.42, C.l > 70 ? C.l - 17 : C.l + 25),
    hat:     ramp(HC.h, HC.s, HC.l),
    clothes: ramp(CC.h, CC.s, CC.l),
    shoe:    ramp(SC.h, SC.s, SC.l)
  };
  t.ink = hsl(C.h + 12, Math.min(40, C.s * 0.5), Math.max(9, C.l - 44));
  t.pink = '#ff8fb0';
  t.white = '#ffffff';
  t.dark = '#2a2331';
  t.beak = sp.foot === 'orange' ? '#f0a02c' : t.mat.coat.shadow;

  t.words = {
    colour: C.w, species: sp.w, hat: HATS[t.hat].w, hatColour: HC.w,
    clothes: CLOTHES[t.clothes].w, clothesColour: CC.w, eyes: EYES[t.eyes].w,
    shoes: SHOES[t.shoes].w, shoeColour: SC.w,
    item1: ITEMS[t.item1].w, item2: ITEMS[t.item2].w,
    companion: COMPANIONS[t.companion].w, scene: SCENES[t.scene].w
  };
  t.petName = cap(C.w) + ' ' + cap(sp.w);
  t.segments = segmentsOf(t);
  t.phrase = t.segments.map(function (x) { return x.text; }).join('');
  t.emojiGroups = emojiGroupsOf(t);
  t.emojiLine = t.emojiGroups.map(function (g) { return g.emoji; }).join(' ');
  t.shortPhrase = t.petName + (t.hat ? ' in the ' + t.words.hatColour + ' ' + t.words.hat : '')
                + (t.scene ? ', ' + t.words.scene : '');
  return t;
}

/* ============================== the three views ============================== */

function segmentsOf(t) {
  var w = t.words, seg = [];
  function lit(x) { seg.push({ text: x, trait: false }); }
  function slot(x, s) { seg.push({ text: x, trait: true, slot: s }); }
  lit('the ');
  slot(w.colour, 'creature'); lit(' '); slot(w.species, 'creature');
  lit(', ');
  if (t.hat === 0) slot('no hat', 'hat'); else { slot(w.hatColour, 'hat'); lit(' '); slot(w.hat, 'hat'); }
  lit(', ');
  if (t.clothes === 0) slot('wearing nothing', 'clothes');
  else { lit('wearing '); slot(w.clothesColour, 'clothes'); lit(' '); slot(w.clothes, 'clothes'); }
  lit(', '); slot(w.eyes, 'eyes');
  lit(', ');
  if (t.shoes === 0) slot('bare feet', 'feet'); else { slot(w.shoeColour, 'feet'); lit(' '); slot(w.shoes, 'feet'); }
  lit(', holding ');
  if (t.item1 === 0) slot('nothing', 'hands');
  else {
    lit(art(w.item1)); slot(w.item1, 'hands');
    if (t.item2 !== 0) { lit(' and ' + art(w.item2)); slot(w.item2, 'hands'); }
  }
  lit(', ');
  if (t.companion === 0) slot('alone', 'companion');
  else { lit('with ' + art(w.companion)); slot(w.companion, 'companion'); }
  lit(', '); slot(w.scene, 'scene');
  return seg;
}

function emojiGroupsOf(t) {
  var w = t.words;
  return [
    { slot: 'creature', emoji: COLOURS[t.colour].e + SPECIES[t.species].e, says: w.colour + ' ' + w.species },
    { slot: 'hat', emoji: t.hat === 0 ? NONE : COLOURS[t.hatColour].e + HATS[t.hat].e,
      says: t.hat === 0 ? 'no hat' : w.hatColour + ' ' + w.hat },
    { slot: 'clothes', emoji: t.clothes === 0 ? NONE : COLOURS[t.clothesColour].e + CLOTHES[t.clothes].e,
      says: t.clothes === 0 ? 'wearing nothing' : 'wearing ' + w.clothesColour + ' ' + w.clothes },
    { slot: 'eyes', emoji: EYES[t.eyes].e, says: w.eyes },
    { slot: 'feet', emoji: t.shoes === 0 ? NONE : COLOURS[t.shoeColour].e + SHOES[t.shoes].e,
      says: t.shoes === 0 ? 'bare feet' : w.shoeColour + ' ' + w.shoes },
    { slot: 'hands', emoji: t.item1 === 0 ? NONE : ITEMS[t.item1].e + (t.item2 ? ITEMS[t.item2].e : ''),
      says: t.item1 === 0 ? 'holding nothing' : 'holding ' + w.item1 + (t.item2 ? ' and ' + w.item2 : '') },
    { slot: 'companion', emoji: t.companion === 0 ? NONE : COMPANIONS[t.companion].e,
      says: t.companion === 0 ? 'alone' : 'with a ' + w.companion },
    { slot: 'scene', emoji: t.scene === 0 ? NONE : SCENES[t.scene].e, says: w.scene }
  ];
}

function eat(str, list) {
  var best = -1, bl = -1;
  for (var i = 0; i < list.length; i++) {
    var e = list[i].e;
    if (e && str.slice(0, e.length) === e && e.length > bl) { best = i; bl = e.length; }
  }
  return best < 0 ? null : { index: best, rest: str.slice(bl) };
}
function epair(group, list, out, cKey, vKey) {
  if (group === NONE) { out[vKey] = 0; out[cKey] = null; return true; }
  var r = eat(group, COLOURS); if (!r) return false;
  out[cKey] = r.index;
  r = eat(r.rest, list); if (!r || r.rest !== '' || r.index === 0) return false;
  out[vKey] = r.index; return true;
}
function parseEmoji(line) {
  var g = String(line).trim().split(/\s+/);
  if (g.length !== 8) return null;
  var out = {}, r;
  r = eat(g[0], COLOURS); if (!r) return null; out.colour = r.index;
  r = eat(r.rest, SPECIES); if (!r || r.rest !== '') return null; out.species = r.index;
  if (!epair(g[1], HATS, out, 'hatColour', 'hat')) return null;
  if (!epair(g[2], CLOTHES, out, 'clothesColour', 'clothes')) return null;
  r = eat(g[3], EYES); if (!r || r.rest !== '') return null; out.eyes = r.index;
  if (!epair(g[4], SHOES, out, 'shoeColour', 'shoes')) return null;
  if (g[5] === NONE) { out.item1 = 0; out.item2 = 0; }
  else {
    r = eat(g[5], ITEMS); if (!r || r.index === 0) return null; out.item1 = r.index;
    if (r.rest === '') out.item2 = 0;
    else { r = eat(r.rest, ITEMS); if (!r || r.rest !== '' || r.index === 0) return null; out.item2 = r.index; }
  }
  if (g[6] === NONE) out.companion = 0;
  else { r = eat(g[6], COMPANIONS); if (!r || r.rest !== '' || r.index === 0) return null; out.companion = r.index; }
  if (g[7] === NONE) out.scene = 0;
  else { r = eat(g[7], SCENES); if (!r || r.rest !== '' || r.index === 0) return null; out.scene = r.index; }
  return out;
}
function wordIndex(list, word) {
  for (var i = 0; i < list.length; i++) if (list[i].w === word) return i;
  return -1;
}
function wpair(part, noneWord, list, out, cKey, vKey, prefix) {
  if (part === noneWord) { out[vKey] = 0; out[cKey] = null; return true; }
  var m = (prefix ? part.replace(prefix, '') : part).split(' ');
  out[cKey] = wordIndex(COLOURS, m[0]);
  out[vKey] = wordIndex(list, m.slice(1).join(' '));
  return out[cKey] !== -1 && out[vKey] > 0;
}
function parsePhrase(phrase) {
  var s = String(phrase).trim();
  if (s.indexOf('the ') !== 0) return null;
  var b = s.slice(4).split(', ');
  if (b.length !== 8) return null;
  var out = {}, m;
  m = b[0].split(' ');
  out.colour = wordIndex(COLOURS, m[0]); out.species = wordIndex(SPECIES, m.slice(1).join(' '));
  if (!wpair(b[1], 'no hat', HATS, out, 'hatColour', 'hat')) return null;
  if (!wpair(b[2], 'wearing nothing', CLOTHES, out, 'clothesColour', 'clothes', /^wearing /)) return null;
  out.eyes = wordIndex(EYES, b[3]);
  if (!wpair(b[4], 'bare feet', SHOES, out, 'shoeColour', 'shoes')) return null;
  m = b[5].replace(/^holding /, '');
  if (m === 'nothing') { out.item1 = 0; out.item2 = 0; }
  else {
    var hands = m.split(' and ');
    out.item1 = wordIndex(ITEMS, hands[0].replace(/^(an |a )/, ''));
    out.item2 = hands.length > 1 ? wordIndex(ITEMS, hands[1].replace(/^(an |a )/, '')) : 0;
    if (out.item1 <= 0) return null;
  }
  out.companion = b[6] === 'alone' ? 0 : wordIndex(COMPANIONS, b[6].replace(/^with (an |a )/, ''));
  out.scene = wordIndex(SCENES, b[7]);
  for (var k in out) if (out[k] === -1) return null;
  return out;
}

/* ============================== body parts ============================== */

function drawEars(b, t, sp, g, m, sw) {
  var eb = m.coat.base, ip = m.belly.base, top = g.hcy - g.hh * 0.55, hw = g.hw;
  switch (sp.ear) {
    case 1: ellS(b, CX - hw * 0.66, top - 3.2, 4.2, 4.2, eb); ellS(b, CX - hw * 0.70, top - 3.6, 2.3, 2.3, ip); break;
    case 2: tri(b, CX - hw * 0.58, top - 9, 1, 10, eb, true, 0.5);
            tri(b, CX - hw * 0.58, top - 6, 1, 7, ip, true, 0.38); break;
    case 3: ellS(b, CX - hw * 0.40, g.headTop - 7, 3.0, 8.6, eb); ellS(b, CX - hw * 0.40, g.headTop - 7, 1.5, 6.0, ip); break;
    case 4: ellS(b, CX - hw * 0.92, top + 2.5, 3.4, 6.4, m.coat.mid); break;
    case 5: tri(b, CX - hw * 0.52, top - 7, 1, 7, eb, true, 0.55); break;
    case 6: ellS(b, CX - hw * 1.02, g.hcy + 1, 7.0, 8.4, m.coat.mid); ellS(b, CX - hw * 1.02, g.hcy + 1.5, 4.2, 5.2, ip); break;
    case 7: tri(b, CX - hw * 0.52, top - 8, 1, 8, m.belly.light, true, 0.42); break;
    case 8: rectS(b, CX - hw * 0.42 - 1, g.headTop - 6, CX - hw * 0.42, g.headTop + 1, m.coat.mid);
            ellS(b, CX - hw * 0.42 - 0.5, g.headTop - 6.5, 1.8, 1.8, m.coat.mid); break;
    case 9: for (var i = 0; i < 3; i++) ell(b, CX - 3 + i * 3, g.headTop - 2 - (i === 1 ? 1.5 : 0), 2.1, 2.8, '#d8433c'); break;
    case 10: ellS(b, CX - hw * 0.62, top - 1, 2.1, 2.1, m.coat.mid); break;
    case 11: ellS(b, CX - hw * 0.72, top - 1, 3.4, 3.2, eb);
             line(b, CX - hw * 0.78, top - 3, CX - hw * 1.25, top - 7, m.belly.light, 2.6);
             line(b, CX + hw * 0.78, top - 3, CX + hw * 1.25, top - 7, m.belly.light, 2.6); break;
    case 12: ellS(b, CX - hw * 0.92, top + 2.5, 3.0, 5.6, m.coat.mid);
             line(b, CX - hw * 0.52, top - 3, CX - hw * 0.95, top - 9, m.belly.light, 2.6);
             line(b, CX + hw * 0.52, top - 3, CX + hw * 0.95, top - 9, m.belly.light, 2.6); break;
    case 13: ellS(b, CX - hw * 1.10, top - 0.5, 5.6, 5.6, eb); ellS(b, CX - hw * 1.22, top - 0.5, 3.1, 3.1, ip); break;
    case 14: for (var k = 0; k < 3; k++) {
               line(b, CX - hw * 0.5, top - 2, CX - hw * 0.5 - 3 - k * 2, top - 6 - k * 3, m.belly.light, 2.0);
               line(b, CX + hw * 0.5, top - 2, CX + hw * 0.5 + 3 + k * 2, top - 6 - k * 3, m.belly.light, 2.0);
             } break;
    case 15: for (var j = -2; j <= 2; j++) {
               line(b, CX + j * 1.6, g.headTop + 1, CX + j * 3.0, g.headTop - 7, m.coat.mid, 1.4);
               ell(b, CX + j * 3.0, g.headTop - 8, 1.5, 1.5, m.belly.light);
             } break;
    case 16: for (var q = 0; q < 8; q++) {
               S(b, CX - hw * 0.78 - Math.round(q * 0.55), top - 1 + Math.round(q * 0.7), m.belly.light);
               S(b, CX - hw * 0.78 - Math.round(q * 0.55), top + Math.round(q * 0.7), m.belly.light);
             } break;
    case 17: ellS(b, CX - hw * 0.86, top + 1, 2.4, 5.0, m.coat.mid); break;
  }
}

function drawNose(b, t, sp, g, m) {
  var ny = g.hcy + g.hh * 0.50, hw = g.hw, hh = g.hh;
  var pale = m.belly.base, ink = t.dark;
  switch (sp.nose) {
    case 1: ell(b, CX, ny + 1.5, hw * 0.40, hh * 0.30, pale); ell(b, CX, ny - 0.5, 2.0, 1.5, ink); break;
    case 2: ell(b, CX, ny + 3.5, hw * 0.82, hh * 0.44, pale);
            for (var i = -3; i <= 3; i++) P(b, CX + i * 2.2, ny + 5.6, t.white);
            P(b, CX - 2.6, ny + 1.2, ink); P(b, CX + 2.6, ny + 1.2, ink); break;
    case 3: tri(b, Math.round(CX), ny + 6, -1, 6, t.beak, false, 0.7);
            tri(b, Math.round(CX) + 1, ny + 6, -1, 6, t.beak, false, 0.7); break;
    case 4: ell(b, CX, ny, 5.0, 3.8, m.coat.mid);
            line(b, CX, ny + 1, CX + 1, ny + 16, m.coat.mid, 5.2);
            ell(b, CX + 1, ny + 16.5, 3.0, 2.4, m.coat.mid);
            for (var k = 0; k < 6; k++) rect(b, CX - 2.2, ny + 3.5 + k * 2.5, CX + 2.6, ny + 3.5 + k * 2.5, m.coat.shadow);
            P(b, CX - 3, ny + 1, m.coat.shadow); P(b, CX + 4, ny + 1, m.coat.shadow); break;
    case 5: ell(b, CX, ny + 2.2, 5.0, 3.6, pale);
            P(b, CX - 1.8, ny + 2.2, ink); P(b, CX + 1.8, ny + 2.2, ink); break;
    case 6: ell(b, CX, ny + 3.2, hw * 0.36, hh * 0.44, pale); ell(b, CX, ny + 1.0, 2.2, 1.7, ink); break;
    case 7: ell(b, CX, ny + 4.0, 6.0, 2.6, t.beak); ell(b, CX, ny + 2.6, 5.0, 1.6, t.beak); break;
    case 8: ell(b, CX, ny + 2.5, 4.6, 3.0, pale);
            tri(b, Math.round(CX), ny - 3, 1, 5, m.belly.light, false, 0.55);
            tri(b, Math.round(CX) + 1, ny - 3, 1, 5, m.belly.light, false, 0.55); break;
    case 9: ell(b, CX, ny + 4.2, hw * 0.86, hh * 0.50, pale);
            P(b, CX - 3.4, ny + 2.0, ink); P(b, CX + 3.4, ny + 2.0, ink);
            P(b, CX - 4.6, ny + 6.4, t.white); P(b, CX + 4.6, ny + 6.4, t.white); break;
    case 10: ell(b, CX, ny + 2.4, 3.6, 3.4, t.beak);
             tri(b, Math.round(CX), ny + 8, -1, 5, t.beak, false, 0.5);
             tri(b, Math.round(CX) + 1, ny + 8, -1, 5, t.beak, false, 0.5); break;
    case 11: ell(b, CX, ny + 2.6, hw * 0.42, hh * 0.34, pale); ell(b, CX, ny + 0.6, 2.0, 1.5, ink);
             rect(b, CX - 2.2, ny + 4.4, CX - 0.4, ny + 7.4, t.white);
             rect(b, CX + 0.4, ny + 4.4, CX + 2.2, ny + 7.4, t.white); break;
  }
  if (sp.whisk) for (var q = 0; q < 2; q++) {
    line(b, CX - hw * 0.40, ny + 1 + q * 2.4, CX - hw - 4, ny - 1 + q * 3.4, ink, 1);
    line(b, CX + hw * 0.40, ny + 1 + q * 2.4, CX + hw + 4, ny - 1 + q * 3.4, ink, 1);
  }
}

function drawEyes(b, t, sp, g, blink) {
  var hw = g.hw, ex = CX - hw * 0.42, ey = g.hcy + g.hh * 0.06;
  var r = Math.max(3.2, hw * 0.30), ink = t.dark, wht = t.white;
  var kind = t.eyes;

  if (sp.mark === 1) ellS(b, ex, ey - 0.5, r + 2.4, r + 2.8, t.mat.coat.shadow);
  else if (sp.mark === 2) ell(b, CX, ey + 2.5, hw * 0.74, g.hh * 0.56, t.mat.belly.base);
  else if (sp.mark === 3) ellS(b, CX - hw * 0.80, ey + 3.5, 3.6, 3.0, t.mat.belly.base);

  if (blink || kind === 1 || kind === 8) {
    for (var i = -1; i <= 1; i++) { S(b, ex + i, ey, ink); }
    S(b, ex - 2, ey - 1, ink); S(b, ex + 2, ey - 1, ink);
    S(b, ex - 3, ey - 1, ink); S(b, ex + 3, ey - 1, ink);
    if (kind === 8) { S(b, ex - 1, ey + 2, ink); S(b, ex, ey + 2, ink); }
  } else if (kind === 5 || kind === 6) {
    var rim = kind === 5 ? '#7d8794' : t.dark;
    ellS(b, ex, ey, r + 1.6, r + 1.6, rim);
    ellS(b, ex, ey, r + 0.4, r + 0.4, kind === 5 ? wht : '#3d4756');
    if (kind === 5) { ellS(b, ex, ey + 0.4, r * 0.62, r * 0.72, ink); S(b, ex - r * 0.4, ey - r * 0.4, wht); }
    else S(b, ex - r * 0.5, ey - r * 0.5, '#8fa2b8');
    rect(b, CX - hw * 0.16, ey - 0.5, CX + hw * 0.16, ey + 0.5, rim);
  } else if (kind === 7) {
    [[0, -1], [-1, 0], [1, 0], [-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 2], [1, 2], [0, 3], [0, 1], [0, 2]]
      .forEach(function (p) { S(b, ex + p[0], ey + p[1], '#ff5f8a'); });
    S(b, ex - 1, ey, wht);
  } else {
    var rx = r, ry = r * 1.12;
    if (kind === 2) { rx = r * 1.22; ry = r * 1.34; }
    if (kind === 9) { rx = r * 1.28; ry = r * 1.28; }
    if (kind === 4) ry = r * 0.92;
    ellS(b, ex, ey, rx, ry, wht);
    ellS(b, ex, ey + ry * 0.14, rx * 0.72, ry * 0.76, ink);
    S(b, ex - rx * 0.34, ey - ry * 0.36, wht); S(b, ex - rx * 0.34 + 1, ey - ry * 0.36, wht);
    S(b, ex - rx * 0.34, ey - ry * 0.36 + 1, wht); S(b, ex - rx * 0.34 + 1, ey - ry * 0.36 + 1, wht);
    S(b, ex + rx * 0.40, ey + ry * 0.42, wht);
    if (kind === 3) { for (var j = -2; j <= 2; j++) P(b, CX + hw * 0.42 + j, ey - 1, ink); }
    if (kind === 4) for (var q = 0; q <= 4; q++) {
      S(b, ex - 3 + q, ey - ry - 1.6 - Math.round(q * 0.6), ink);
      S(b, ex - 3 + q, ey - ry - 0.6 - Math.round(q * 0.6), ink);
    }
    if (kind === 9) for (var z = -3; z <= 3; z++) { S(b, ex + z, ey - ry - 2, ink); }
  }
  if (sp.mark !== 1 && !blink) ellS(b, CX - hw * 0.86, ey + r + 1.6, 2.6, 1.7, t.pink);
}

function drawLegsFeet(b, t, sp, g, m, sw) {
  if (sp.sits || sp.coil || sp.limb === 6) return;
  var lx = CX - g.bw * 0.40, top = g.legTop, fy = g.footY;
  var legC = sp.foot === 'orange' ? '#e08f24' : m.coat.mid;
  var wide = sp.stilt ? 1.6 : 3.0;
  for (var i = 0; i < 2; i++) {
    var x = i ? W - 1 - lx : lx, d = (sw > 0 ? (i ? 1 : 0) : (i ? 0 : 1));
    ell(b, x, (top + fy) / 2, wide, (fy - top) / 2 + 1, legC);
    var f = fy + 1 - d;
    if (t.shoes === 0) {
      if (sp.limb === 4) ell(b, x, f, 3.4, 2.4, m.belly.light);
      else if (sp.limb === 3 || sp.foot === 'orange') {
        ell(b, x, f + 0.5, 4.0, 1.8, '#e08f24');
        for (var k = -1; k <= 1; k++) P(b, x + k * 2.6, f + 2.2, '#e08f24');
      } else if (sp.limb === 1) ell(b, x, f, 4.6, 2.0, m.coat.mid);
      else ell(b, x, f, 4.2, 2.6, m.coat.mid);
    } else if (t.shoes === 1) { ell(b, x, f - 0.5, 4.2, 3.4, m.shoe.base); rect(b, x - 4, f - 4, x + 4, f - 4, m.shoe.mid); }
    else if (t.shoes === 2) { ell(b, x - 0.5, f, 4.8, 2.6, m.shoe.base); rect(b, x - 4, f - 1, x + 3, f - 1, t.white); }
    else if (t.shoes === 3) { ell(b, x, f + 0.6, 4.4, 1.8, m.shoe.base); rect(b, x - 3, f - 2.4, x + 3, f - 2.4, m.shoe.mid); }
    else if (t.shoes === 4) { ell(b, x, f - 1.5, 3.6, 4.2, m.shoe.base); rect(b, x - 3.6, f - 4.6, x + 3.6, f - 3.6, t.white); }
    else if (t.shoes === 5) { ell(b, x, f - 0.5, 4.0, 2.8, m.shoe.base); rect(b, x - 5, f + 2, x + 5, f + 2.6, '#b8c6d6'); }
    else if (t.shoes === 6) { ell(b, x, f, 4.0, 2.4, m.shoe.base); line(b, x, f - 2, x, f - 7, m.shoe.mid, 1.4); }
    else { ell(b, x, f + 0.2, 4.6, 2.6, m.shoe.base); ell(b, x - 0.5, f - 1.6, 3.2, 1.8, m.shoe.light); }
  }
}

function drawArms(b, t, sp, g, m, sw) {
  var hands = [], ay = g.bcy + g.bh * 0.10;
  if (sp.limb === 2) {
    for (var s = -1; s <= 1; s += 2) {
      var wx = CX + s * (g.bw + 1.5), fl = Math.abs(sw) * 0.9;
      ell(b, wx, ay - fl, 4.4, g.bh * 0.62 - fl, m.coat.mid);
      ell(b, wx, ay + 1 - fl, 2.4, g.bh * 0.40, m.coat.base);
    }
    return [[CX - g.bw - 3, ay + 4], [CX + g.bw + 3, ay + 4]];
  }
  if (sp.limb === 6) return [[CX - g.bw, ay], [CX + g.bw, ay]];
  for (var side = -1; side <= 1; side += 2) {
    var ax = CX + side * (g.bw - 0.5), d = sw * side * 1.1;
    if (sp.limb === 1) { ell(b, ax, ay + 2 + d, 3.0, 5.6, m.coat.mid); hands.push([ax + side * 1.5, ay + 7 + d]); }
    else if (sp.limb === 4) { ell(b, ax, ay + 1 + d, 2.6, 5.0, m.coat.mid); ell(b, ax, ay + 5.6 + d, 2.6, 2.0, m.belly.light); hands.push([ax + side * 1.2, ay + 6 + d]); }
    else { ell(b, ax, ay + 1 + d, 2.8, 5.2, m.coat.base); ell(b, ax, ay + 5.8 + d, 3.0, 3.0, m.coat.mid); hands.push([ax + side * 1.4, ay + 6.2 + d]); }
  }
  return hands;
}

function drawBackTail(b, t, sp, g, m, sw) {
  var tx = CX + g.bw + 2, ty = g.bcy;
  switch (sp.tail) {
    case 1: ell(b, tx + 0.5, ty + 3, 3.0, 3.0, m.coat.mid); break;
    case 2: line(b, tx - 2, ty + 5, tx + 7, ty - 6 - sw, m.coat.mid, 3.4); break;
    case 3: ell(b, tx + 3, ty - 4 - sw, 6.2, 7.4, m.coat.mid); ell(b, tx + 3, ty - 4 - sw, 3.4, 4.4, m.belly.base); break;
    case 4: for (var i = 0; i < 4; i++) line(b, tx - 2, ty + 3, tx + 6 + i, ty - 5 + i * 3 - sw, m.coat.mid, 2.8); break;
    case 5: line(b, tx - 3, ty + 6, tx + 8, ty - 2 - sw, m.coat.mid, 6.0); break;
    case 6: for (var k = 0; k < 9; k++) ell(b, tx + [0, 2, 3.6, 4.2, 3.2, 1.4, 0.2, 0.8, 2.4][k], ty - 5 + [5, 5.8, 4.6, 2.8, 1.2, 0.8, 2, 3.6, 4.6][k], 1.5, 1.5, m.coat.mid); break;
    case 7: ell(b, tx + 4, ty + 5, 6.0, 3.0, m.coat.shadow); break;
    case 8: for (var q = -4; q <= 4; q++) {
              var px = CX + q * 7.0, py = g.bcy - 6 - (4 - Math.abs(q)) * 3.4;
              line(b, CX, g.bcy + 2, px, py, m.coat.mid, 2.6);
              ell(b, px, py - 1, 3.0, 3.0, m.belly.light);
              ell(b, px, py - 1, 1.4, 1.4, m.coat.shadow);
            } break;
  }
}

function drawBackDeco(b, t, sp, g, m, snap) {
  var i;
  function bodyTop(x) { return topAt(snap, x); }
  if (sp.back === 1) for (i = -3; i <= 3; i++) { var rx = CX + i * (g.bw / 3.6); tri(b, rx, bodyTop(rx) - 4, 1, 5, m.coat.shadow, false, 0.7); }
  else if (sp.back === 4) for (i = -7; i <= 7; i++) { var sx = CX + i * (g.bw / 7.4); tri(b, sx, bodyTop(sx) - 6, 1, 7, m.coat.shadow, false, 0.45); }
  else if (sp.back === 3) for (i = -3; i <= 3; i++) { var fx = CX + i * (g.bw / 3.2); ell(b, fx, bodyTop(fx) + 2, 4.6, 4.0, m.coat.light); }
  else if (sp.back === 2) {
    ell(b, CX, g.bcy - 1.5, g.bw * 0.98, g.bh * 0.98, m.coat.shadow);
    ell(b, CX, g.bcy - 1.0, g.bw * 0.82, g.bh * 0.82, m.coat.mid);
    for (i = -2; i <= 2; i++) line(b, CX + i * g.bw * 0.34, g.bcy - g.bh * 0.86,
                                   CX + i * g.bw * 0.52, g.bcy + g.bh * 0.60, m.coat.shadow, 1);
    line(b, CX - g.bw * 0.86, g.bcy - 1, CX + g.bw * 0.86, g.bcy - 1, m.coat.shadow, 1);
  }
  else if (sp.back === 6) for (i = 0; i < 7; i++) ell(b, CX + 4, g.hcy + g.hh - 2 + i * 2.2, 3.0, 2.4, m.belly.light);
  else if (sp.back === 7) ell(b, CX, g.bodyTop + 2, g.bw * 0.62, 5.0, m.coat.base);
}

function drawHat(b, t, m, g) {
  if (t.hat === 0) return;
  var ht = g.headTop, hw = g.hw, c = m.hat, gold = '#f2c53d', i;
  switch (t.hat) {
    case 1: ell(b, CX, ht + 2.4, hw * 0.82, 4.8, c.base); rect(b, CX - hw * 1.02, ht + 4.6, CX + hw * 1.02, ht + 6.0, c.mid); break;
    case 2: rect(b, CX - hw * 0.52, ht - 10, CX + hw * 0.52, ht + 2, c.mid);
            rect(b, CX - hw * 0.52, ht - 3.4, CX + hw * 0.52, ht - 1.6, c.light);
            rect(b, CX - hw * 1.10, ht + 2, CX + hw * 1.10, ht + 3.6, c.mid); break;
    case 3: rect(b, CX - hw * 0.62, ht - 3, CX + hw * 0.62, ht + 1.4, gold);
            for (i = -2; i <= 2; i++) tri(b, CX + i * hw * 0.30, ht - 9, 1, 7, gold, false, 0.5);
            P(b, CX, ht - 1, c.base); P(b, CX - hw * 0.42, ht - 1, c.base); P(b, CX + hw * 0.42, ht - 1, c.base); break;
    case 4: ell(b, CX, ht + 2.0, hw * 0.98, 6.0, c.base); rect(b, CX - hw * 1.0, ht + 4.6, CX + hw * 1.0, ht + 6.2, c.mid);
            rect(b, CX - 1.4, ht - 6, CX + 1.4, ht + 1, c.light); break;
    case 5: ell(b, CX, ht + 1.0, hw * 0.66, 4.4, c.base); ell(b, CX, ht + 4.0, hw * 1.34, 2.6, c.base);
            rect(b, CX - hw * 0.70, ht + 1.4, CX + hw * 0.70, ht + 2.4, c.mid); break;
    case 6: for (i = -1; i <= 1; i += 2) tri(b, CX + i * 6, ht - 1, 1, 6, c.base, false, 0.9);
            ell(b, CX, ht + 0.5, 2.4, 2.4, c.mid); break;
    case 7: for (i = -2; i <= 2; i++) { ell(b, CX + i * 4.6, ht + 1.0, 2.8, 2.8, i % 2 ? c.light : c.base); P(b, CX + i * 4.6, ht + 1.0, gold); } break;
    case 8: rect(b, CX - hw * 0.86, ht - 1.4, CX + hw * 0.86, ht + 0.4, c.mid);
            rect(b, CX - hw * 0.52, ht - 4.4, CX + hw * 0.52, ht - 1.4, c.base);
            line(b, CX + hw * 0.70, ht - 1, CX + hw * 0.86, ht + 5, gold, 1.4);
            ell(b, CX + hw * 0.88, ht + 6, 1.6, 1.6, gold); break;
    default: rect(b, CX - hw * 0.16, ht - 3.6, CX + hw * 0.16, ht - 2.2, c.mid);
             for (i = -1; i <= 1; i += 2) {
               line(b, CX + i * hw * 0.14, ht - 3, CX + i * hw * 0.94, ht + 1.4, c.mid, 2.0);
               ell(b, CX + i * hw * 0.98, ht + 3.4, 3.4, 4.2, c.base);
             } break;
  }
}

function drawClothes(b, t, m, g, sp, sw) {
  if (t.clothes === 0) return;
  var c = m.clothes, ny = Math.max(g.headBot - 2, g.bodyTop), half = g.bw * 0.86, gold = '#f2c53d';
  switch (t.clothes) {
    case 1: rect(b, CX - half, ny, CX + half, ny + 3.0, c.base);
            rect(b, CX + half - 4, ny + 3, CX + half - 1, ny + 11 + sw, c.mid); break;
    case 2: tri(b, Math.round(CX), ny + 1, 1, 4, c.base, false, 0.9);
            ell(b, CX, ny + 8, 3.0, 5.0, c.base);
            rect(b, CX - 3.4, ny - 0.6, CX + 3.4, ny + 0.8, c.mid); break;
    case 3: line(b, CX - 4, ny, CX, ny + 5, c.mid, 1.8); line(b, CX + 4, ny, CX, ny + 5, c.mid, 1.8);
            ell(b, CX, ny + 8, 4.0, 4.0, gold); ell(b, CX, ny + 8, 1.8, 1.8, c.base); break;
    case 4: rect(b, CX - half, ny, CX + half, ny + 2.2, c.base);
            ell(b, CX, ny + 5.6, 3.6, 3.6, gold); P(b, CX, ny + 8, '#7a5a12'); break;
    case 5: for (var i = -5; i <= 5; i++) P(b, CX + i, ny + 2 + Math.abs(i) * 0.6, c.base);
            ell(b, CX, ny + 7.5, 2.4, 2.4, c.light); break;
    case 6: ell(b, CX + g.bw - 1, g.bcy - 1, 5.4, 7.0, c.base);
            rect(b, CX + g.bw - 6, g.bcy - 2.6, CX + g.bw + 4, g.bcy - 1.2, c.mid);
            line(b, CX - 4, ny + 1, CX + 4, ny + 7, c.mid, 2.0); break;
    case 7: ell(b, CX, g.bcy + 1, g.bw * 0.92, g.bh * 0.70, c.base);
            rect(b, CX - g.bw * 0.94, g.bcy - g.bh * 0.62, CX + g.bw * 0.94, g.bcy - g.bh * 0.44, c.mid); break;
    case 8: ell(b, CX, g.bcy + 2, g.bw * 0.90, g.bh * 0.66, c.base);
            for (var k = -2; k <= 2; k++) ell(b, CX + k * g.bw * 0.42, g.bcy + g.bh * 0.62, g.bw * 0.24, 2.6, c.base);
            rect(b, CX - g.bw * 0.62, g.bcy - g.bh * 0.52, CX + g.bw * 0.62, g.bcy - g.bh * 0.34, c.light); break;
    case 9: ell(b, CX, g.bcy + 1, g.bw * 0.98, g.bh * 0.82, c.base);
            rect(b, CX - 1.2, g.bcy - g.bh * 0.70, CX + 1.2, g.bcy + g.bh * 0.70, c.mid);
            for (var q = 0; q < 3; q++) ell(b, CX + 3.0, g.bcy - 4 + q * 5, 1.2, 1.2, gold); break;
    default: ell(b, CX, g.bcy + 1, g.bw * 0.86, g.bh * 0.68, c.base);
             rect(b, CX - g.bw * 0.30, g.bcy - g.bh * 0.70, CX + g.bw * 0.30, g.bcy + g.bh * 0.70, m.coat.base);
             for (var z = 0; z < 3; z++) rect(b, CX - g.bw * 0.86, g.bcy - 4 + z * 5, CX - g.bw * 0.40, g.bcy - 3.4 + z * 5, c.light); break;
  }
}


/* ============================== items, companion, scene ============================== */

var GOLD = '#f2c53d', STEEL = '#c6ced9', WOOD = '#9a6b43', LEAF = '#4c9a52',
    RED = '#d8443c', SKY = '#79c0f0', PALE = '#f3ead6', INK = '#2c2733';

function drawItem(b, t, idx, hand, dir) {
  if (!idx) return;
  var ax = hand[0] + dir * 5.5, ay = hand[1] - 3, i;
  switch (idx) {
    case 1:  line(b, ax, ay + 5, ax, ay - 9, STEEL, 2.6); rect(b, ax - 3.4, ay + 1, ax + 3.4, ay + 1.8, GOLD);
             rect(b, ax - 1, ay + 3.6, ax + 1, ay + 6, WOOD); break;
    case 2:  line(b, ax, ay + 5, ax, ay - 4, WOOD, 1.4);
             P(b, ax, ay + 6, WOOD); P(b, ax + 1, ay + 7, WOOD); P(b, ax + 2, ay + 7, WOOD); P(b, ax + 3, ay + 6, WOOD);
             rect(b, ax - 2, ay - 8, ax + 2, ay - 8, RED); rect(b, ax - 4, ay - 7, ax + 4, ay - 7, RED);
             rect(b, ax - 6, ay - 6, ax + 6, ay - 6, RED); rect(b, ax - 2, ay - 7, ax + 2, ay - 6, PALE);
             rect(b, ax - 6, ay - 5, ax - 5, ay - 5, RED); rect(b, ax - 1, ay - 5, ax + 1, ay - 5, PALE);
             rect(b, ax + 5, ay - 5, ax + 6, ay - 5, RED); break;
    case 3:  line(b, ax, ay + 6, ax, ay - 1, LEAF, 1.4); ell(b, ax - 2.6, ay + 2, 2.0, 1.3, LEAF);
             ell(b, ax, ay - 4, 2.3, 2.3, '#f2839f'); ell(b, ax - 2.9, ay - 2.4, 1.9, 1.9, '#f2839f');
             ell(b, ax + 2.9, ay - 2.4, 1.9, 1.9, '#f2839f'); ell(b, ax - 1.7, ay - 6.5, 1.9, 1.9, '#f2839f');
             ell(b, ax + 1.7, ay - 6.5, 1.9, 1.9, '#f2839f'); ell(b, ax, ay - 4, 1.1, 1.1, GOLD); break;
    case 4:  line(b, ax, ay + 6, ax, ay - 1, INK, 1); ell(b, ax, ay - 6, 4.0, 4.4, RED);
             P(b, ax - 1.6, ay - 7.6, '#ffffff'); P(b, ax - 0.6, ay - 7.6, '#ffffff'); break;
    case 5:  ell(b, ax, ay + 1, 4.6, 2.7, SKY);
             for (i = 0; i < 3; i++) rect(b, ax + 4.4 + i, ay - 1.6 + i, ax + 4.4 + i, ay + 3.8 - i, SKY);
             P(b, ax - 2.2, ay + 0.2, INK); break;
    case 6:  ell(b, ax, ay - 4.2, 3.0, 3.0, GOLD); ell(b, ax, ay - 4.2, 1.2, 1.2, null);
             rect(b, ax - 0.8, ay - 1.4, ax + 0.8, ay + 5, GOLD);
             rect(b, ax, ay + 1.6, ax + 2.6, ay + 1.6, GOLD); rect(b, ax, ay + 5, ax + 2.4, ay + 5, GOLD); break;
    case 7:  rect(b, ax - 4.4, ay - 3.6, ax + 4.4, ay + 3.6, '#3f7f86');
             rect(b, ax - 4.4, ay - 3.6, ax - 2.6, ay + 3.6, '#2b5a60');
             rect(b, ax - 1.4, ay - 1.6, ax + 3.2, ay - 1.6, '#ffffff');
             rect(b, ax - 1.4, ay + 0.8, ax + 3.2, ay + 0.8, '#ffffff'); break;
    case 8:  rect(b, ax - 3, ay - 3.2, ax + 2, ay + 3.2, PALE);
             rect(b, ax - 3, ay - 3.2, ax + 2, ay - 2, '#a9542f');
             ell(b, ax + 4.2, ay + 0.2, 2.1, 2.1, PALE); ell(b, ax + 4.2, ay + 0.2, 0.9, 0.9, null); break;
    case 9:  line(b, ax, ay + 5, ax, ay + 1.4, STEEL, 1.2);
             rect(b, ax - 3, ay - 4.2, ax + 3, ay + 0.8, '#e0483c');
             rect(b, ax - 1.8, ay - 3.2, ax + 1.8, ay - 0.2, '#ffd98a');
             rect(b, ax - 3.6, ay - 5.4, ax + 3.6, ay - 4.4, '#8d2f26'); break;
    case 10: line(b, ax, ay + 6, ax, ay - 1.4, WOOD, 2.2);
             rect(b, ax - 4, ay - 5.8, ax + 4, ay - 2.2, STEEL);
             rect(b, ax - 4, ay - 5.8, ax - 1.2, ay - 2.2, '#8e97a4'); break;
    case 11: ell(b, ax, ay + 2, 4.0, 5.0, WOOD); ell(b, ax, ay + 2.4, 1.5, 1.5, '#3a2a18');
             line(b, ax, ay - 2.8, ax, ay - 9, '#6f4a2c', 1.8);
             for (i = 0; i < 3; i++) P(b, ax - 1 + i, ay - 10, STEEL); break;
    case 12: ell(b, ax, ay - 3.2, 5.0, 5.0, '#e08a3c');
             line(b, ax - 4.6, ay - 3.2, ax + 4.6, ay - 3.2, '#9c5a20', 1);
             line(b, ax, ay - 8, ax, ay + 1.6, '#9c5a20', 1);
             line(b, ax, ay + 1.8, ax - dir, ay + 6, INK, 1); break;
    case 13: tri(b, Math.round(ax), ay + 6, -1, 6, '#c98d4e', false, 0.45);
             ell(b, ax, ay - 2, 3.5, 3.3, PALE); ell(b, ax - 1.2, ay - 4.4, 2.5, 2.3, '#f0a6c0'); break;
    case 14: line(b, ax, ay + 6, ax, ay - 2, WOOD, 1.4);
             [[0,0],[-1,1],[1,1],[0,1],[0,2],[-2,1],[2,1],[0,-1],[-1,-1],[1,-1]]
               .forEach(function (q) { P(b, ax + q[0], ay - 5 + q[1], GOLD); }); break;
    case 15: ell(b, ax, ay, 4.4, 5.6, STEEL); ell(b, ax, ay, 2.7, 3.6, '#4a6fb5');
             ell(b, ax, ay, 1.1, 1.4, GOLD); break;
    case 16: ell(b, ax, ay + 1, 3.6, 3.4, '#d8433c'); ell(b, ax - 1.2, ay - 0.4, 1.2, 1.0, '#f08a80');
             line(b, ax, ay - 2.4, ax + 0.6, ay - 5, '#6f4a2c', 1); ell(b, ax + 2.4, ay - 4.6, 2.0, 1.2, LEAF); break;
    case 17: rect(b, ax - 4, ay + 0.4, ax + 4, ay + 4, PALE); rect(b, ax - 4, ay - 2.2, ax + 4, ay + 0.4, '#f3b6c8');
             rect(b, ax - 4, ay - 3.4, ax + 4, ay - 2.6, '#ffffff'); ell(b, ax, ay - 4.6, 1.4, 1.4, RED); break;
    case 18: rect(b, ax - 1.8, ay - 1, ax + 1.8, ay + 5.4, PALE); rect(b, ax - 1.8, ay - 1, ax - 0.6, ay + 5.4, '#e0d3b4');
             line(b, ax, ay - 1.4, ax, ay - 3, '#8e7a4a', 1); ell(b, ax, ay - 4.6, 1.6, 2.4, GOLD);
             ell(b, ax, ay - 5.2, 0.8, 1.2, '#fff0b0'); break;
    case 19: rect(b, ax - 4.4, ay - 2.4, ax + 4.4, ay + 3.4, '#4c4a55'); rect(b, ax - 1.6, ay - 4, ax + 1.6, ay - 2.4, '#4c4a55');
             ell(b, ax, ay + 0.4, 2.6, 2.6, '#8fa2b8'); ell(b, ax, ay + 0.4, 1.3, 1.3, '#2a3340');
             P(b, ax + 3.2, ay - 1.4, '#ffffff'); break;
    case 20: rect(b, ax - 2.8, ay - 5, ax + 2.8, ay + 5, '#3a3f4a');
             rect(b, ax - 2, ay - 4, ax + 2, ay + 3, '#7fd0e8'); ell(b, ax, ay + 4.2, 0.9, 0.9, '#8e97a4'); break;
    case 21: [[0,-5],[0,-4],[-1,-3],[0,-3],[1,-3],[-2,-2],[-1,-2],[0,-2],[1,-2],[2,-2],
              [-4,-1],[-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[3,-1],[4,-1],
              [-3,0],[-2,0],[-1,0],[0,0],[1,0],[2,0],[3,0],
              [-2,1],[-1,1],[0,1],[1,1],[2,1],[-3,2],[-1,2],[1,2],[3,2],[-4,3],[4,3]]
               .forEach(function (q) { P(b, ax + q[0], ay + q[1], GOLD); }); break;
    case 22: ell(b, ax - 2.2, ay - 1.6, 2.6, 2.6, '#e8465c'); ell(b, ax + 2.2, ay - 1.6, 2.6, 2.6, '#e8465c');
             tri(b, Math.round(ax), ay + 4.4, -1, 5, '#e8465c', false, 0.95);
             P(b, ax - 2.6, ay - 2.6, '#ff9aa8'); break;
    default: tri(b, Math.round(ax), ay + 5, -1, 7, '#e8b84b', false, 0.6);
             rect(b, ax - 4.2, ay - 2.6, ax + 4.2, ay - 1, '#d8433c');
             P(b, ax - 2, ay + 0.4, '#a83228'); P(b, ax + 2, ay + 1.4, '#a83228'); P(b, ax, ay + 2.8, '#a83228'); break;
  }
}

function drawCompanion(b, t, sw) {
  if (!t.companion) return;
  var flies = (t.companion === 1 || t.companion === 2 || t.companion === 6);
  var gx = 12, gy = flies ? 30 : 60, blk = '#241f2b', wht = '#ffffff', i;
  switch (t.companion) {
    case 1: ell(b, gx - 4.4, gy - 3.4 - sw, 2.6, 1.5, '#e8f2ff');     /* wings out to the side */
            ell(b, gx + 4.4, gy - 3.4 + sw, 2.6, 1.5, '#e8f2ff');
            ell(b, gx, gy, 4.2, 3.2, '#f2c33d');
            rect(b, gx - 1.8, gy - 2.8, gx - 0.6, gy + 2.8, blk);
            rect(b, gx + 1.4, gy - 2.8, gx + 2.6, gy + 2.8, blk);
            ell(b, gx - 4.0, gy - 0.4, 1.6, 1.6, blk);                 /* head */
            P(b, gx - 4.6, gy - 2.6, blk); P(b, gx - 3.4, gy - 2.8, blk);
            P(b, gx + 4.6, gy + 1.2, blk); break;
    case 2: ell(b, gx - 3.4, gy - 2.4 - sw, 3.4, 4.0, '#e86ea8'); ell(b, gx + 3.4, gy - 2.4 + sw, 3.4, 4.0, '#e86ea8');
            ell(b, gx - 3.4, gy + 1.8, 2.4, 2.2, '#f7b3d2'); ell(b, gx + 3.4, gy + 1.8, 2.4, 2.2, '#f7b3d2');
            rect(b, gx - 0.7, gy - 5.4, gx + 0.7, gy + 3.4, blk); break;
    case 3: ell(b, gx - 3.4, gy + 2.4, 4.6, 2.0, '#d9c08d'); ell(b, gx + 1.2, gy - 0.6, 4.0, 4.0, '#b5762f');
            ell(b, gx + 1.2, gy - 0.6, 2.0, 2.0, '#d9a05a');
            P(b, gx - 5.6, gy - 1.4, '#d9c08d'); P(b, gx - 5.6, gy - 2.6, '#d9c08d'); break;
    case 4: ell(b, gx, gy + 0.6, 4.4, 3.6, '#4fa84f');
            ell(b, gx - 2.2, gy - 3.0, 2.1, 2.1, wht); ell(b, gx + 2.2, gy - 3.0, 2.1, 2.1, wht);
            P(b, gx - 2.2, gy - 3.0, blk); P(b, gx + 2.2, gy - 3.0, blk);
            rect(b, gx - 2.2, gy + 2.4, gx + 2.2, gy + 2.4, '#2f7a34'); break;
    case 5: ell(b, gx, gy, 4.0, 3.5, '#d43b34'); rect(b, gx - 0.6, gy - 3.5, gx + 0.6, gy + 3.5, blk);
            ell(b, gx, gy - 3.8, 2.2, 1.8, blk); P(b, gx - 2.2, gy - 0.4, blk); P(b, gx + 2.2, gy + 1.2, blk); break;
    case 6: ell(b, gx, gy, 3.8, 3.4, '#5b8fd4'); ell(b, gx - 1, gy - 3.6, 2.7, 2.5, '#5b8fd4');
            P(b, gx - 4.4, gy - 3.4, '#f2a33d'); P(b, gx - 5.4, gy - 3.4, '#f2a33d'); P(b, gx - 4.4, gy - 2.4, '#f2a33d');
            P(b, gx - 1, gy - 4.0, blk); ell(b, gx + 1.6, gy + 0.4, 2.0, 1.4, '#3f6ba8'); break;
    case 7: ell(b, gx, gy + 0.6, 4.4, 2.9, '#e0562f');
            for (i = -1; i <= 1; i += 2) {
              ell(b, gx + i * 6.0, gy - 1.8 - (i > 0 ? sw : -sw), 2.2, 2.0, '#e0562f');
              P(b, gx + i * 4.0, gy - 0.4, '#e0562f');
              rect(b, gx + i * 2.8, gy + 2.8, gx + i * 3.6, gy + 2.8, '#e0562f');
            }
            P(b, gx - 1.8, gy - 1.8, blk); P(b, gx + 1.8, gy - 1.8, blk); break;
    case 8: for (i = 0; i < 6; i++) ell(b, gx - 5 + i * 2.2, gy + (i % 2 ? 1 : -1), 1.7, 1.7, '#e08a9a');
            P(b, gx + 6, gy - 1.6, blk); break;
    case 9: ell(b, gx, gy, 2.4, 2.0, '#5a4032'); ell(b, gx - 3.4, gy - 0.6, 1.7, 1.7, '#5a4032');
            ell(b, gx + 3.0, gy + 0.4, 2.0, 1.7, '#5a4032');
            for (i = -1; i <= 1; i++) { P(b, gx + i, gy + 2.4, blk); P(b, gx + i, gy - 2.4, blk); }
            P(b, gx - 4.4, gy - 2.2, blk); break;
    case 10: ell(b, gx, gy, 3.2, 2.8, '#3b3540');
             for (i = -1; i <= 1; i += 2) {
               line(b, gx + i * 2.4, gy - 1, gx + i * 6.4, gy - 3.4, '#3b3540', 1);
               line(b, gx + i * 2.6, gy + 0.6, gx + i * 6.6, gy + 1.4, '#3b3540', 1);
               line(b, gx + i * 2.4, gy + 2, gx + i * 5.6, gy + 4.4, '#3b3540', 1);
             }
             P(b, gx - 1.2, gy - 1, '#ff5f5f'); P(b, gx + 1.2, gy - 1, '#ff5f5f'); break;
    default: rect(b, gx - 1.6, gy + 0.4, gx + 1.6, gy + 4, PALE);
             ell(b, gx, gy - 0.6, 5.0, 3.4, '#d8433c');
             ell(b, gx - 2.2, gy - 1.6, 1.3, 1.0, wht); ell(b, gx + 1.8, gy - 0.4, 1.1, 0.9, wht); break;
  }
}

var SKYC = ['', '#cfe4f2', '#1b2340', '#bcd9e8', '#bfe6f5', '#aab4c0', '#f6d9a0', '#0d0d1c',
            '#f0cba0', '#c9dcea', '#bfe3f0', '#1f6f96'];
var LANDC = ['', '#f2f7fb', '#2a3358', '#4b7a46', '#f0dfae', '#7d8794', '#e3b96f', '#1a1830',
             '#8d8a94', '#8d9aa6', '#68b055', '#2b8fae'];
var HORIZON = 62;

function renderScene(t) {
  var b = new Array(W * H).fill(null), i, x, y;
  if (!t.scene) return b;
  rect(b, 0, 0, W - 1, HORIZON - 1, SKYC[t.scene]);
  rect(b, 0, HORIZON, W - 1, H - 1, LANDC[t.scene]);
  switch (t.scene) {
    case 1: for (i = 0; i < 18; i++) P(b, (i * 13 + 3) % W, (i * 17 + 5) % (HORIZON - 6), '#ffffff');
            for (i = 0; i < 6; i++) ell(b, i * 14 + 5, HORIZON + 2, 6, 2.4, '#ffffff'); break;
    case 2: for (i = 0; i < 24; i++) P(b, (i * 11 + 2) % W, (i * 23 + 3) % (HORIZON - 8), '#e8ecff');
            ell(b, 58, 11, 7, 7, '#f3e9c0'); ell(b, 54, 8, 6.2, 6.2, SKYC[2]); break;
    case 3: for (i = 0; i < 7; i++) { var tx = i * 11 + 4, th = 14 + (i % 3) * 6;
              tri(b, tx, HORIZON - th, 1, th, '#2f5c34', false, 0.42);
              rect(b, tx - 1, HORIZON - 2, tx + 1, HORIZON, '#4a3722'); } break;
    case 4: rect(b, 0, HORIZON - 9, W - 1, HORIZON - 1, '#5bbcd8');
            for (i = 0; i < 9; i++) rect(b, i * 9, HORIZON - 7 + (i % 2) * 2, i * 9 + 4, HORIZON - 7 + (i % 2) * 2, '#d8f2fb');
            ell(b, 62, 10, 5.6, 5.6, '#ffe27a'); break;
    case 5: for (i = 0; i < 30; i++) { x = (i * 7 + 2) % W; y = (i * 19) % (HORIZON - 8);
              line(b, x, y, x - 2, y + 6, '#dbe6f2', 1); }
            ell(b, 16, 9, 10, 4.4, '#8e97a4'); ell(b, 27, 8, 8, 4, '#8e97a4'); break;
    case 6: ell(b, 14, HORIZON + 4, 18, 8, '#d2a75c'); ell(b, 56, HORIZON + 6, 20, 9, '#d2a75c');
            ell(b, 60, 11, 5.6, 5.6, '#f7a94b'); break;
    case 7: for (i = 0; i < 30; i++) P(b, (i * 9 + 4) % W, (i * 21 + 2) % (HORIZON - 4), i % 4 ? '#cfd4ff' : '#ffffff');
            ell(b, 13, 13, 8, 8, '#7a5cc4'); ell(b, 11, 11, 3.4, 3.4, '#9d7ee0'); break;
    case 8: for (i = 0; i < 6; i++) { var bx = i * 12 + 2, bh = 16 + ((i * 7) % 20);
              rect(b, bx, HORIZON - bh, bx + 8, HORIZON - 1, i % 2 ? '#5a5866' : '#6b6877');
              for (var wy = HORIZON - bh + 3; wy < HORIZON - 3; wy += 4)
                for (var wx = bx + 2; wx < bx + 7; wx += 3) P(b, wx, wy, '#ffe9a8'); } break;
    case 9: for (i = 0; i < 3; i++) { var mx = i * 26 + 6, mh = 26 + (i % 2) * 8;
              tri(b, mx, HORIZON - mh, 1, mh, '#6b7a8c', false, 0.62);
              tri(b, mx, HORIZON - mh, 1, Math.round(mh * 0.34), '#eef3f8', false, 0.62); } break;
    case 10: for (i = 0; i < 14; i++) { x = (i * 11 + 4) % W;
               line(b, x, HORIZON, x, HORIZON - 5 - (i % 3) * 2, '#3f8a3f', 1);
               ell(b, x, HORIZON - 7 - (i % 3) * 2, 1.9, 1.9, ['#e86a8a', '#f2d24b', '#c98ae0'][i % 3]); } break;
    default: for (i = 0; i < 9; i++) { x = (i * 9 + 3) % W; y = (i * 13 + 4) % (HORIZON - 10);
               ell(b, x, y, 1.6, 1.6, '#8fdcf0'); ell(b, x, y, 0.7, 0.7, SKYC[11]); }
             for (i = 0; i < 5; i++) { var sx = i * 16 + 6;
               line(b, sx, HORIZON, sx + 2, HORIZON - 12 - (i % 3) * 4, '#3fa36f', 2.2); } break;
  }
  return b;
}

/* ============================== render ============================== */

function render(t, phase, blink) {
  var b = new Array(W * H).fill(null);
  var sp = SPECIES[t.species], g = geom(sp), m = t.mat;
  var sw = [0, 1, 0, -1][phase & 3], i;

  drawBackTail(b, t, sp, g, m, sw);
  drawLegsFeet(b, t, sp, g, m, sw);

  if (sp.coil) {                                   /* a snake stacks instead of standing */
    ell(b, CX, g.bcy + g.bh * 0.55, g.bw, g.bh * 0.52, m.coat.base);
    ell(b, CX + 2, g.bcy - g.bh * 0.30, g.bw * 0.74, g.bh * 0.42, m.coat.base);
  } else {
    ell(b, CX, g.bcy, g.bw, g.bh, m.coat.base);
  }
  if (g.neck > 0) ell(b, CX, (g.headBot + g.bodyTop) / 2, Math.max(4.4, g.hw * 0.50),
                      (g.bodyTop - g.headBot) / 2 + 3.5, m.coat.base);
  if (sp.belly) ell(b, CX, g.bcy + g.bh * 0.24, g.bw * 0.68, g.bh * 0.70, m.belly.base);

  var bodySnap = b.slice();                        /* the back rides the body, not the head */
  drawBackDeco(b, t, sp, g, m, bodySnap);
  var hands = drawArms(b, t, sp, g, m, sw);
  drawEars(b, t, sp, g, m, sw);
  ell(b, CX, g.hcy, g.hw, g.hh, m.coat.base);
  if (sp.back === 5) ell(b, CX, g.hcy + 1, g.hw + 5.0, g.hh + 4.6, m.coat.mid);
  if (sp.back === 5) ell(b, CX, g.hcy, g.hw, g.hh, m.coat.base);
  drawClothes(b, t, m, g, sp, sw);
  drawHat(b, t, m, g);

  shade(b, [m.coat, m.belly, m.hat, m.clothes, m.shoe]);

  if (sp.belly) for (i = -1; i <= 1; i++)             /* fluff, the detail that sells it */
    line(b, CX + i * g.bw * 0.30 - 2, g.bcy + g.bh * 0.30, CX + i * g.bw * 0.30 + 2, g.bcy + g.bh * 0.34, m.belly.mid, 1);

  drawNose(b, t, sp, g, m);
  drawEyes(b, t, sp, g, blink);

  var extras = new Array(W * H).fill(null);
  if (t.item1) drawItem(extras, t, t.item1, hands[1], 1);
  if (t.item2) drawItem(extras, t, t.item2, hands[0], -1);
  drawCompanion(extras, t, sw);
  outlineAll(extras, t.ink);
  for (i = 0; i < extras.length; i++) if (extras[i]) b[i] = extras[i];

  outlineAll(b, t.ink);
  return b;
}

function renderFull(t, phase, blink) {
  var bg = renderScene(t), fg = render(t, phase, blink);
  for (var i = 0; i < bg.length; i++) if (fg[i]) bg[i] = fg[i];
  return bg;
}
function motion(t, f) {
  var s = Math.sin(f * Math.PI * 2);
  return { dx: 0, dy: s * 1.8, sx: 1, sy: 1, rot: 0 };
}

function spaceSize() {
  var hatOpts = 1 + (HATS.length - 1) * COLOURS.length;
  var clothOpts = 1 + (CLOTHES.length - 1) * COLOURS.length;
  var shoeOpts = 1 + (SHOES.length - 1) * COLOURS.length;
  var n = ITEMS.length - 1, handOpts = 1 + n + n * n, per = 0;
  SPECIES.forEach(function (sp) {
    var noFeet = sp.sits || sp.coil || sp.limb === 1;
    var noHands = sp.limb === 2 || sp.limb === 6;
    per += (noFeet ? 1 : shoeOpts) * (noHands ? 1 : handOpts);
  });
  var identities = COLOURS.length * hatOpts * clothOpts * EYES.length *
                   COMPANIONS.length * SCENES.length * per;
  var p = SEAL_POOL.length;
  return { identities: identities, seals: p * (p - 1) * (p - 2), pool: p };
}

var api = {
  W: W, H: H, CX: CX, NONE: NONE, SLOTS: SLOTS, HORIZON: HORIZON, version: 5,
  normalize: normalize, traitsFor: traitsFor, render: render, renderScene: renderScene,
  renderFull: renderFull, motion: motion, geom: geom, spaceSize: spaceSize,
  segmentsOf: segmentsOf, emojiGroupsOf: emojiGroupsOf,
  parseEmoji: parseEmoji, parsePhrase: parsePhrase,
  COLOURS: COLOURS, SPECIES: SPECIES, HATS: HATS, CLOTHES: CLOTHES, EYES: EYES,
  SHOES: SHOES, ITEMS: ITEMS, COMPANIONS: COMPANIONS, SCENES: SCENES, SEAL_POOL: SEAL_POOL
};
if (node) module.exports = api; else root.Wordpet5 = api;
})(typeof self !== 'undefined' ? self : this);
