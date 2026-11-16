// The Ocean in a Teacup — make.fun ai-excited-01
// A whale leaps out of a tiny teacup on a night sea; its spray turns
// into stars on the way up to the full moon. Drawn from scratch with
// only the Node standard library: a hand-rolled PNG encoder and a
// small software rasterizer. Fully deterministic: same bytes every run.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Deterministic random numbers (mulberry32). No Math.random, no Date.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Framebuffer: RGB, row-major. All drawing blends onto it.
// ---------------------------------------------------------------------------
const px = new Uint8Array(W * H * 3);

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    px[i] = clamp255(r);
    px[i + 1] = clamp255(g);
    px[i + 2] = clamp255(b);
    return;
  }
  px[i] = clamp255(px[i] * (1 - a) + r * a);
  px[i + 1] = clamp255(px[i + 1] * (1 - a) + g * a);
  px[i + 2] = clamp255(px[i + 2] * (1 - a) + b * a);
}

// Smooth edge: 1 well inside, 0 outside, over `soft` pixels of falloff.
function edgeAlpha(d: number, r: number, soft: number): number {
  const t = (r - d) / soft;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// Filled disc with a soft rim.
function disc(cx: number, cy: number, r: number, c: number[], a: number): void {
  const x0 = Math.max(0, Math.floor(cx - r - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const al = a * edgeAlpha(d, r, 1.4);
      if (al > 0) blend(x, y, c[0], c[1], c[2], al);
    }
  }
}

// Filled ellipse with a soft rim.
function ellipse(cx: number, cy: number, rx: number, ry: number, c: number[], a: number): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const al = a * edgeAlpha(d, 1, 1.4 / Math.max(rx, ry));
      if (al > 0) blend(x, y, c[0], c[1], c[2], al);
    }
  }
}

// Thick polyline: a chain of discs along the points.
function polyline(pts: number[][], w: number, c: number[], a: number): void {
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s];
    const [x1, y1] = pts[s + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / (w * 0.4)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c, a);
    }
  }
}

// Scanline polygon fill (even-odd), no anti-aliasing on the edge itself;
// callers that want soft edges draw over the rim afterwards.
function poly(pts: number[][], c: number[], a: number): void {
  let minY = H - 1;
  let maxY = 0;
  for (const p of pts) {
    minY = Math.min(minY, Math.floor(p[1]));
    maxY = Math.max(maxY, Math.ceil(p[1]));
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  const n = pts.length;
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
        xs.push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blend(x, y, c[0], c[1], c[2], a);
    }
  }
}

