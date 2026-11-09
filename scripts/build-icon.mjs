#!/usr/bin/env node
/**
 * Build the Nexus application icon without a native image dependency.
 *
 * The mark is the same orbital language as the in-app brand: a dark rounded
 * tile, a cyan outer orbit, a violet inner orbit and a bright cyan core.
 * We render at 4x and box-filter down so the small Windows sizes stay clean.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const TAU = Math.PI * 2;
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * clamp(t);
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x) - (halfWidth - radius);
  const qy = Math.abs(y) - (halfHeight - radius);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function arcMask(angle, startDegrees, endDegrees) {
  let start = (startDegrees * Math.PI) / 180;
  let end = (endDegrees * Math.PI) / 180;
  if (end < start) end += TAU;
  let value = angle;
  while (value < start) value += TAU;
  while (value > start + TAU) value -= TAU;
  return value <= end ? 1 : 0;
}

function add(base, color, alpha) {
  if (alpha <= 0) return;
  const a = clamp(alpha);
  base[0] += color[0] * a;
  base[1] += color[1] * a;
  base[2] += color[2] * a;
}

function renderMaster(size) {
  const width = size * SS;
  const pixels = new Float32Array(width * width * 4);
  for (let py = 0; py < width; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const x = (px + 0.5) / width - 0.5;
      const y = (py + 0.5) / width - 0.5;
      const distance = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      const rect = roundedRectDistance(x, y, 0.458, 0.458, 0.112);
      const tile = 1 - smoothstep(-0.0025, 0.0025, rect);
      if (tile <= 0) continue;

      // Dark navy tile with a cool centre wash and a violet lower-right lift.
      const vertical = clamp(y + 0.5);
      let color = mixRgb([0.018, 0.029, 0.055], [0.045, 0.080, 0.125], vertical);
      const cyanWash = Math.exp(-(x * x + y * y) * 5.2);
      const violetWash = Math.exp(-((x - 0.28) ** 2 + (y - 0.31) ** 2) * 7.4);
      color = [
        color[0] + cyanWash * 0.018 + violetWash * 0.055,
        color[1] + cyanWash * 0.085 + violetWash * 0.025,
        color[2] + cyanWash * 0.13 + violetWash * 0.12,
      ];

      // Thin cyan rim.
      const rim = 1 - smoothstep(0.0015, 0.0065, Math.abs(rect));
      add(color, [0.22, 0.9, 1.0], rim * 0.38);

      // Orbit halos.
      const outerDistance = Math.abs(distance - 0.330);
      const middleDistance = Math.abs(distance - 0.216);
      add(color, [0.16, 0.82, 1.0], Math.exp(-((outerDistance / 0.070) ** 2)) * 0.15);
      add(color, [0.49, 0.32, 1.0], Math.exp(-((middleDistance / 0.055) ** 2)) * 0.13);
      add(color, [0.20, 0.88, 1.0], Math.exp(-((distance / 0.135) ** 2)) * 0.16);

      // Outer cyan orbit: 270° with a deliberate gap at the lower-left.
      const outerWidth = 0.027;
      const outerBand = 1 - smoothstep(outerWidth * 0.44, outerWidth, outerDistance);
      const outerArc = arcMask(angle, -125, 145);
      const outer = outerBand * outerArc;
      if (outer > 0) {
        const edgeLight = 1 - smoothstep(0, outerWidth * 0.7, outerDistance);
        const ringColor = mixRgb([0.14, 0.78, 1.0], [0.47, 1.0, 1.0], edgeLight);
        add(color, ringColor, outer);
        // A restrained white-cyan highlight on the top of the orbit.
        add(color, [0.72, 1.0, 1.0], outer * Math.max(0, -y / 0.34) * 0.32);
      }

      // Inner violet orbit: offset sweep to make the mark feel active.
      const middleWidth = 0.021;
      const middleBand = 1 - smoothstep(middleWidth * 0.45, middleWidth, middleDistance);
      const middle = middleBand * arcMask(angle, 58, 312);
      if (middle > 0) {
        const edgeLight = 1 - smoothstep(0, middleWidth * 0.7, middleDistance);
        add(color, mixRgb([0.38, 0.24, 0.82], [0.64, 0.55, 1.0], edgeLight), middle);
      }

      // Small satellite nodes at the two orbit breaks.
      const outerNode = Math.hypot(x - Math.cos(-64 * Math.PI / 180) * 0.330, y - Math.sin(-64 * Math.PI / 180) * 0.330);
      const middleNode = Math.hypot(x - Math.cos(156 * Math.PI / 180) * 0.216, y - Math.sin(156 * Math.PI / 180) * 0.216);
      add(color, [0.63, 1.0, 1.0], (1 - smoothstep(0.012, 0.026, outerNode)) * 0.95);
      add(color, [0.67, 0.56, 1.0], (1 - smoothstep(0.009, 0.022, middleNode)) * 0.9);

      // Bright core with a soft rim and a specular pin-light.
      const coreRadius = 0.086;
      const core = 1 - smoothstep(coreRadius * 0.82, coreRadius, distance);
      const coreMix = clamp(distance / coreRadius);
      if (core > 0) {
        add(color, mixRgb([0.74, 1.0, 1.0], [0.12, 0.84, 1.0], coreMix), core * 0.98);
      }
      const specular = Math.hypot(x + 0.026, y + 0.032);
      add(color, [0.92, 1.0, 1.0], (1 - smoothstep(0.006, 0.030, specular)) * 0.78);

      const offset = (py * width + px) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = tile;
    }
  }
  return { pixels, width };
}

function downsample(master, size) {
  const output = Buffer.alloc(size * size * 4);
  const cell = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const offset = (((y * SS + sy) * master.width) + (x * SS + sx)) * 4;
          const alpha = master.pixels[offset + 3];
          r += master.pixels[offset] * alpha;
          g += master.pixels[offset + 1] * alpha;
          b += master.pixels[offset + 2] * alpha;
          a += alpha;
        }
      }
      const offset = (y * size + x) * 4;
      if (a > 0) {
        output[offset] = Math.round(clamp(r / a) * 255);
        output[offset + 1] = Math.round(clamp(g / a) * 255);
        output[offset + 2] = Math.round(clamp(b / a) * 255);
      }
      output[offset + 3] = Math.round(clamp(a / cell) * 255);
    }
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const output = Buffer.alloc(12 + body.length);
  output.writeUInt32BE(body.length, 0);
  name.copy(output, 4);
  body.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, body])), 8 + body.length);
  return output;
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", (() => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(size, 0);
      ihdr.writeUInt32BE(size, 4);
      ihdr[8] = 8;
      ihdr[9] = 6;
      return ihdr;
    })()),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

fs.mkdirSync(BUILD, { recursive: true });
const images = SIZES.map((size) => {
  const master = renderMaster(size);
  const rgba = downsample(master, size);
  return { size, png: encodePng(size, rgba) };
});
for (const image of images) {
  if (image.size === 256) fs.writeFileSync(path.join(BUILD, "icon.png"), image.png);
  if (image.size === 256) fs.writeFileSync(path.join(BUILD, "icon-preview.png"), image.png);
}
fs.writeFileSync(path.join(BUILD, "icon.ico"), encodeIco(images));
console.log(`[icon] wrote ${path.join(BUILD, "icon.ico")} (${SIZES.join(", ")} px)`);
console.log(`[icon] preview ${path.join(BUILD, "icon.png")}`);
