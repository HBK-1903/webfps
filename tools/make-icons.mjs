// App icons, generated deterministically from the game's own palette.
//
// No image library is available (and no network), so this writes PNG by hand:
// a plain RGBA encoder plus zlib for the IDAT stream, then downsamples a 4x
// supersampled canvas for smooth edges. The same shapes are also packed into a
// Windows .ico (PNG-in-ICO, supported since Vista).
//
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Palette — must match src/ui/styles.css.
const BG = [0x0b, 0x0f, 0x12];
const ACCENT = [0x4f, 0xd1, 0xc5];
const TEXT = [0xdb, 0xe7, 0xea];
const WARM = [0xe0, 0x8a, 0x4a];

const SS = 4; // supersampling factor

function createCanvas(size) {
  return { size, px: new Float32Array(size * SS * size * SS * 4) };
}

function plot(c, x, y, color, alpha = 1) {
  const w = c.size * SS;
  if (x < 0 || y < 0 || x >= w || y >= w) return;
  const i = (y * w + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  const dstA = c.px[i + 3];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let k = 0; k < 3; k++) {
    c.px[i + k] = (color[k] * a + c.px[i + k] * dstA * (1 - a)) / outA;
  }
  c.px[i + 3] = outA;
}

/** Filled circle in canvas units (1 unit = 1 final pixel). */
function circle(c, cx, cy, r, color, alpha = 1) {
  const R = r * SS;
  const CX = cx * SS;
  const CY = cy * SS;
  const x0 = Math.floor(CX - R);
  const x1 = Math.ceil(CX + R);
  const y0 = Math.floor(CY - R);
  const y1 = Math.ceil(CY + R);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      if (d <= R) plot(c, x, y, color, alpha);
    }
  }
}

/** Axis-aligned rounded bar, used for the crosshair ticks. */
function bar(c, cx, cy, len, thick, vertical, color, alpha = 1) {
  const halfL = (len / 2) * SS;
  const halfT = (thick / 2) * SS;
  const CX = cx * SS;
  const CY = cy * SS;
  const x0 = Math.floor(CX - (vertical ? halfT : halfL));
  const x1 = Math.ceil(CX + (vertical ? halfT : halfL));
  const y0 = Math.floor(CY - (vertical ? halfL : halfT));
  const y1 = Math.ceil(CY + (vertical ? halfL : halfT));
  const r = halfT;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Rounded caps: clamp the sample into the bar's core rectangle.
      const px = Math.max(CX - (vertical ? 0 : halfL - r), Math.min(CX + (vertical ? 0 : halfL - r), x + 0.5));
      const py = Math.max(CY - (vertical ? halfL - r : 0), Math.min(CY + (vertical ? halfL - r : 0), y + 0.5));
      if (Math.hypot(x + 0.5 - px, y + 0.5 - py) <= r) plot(c, x, y, color, alpha);
    }
  }
}

function fillBackground(c, color) {
  const w = c.size * SS;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) plot(c, x, y, color, 1);
  }
}

/** Subtle diagonal haze so the icon does not read as a flat black square. */
function haze(c, size) {
  const w = size * SS;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (2 * w);
      plot(c, x, y, ACCENT, 0.05 * (1 - t) + 0.02);
    }
  }
}

/** The mark: targeting ring + four ticks + centre dot. */
function mark(c, size, scale) {
  const s = size * scale;
  const cx = size / 2;
  const cy = size / 2;
  const ring = s * 0.30;
  const stroke = Math.max(1.5, s * 0.038);

  circle(c, cx, cy, ring, ACCENT, 1);
  circle(c, cx, cy, ring - stroke, BG, 1);
  // Re-tint the inner disc so the haze survives inside the ring.
  circle(c, cx, cy, ring - stroke, ACCENT, 0.04);

  const tickLen = s * 0.14;
  const gap = ring + stroke * 0.9;
  const thick = Math.max(1.5, s * 0.030);
  for (const vertical of [true, false]) {
    for (const dir of [-1, 1]) {
      const off = dir * (gap + tickLen / 2);
      bar(c, cx + (vertical ? 0 : off), cy + (vertical ? off : 0), tickLen, thick, vertical, ACCENT, 1);
    }
  }
  circle(c, cx, cy, Math.max(2, s * 0.052), TEXT, 1);
  circle(c, cx, cy, Math.max(1, s * 0.022), WARM, 1);
}

function downsample(c) {
  const size = c.size;
  const w = size * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * w) + (x * SS + sx)) * 4;
          const pa = c.px[i + 3];
          r += c.px[i] * pa;
          g += c.px[i + 1] * pa;
          b += c.px[i + 2] * pa;
          a += pa;
        }
      }
      const o = (y * size + x) * 4;
      const n = SS * SS;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// --- minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows .ico with a single 256x256 PNG payload. */
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 means 256
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

function render(size, { maskable = false } = {}) {
  const c = createCanvas(size);
  fillBackground(c, BG);
  haze(c, size);
  // Maskable icons must keep the mark inside the central 80% safe zone.
  // 0.78 keeps the marks off the edge: an icon that touches its own border
  // reads as clipped, even when the geometry is perfectly centred.
  mark(c, size, maskable ? 0.66 : 0.78);
  return downsample(c);
}

const out = {
  'icons/icon-192.png': encodePng(192, render(192)),
  'icons/icon-256.png': encodePng(256, render(256)),
  'icons/icon-512.png': encodePng(512, render(512)),
  'icons/maskable-512.png': encodePng(512, render(512, { maskable: true })),
  'build/icon.ico': encodeIco(encodePng(256, render(256))),
  'build/icon.png': encodePng(512, render(512)),
};

for (const [rel, buf] of Object.entries(out)) {
  const abs = path.join(ROOT, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  console.log(`  ✓ ${rel}  (${(buf.length / 1024).toFixed(1)} KB)`);
}