// ---------------------------------------------------------------------------
// PNG encoder: 8-bit RGB, filter 0, single IDAT, hand-written CRC32.
// ---------------------------------------------------------------------------
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const SKY_TOP = [5, 8, 32];
const SKY_MID = [13, 24, 66];
const SKY_HORIZON = [24, 58, 96];
const SEA_DEEP = [7, 32, 52];
const SEA_TOP = [14, 58, 84];
const MOON_CORE = [255, 248, 220];
const MOON_GLOW = [255, 236, 180];
const STAR_WHITE = [235, 242, 255];
const SPRAY = [190, 225, 245];
const PORCELAIN = [238, 242, 246];
const PORCELAIN_SHADE = [176, 196, 214];
const BLUE_PATTERN = [38, 84, 150];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix3(c1: number[], c2: number[], t: number): number[] {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------------------------------------------------------------------------
// Sky: vertical gradient, deep indigo at the top warming toward the horizon.
// ---------------------------------------------------------------------------
function drawSky(): void {
  const horizon = 828;
  for (let y = 0; y < horizon; y++) {
    const t = y / horizon;
    const c = t < 0.55 ? mix3(SKY_TOP, SKY_MID, t / 0.55) : mix3(SKY_MID, SKY_HORIZON, (t - 0.55) / 0.45);
    // A faint violet breath just above the horizon.
    const glow = Math.max(0, 1 - Math.abs(y - 800) / 130) * 10;
    const i = y * W * 3;
    for (let x = 0; x < W; x++) {
      px[i + x * 3] = clamp255(c[0] + glow * 0.4);
      px[i + x * 3 + 1] = clamp255(c[1] + glow * 0.2);
      px[i + x * 3 + 2] = clamp255(c[2] + glow);
    }
  }
}

// Four-point sparkle star, drawn as two thin diamonds.
function sparkle(cx: number, cy: number, r: number, c: number[], a: number): void {
  const w = Math.max(0.7, r * 0.22);
  poly(
    [
      [cx, cy - r],
      [cx + w, cy - w],
      [cx + r, cy],
      [cx + w, cy + w],
      [cx, cy + r],
      [cx - w, cy + w],
      [cx - r, cy],
      [cx - w, cy - w],
    ],
    c,
    a,
  );
  disc(cx, cy, r * 0.22, c, a);
}

// ---------------------------------------------------------------------------
// Stars: a deterministic field, denser and brighter away from the moon,
// plus a faint diagonal Milky Way band of tiny dots.
// ---------------------------------------------------------------------------
function drawStars(): void {
  // Milky Way: a soft diagonal band from top-left to bottom-right.
  for (let i = 0; i < 900; i++) {
    const t = rand();
    const bx = 60 + t * 900;
    const by = 40 + t * 620;
    const off = (rand() - 0.5) * 260;
    const x = bx + off * 0.7;
    const y = by - off * 0.7;
    if (x < 4 || x > W - 4 || y < 4 || y > 800) continue;
    const r = 0.5 + rand() * 0.9;
    const a = 0.10 + rand() * 0.22;
    disc(x, y, r, [200, 215, 245], a);
  }
  // Field stars.
  for (let i = 0; i < 260; i++) {
    const x = 6 + rand() * (W - 12);
    const y = 6 + rand() * 790;
    const dMoon = Math.hypot(x - 792, y - 208);
    const fade = Math.min(1, Math.max(0.15, (dMoon - 130) / 220));
    const r = 0.6 + rand() * rand() * 1.9;
    const a = (0.35 + rand() * 0.6) * fade;
    const warm = rand();
    const col = warm > 0.8 ? [255, 230, 190] : warm > 0.6 ? [190, 220, 255] : STAR_WHITE;
    disc(x, y, r, col, a);
    if (r > 1.9 && rand() > 0.45) sparkle(x, y, r * 3.4, col, a * 0.55);
  }
}

// ---------------------------------------------------------------------------
// The full moon, upper right: a bright disc, soft halo rings, quiet craters.
// ---------------------------------------------------------------------------
function drawMoon(): void {
  const mx = 792;
  const my = 208;
  const mr = 104;
  // Halo: concentric discs fading out.
  for (let k = 12; k >= 1; k--) {
    const r = mr + k * 13;
    disc(mx, my, r, MOON_GLOW, 0.028);
  }
  disc(mx, my, mr, MOON_CORE, 1);
  // Limb shading: a faint cool rim on the lower-left edge.
  for (let k = 0; k < 40; k++) {
    const ang = Math.PI * (0.55 + (k / 40) * 0.9);
    const x = mx + Math.cos(ang) * (mr - 6);
    const y = my + Math.sin(ang) * (mr - 6);
    disc(x, y, 16 + rand() * 10, [214, 222, 238], 0.10);
  }
  // Craters: soft, slightly darker discs, deterministic placement.
  const craters: number[][] = [
    [748, 168, 17],
    [818, 158, 12],
    [838, 214, 20],
    [770, 232, 13],
    [806, 256, 9],
    [742, 216, 8],
    [786, 190, 6],
  ];
  for (const [cx, cy, cr] of craters) {
    disc(cx, cy, cr, [226, 226, 205], 0.5);
    disc(cx - cr * 0.25, cy - cr * 0.25, cr * 0.62, [238, 236, 220], 0.5);
  }
}

// ---------------------------------------------------------------------------
// Sea: dark teal below the horizon, moonlight road under the moon,
// gentle wave strokes catching the light.
// ---------------------------------------------------------------------------
function drawSea(): void {
  const horizon = 828;
  for (let y = horizon; y < H; y++) {
    const t = (y - horizon) / (H - horizon);
    const c = mix3(SEA_TOP, SEA_DEEP, t);
    const i = y * W * 3;
    for (let x = 0; x < W; x++) {
      px[i + x * 3] = clamp255(c[0]);
      px[i + x * 3 + 1] = clamp255(c[1]);
      px[i + x * 3 + 2] = clamp255(c[2]);
    }
  }
  // Moonlight road: shimmering horizontal dashes under the moon.
  for (let row = 0; row < 26; row++) {
    const y = horizon + 8 + row * 7;
    const spread = 26 + row * 4.4;
    const n = 3 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const x = 792 + (rand() - 0.5) * 2 * spread;
      const len = 14 + rand() * 42;
      const a = 0.30 * Math.max(0, 1 - row / 30) + 0.05;
      polyline(
        [
          [x - len / 2, y],
          [x + len / 2, y],
        ],
        2.2,
        [255, 238, 190],
        a,
      );
    }
  }
  // Wave strokes: thin pale arcs scattered across the sea.
  for (let i = 0; i < 46; i++) {
    const x = 20 + rand() * (W - 40);
    const y = horizon + 14 + rand() * (H - horizon - 30);
    const len = 26 + rand() * 70;
    const bend = (rand() - 0.5) * 10;
    const a = 0.10 + rand() * 0.16;
    polyline(
      [
        [x - len / 2, y],
        [x, y + bend],
        [x + len / 2, y],
      ],
      1.6,
      [140, 190, 215],
      a,
    );
  }
}

// ---------------------------------------------------------------------------
// The teacup: a small porcelain cup on a saucer, floating on the night sea.
// The whale bursts out of it. Cup rim at y ~ 800, saucer at y ~ 892.
// ---------------------------------------------------------------------------
function drawTeacup(): void {
  const cx = 512;
  const rimY = 802;
  const baseY = 884;
  const rimRx = 96;
  const baseRx = 58;

  // Saucer: two stacked ellipses for a rimmed plate.
  ellipse(cx, 894, 158, 24, [150, 172, 194], 0.95);
  ellipse(cx, 890, 158, 24, PORCELAIN, 0.95);
  ellipse(cx, 890, 118, 17, PORCELAIN_SHADE, 0.55);
  // Saucer's blue ring.
  for (let k = 0; k < 60; k++) {
    const ang = (k / 60) * Math.PI * 2;
    disc(cx + Math.cos(ang) * 138, 890 + Math.sin(ang) * 20, 2.2, BLUE_PATTERN, 0.75);
  }

  // Cup body: a trapezoid with softly curved sides, shaded left to right.
  const body: number[][] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = rimY + t * (baseY - rimY);
    const rx = rimRx * (1 - t) + baseRx * t - Math.sin(t * Math.PI) * 4;
    body.push([cx - rx, y]);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const y = rimY + t * (baseY - rimY);
    const rx = rimRx * (1 - t) + baseRx * t - Math.sin(t * Math.PI) * 4;
    body.push([cx + rx, y]);
  }
  poly(body, PORCELAIN, 0.98);
  // Left shade and right highlight on the cup.
  const shade: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = rimY + t * (baseY - rimY);
    const rx = rimRx * (1 - t) + baseRx * t - Math.sin(t * Math.PI) * 4;
    shade.push([cx - rx, y]);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const y = rimY + t * (baseY - rimY);
    const rx = (rimRx * (1 - t) + baseRx * t - Math.sin(t * Math.PI) * 4) * 0.45;
    shade.push([cx - rx, y]);
  }
  poly(shade, PORCELAIN_SHADE, 0.35);
  polyline(
    [
      [cx + rimRx * 0.62, rimY + 8],
      [cx + baseRx * 0.7, baseY - 8],
    ],
    7,
    [255, 255, 255],
    0.5,
  );

  // Blue band and little blossoms around the cup.
  polyline(
    [
      [cx - rimRx + 8, rimY + 30],
      [cx + rimRx - 8, rimY + 30],
    ],
    3,
    BLUE_PATTERN,
    0.85,
  );
  for (let k = 0; k < 7; k++) {
    const fx = cx - 62 + k * 21;
    const fy = rimY + 52 + Math.sin(k * 1.7) * 4;
    for (let p = 0; p < 5; p++) {
      const ang = (p / 5) * Math.PI * 2;
      disc(fx + Math.cos(ang) * 4.5, fy + Math.sin(ang) * 4.5, 2.6, BLUE_PATTERN, 0.85);
    }
    disc(fx, fy, 2.4, [212, 160, 60], 0.9);
  }

  // Handle: a thick arc on the right side.
  const handle: number[][] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const ang = -Math.PI * 0.25 + t * Math.PI * 1.05;
    handle.push([cx + rimRx - 4 + Math.cos(ang) * 34, rimY + 40 + Math.sin(ang) * 30]);
  }
  polyline(handle, 9, PORCELAIN_SHADE, 0.95);
  polyline(handle, 5, PORCELAIN, 0.95);

  // Rim: the open top, dark tea inside with a moonlit glint.
  ellipse(cx, rimY, rimRx, 20, [198, 210, 222], 1);
  ellipse(cx, rimY, rimRx - 8, 15, [22, 52, 82], 1);
  ellipse(cx - 26, rimY - 2, 30, 5, [120, 170, 210], 0.5);
}

// ---------------------------------------------------------------------------
// Splash: a crown of water bursting from the rim where the whale leaves,
// droplets flying up along the whale's arc.
// ---------------------------------------------------------------------------
function drawSplash(): void {
  const cx = 512;
  const rimY = 802;
  // Crown spikes around the rim: tapered, fanned outward, uneven lengths,
  // so they read as thrown water rather than a row of bars.
  for (let k = 0; k < 12; k++) {
    const t = k / 11;
    const ang = Math.PI * (1.06 + t * 0.88);
    const baseX = cx + Math.cos(ang) * 86;
    const baseY = rimY + Math.sin(ang) * 15;
    const len = 30 + rand() * 55;
    const lean = (t - 0.5) * 1.1 + (rand() - 0.5) * 0.3;
    const tipX = baseX + Math.sin(lean) * len * 0.55;
    const tipY = baseY - Math.cos(lean) * len;
    const wdt = 4 + rand() * 6;
    const dx = tipX - baseX;
    const dy = tipY - baseY;
    const dl = Math.hypot(dx, dy) || 1;
    const pnx = -dy / dl;
    const pny = dx / dl;
    poly(
      [
        [baseX + pnx * wdt * 0.5, baseY + pny * wdt * 0.5],
        [baseX - pnx * wdt * 0.5, baseY - pny * wdt * 0.5],
        [tipX - pnx * 1.2, tipY - pny * 1.2],
        [tipX + pnx * 1.2, tipY + pny * 1.2],
      ],
      SPRAY,
      0.9,
    );
    disc(tipX, tipY, 2 + rand() * 2.5, [225, 242, 250], 0.9);
  }
  // Loose droplets just above the rim.
  for (let i = 0; i < 42; i++) {
    const ang = Math.PI * (1.05 + rand() * 0.9);
    const r0 = 70 + rand() * 60;
    const x = cx + Math.cos(ang) * r0;
    const y = rimY + Math.sin(ang) * r0 * 0.32 - rand() * 70;
    const r = 1.2 + rand() * 3.4;
    disc(x, y, r, [210, 232, 248], 0.75 + rand() * 0.2);
  }
  // A thin bright ring where water meets the cup's rim.
  ellipse(cx, rimY, 96, 20, [220, 238, 250], 0.35);
}

// ---------------------------------------------------------------------------
// The whale: a tube grown along a quadratic Bezier spine that arcs out of
// the cup toward the moon. The body is shaded dorsal-dark / belly-pale by
// the signed distance from the spine, so it reads as one solid animal.
// ---------------------------------------------------------------------------
interface SpinePt {
  x: number;
  y: number;
  nx: number;
  ny: number;
  r: number;
}

function bezier(p0: number[], p1: number[], p2: number[], t: number): number[] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function drawWhale(): void {
  // Spine: tail at the cup, belly of the arc low-left, head up near the moon.
  // A short, thick, diagonal arc so the animal reads at 300px: a powerful
  // leap, not a vertical blade.
  const p0 = [548, 792];
  const p1 = [270, 660];
  const p2 = [310, 470];
  const N = 90;
  const spine: SpinePt[] = [];
  const maxR = 112;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = bezier(p0, p1, p2, t);
    const [x2, y2] = bezier(p0, p1, p2, Math.min(1, t + 0.01));
    let tx = x2 - x;
    let ty = y2 - y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // Radius: thin tail, thickest just past the middle, blunt rounded head
    // (never a point: the head keeps ~45% of max radius so it reads as a
    // whale's snout, not a fin tip).
    const shape = Math.pow(Math.sin(Math.PI * (0.1 + 0.8 * t)), 0.65);
    spine.push({ x, y, nx: -ty, ny: tx, r: Math.max(8, maxR * shape) });
  }

  const DORSAL = [24, 42, 74];
  const BELLY = [198, 214, 228];
  const MID = [86, 118, 150];

  // Body: for each pixel near the spine, find the nearest sample and shade
  // by the signed offset across the body. One bounding box keeps it fast.
  const x0 = 190;
  const x1 = 700;
  const y0 = 180;
  const y1 = 830;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let best = Infinity;
      let bi = 0;
      let bs = 0;
      for (let i = 0; i <= N; i++) {
        const s = spine[i];
        const dx = x + 0.5 - s.x;
        const dy = y + 0.5 - s.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
          best = d2;
          bi = i;
          bs = dx * s.nx + dy * s.ny;
        }
      }
      const s = spine[bi];
      const d = Math.sqrt(best);
      if (d > s.r + 1.5) continue;
      const across = bs / s.r; // -1 belly side .. +1 dorsal side
      let c: number[];
      if (across > 0.12) c = mix3(MID, DORSAL, Math.min(1, (across - 0.12) / 0.7));
      else if (across < -0.12) c = mix3(MID, BELLY, Math.min(1, (-across - 0.12) / 0.7));
      else c = MID;
      // Moonlight kisses the upper edge of the body.
      if (across > 0.72) c = mix3(c, [235, 240, 250], (across - 0.72) / 0.28 * 0.55);
      const a = edgeAlpha(d, s.r, 1.6);
      blend(x, y, c[0], c[1], c[2], a);
    }
  }

  // Dorsal outline: a dark stroke along the upper edge so the body holds
  // its silhouette against the night sky.
  const dorsalLine: number[][] = [];
  for (let i = 2; i <= N; i += 2) {
    const s = spine[i];
    dorsalLine.push([s.x + s.nx * s.r * 0.94, s.y + s.ny * s.r * 0.94]);
  }
  polyline(dorsalLine, 4, [16, 28, 52], 0.55);

  // Tail flukes: two short lobes fanning up and out above the cup's rim,
  // tucked into the splash crown so they read as one tail, not stray fins.
  const tail = spine[0];
  const flukeL: number[][] = [
    [tail.x - 4, tail.y + 2],
    [tail.x - 66, tail.y - 38],
    [tail.x - 96, tail.y - 30],
    [tail.x - 60, tail.y - 2],
    [tail.x - 30, tail.y + 8],
  ];
  const flukeR: number[][] = [
    [tail.x - 4, tail.y + 2],
    [tail.x + 58, tail.y - 34],
    [tail.x + 86, tail.y - 24],
    [tail.x + 54, tail.y + 2],
    [tail.x + 26, tail.y + 10],
  ];
  poly(flukeL, DORSAL, 0.98);
  poly(flukeR, DORSAL, 0.98);
  polyline(flukeL, 3, [150, 175, 200], 0.5);
  polyline(flukeR, 3, [150, 175, 200], 0.5);

  // No pectoral fin: at this scale a separate dark blade reads as a scratch
  // across the belly, so the silhouette stays clean.

  // Head details: eye with a glint, a gentle mouth curve, blowhole mist.
  const head = spine[N];
  const eyeX = head.x - 26;
  const eyeY = head.y - 34;
  disc(eyeX, eyeY, 11, [8, 14, 26], 1);
  disc(eyeX - 3.5, eyeY - 3.5, 3.5, [255, 255, 255], 0.95);
  const mouth: number[][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    mouth.push([head.x - 58 + t * 74, head.y + 8 + Math.sin(t * Math.PI) * 10 - t * 6]);
  }
  polyline(mouth, 3.5, [20, 34, 56], 0.85);
  // Blowhole spout: a small plume of mist above the head.
  for (let i = 0; i < 16; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.1;
    const len = 18 + rand() * 42;
    disc(head.x + 6 + Math.cos(a) * len, head.y - 66 + Math.sin(a) * len * 0.8, 2 + rand() * 3.4, [215, 233, 248], 0.5);
  }
}

// ---------------------------------------------------------------------------
// The trail: water flung off the whale's back turns into stars as it rises
// toward the moon — droplets near the body, sparkles near the sky.
// ---------------------------------------------------------------------------
function drawTrail(): void {
  for (let i = 0; i < 90; i++) {
    const t = rand();
    // Points along the spine, pushed outward on the dorsal side.
    const tt = 0.25 + t * 0.72;
    const [sx, sy] = bezier([548, 792], [270, 660], [310, 470], tt);
    const lift = 30 + rand() * 150 * t;
    const x = sx + (rand() - 0.5) * 120 + 40 * t;
    const y = sy - lift - rand() * 60;
    if (t < 0.35) {
      disc(x, y, 1.6 + rand() * 3.2, [205, 230, 248], 0.85);
    } else if (t < 0.7) {
      disc(x, y, 1.2 + rand() * 2.2, [220, 235, 252], 0.9);
      if (rand() > 0.6) sparkle(x, y, 5 + rand() * 5, STAR_WHITE, 0.7);
    } else {
      sparkle(x, y, 6 + rand() * 9, STAR_WHITE, 0.85);
      disc(x, y, 1.4, STAR_WHITE, 0.95);
    }
  }
}

// ---------------------------------------------------------------------------
// Compose and write the file. Output dir: $MAKEFUN_OUTPUT_DIR or /output.
// ---------------------------------------------------------------------------
function main(): void {
  drawSky();
  drawStars();
  drawMoon();
  drawSea();
  drawTrail();
  drawWhale();
  drawSplash();
  drawTeacup();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePNG();
  fs.writeFileSync(path.join(outDir, "entry.png"), png);
  console.log(`wrote ${png.length} bytes to ${path.join(outDir, "entry.png")}`);
}

main();
