// Draws the app and tray icons with no image dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, shade) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const [cr, cg, cb, ca] = shade((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = row + 1 + x * 4;
      raw[o] = a ? r / a : 0;
      raw[o + 1] = a ? g / a : 0;
      raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = (a / 16) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRound = (u, v, x0, y0, x1, y1, rad) => {
  const dx = Math.max(x0 + rad - u, 0, u - (x1 - rad));
  const dy = Math.max(y0 + rad - v, 0, v - (y1 - rad));
  return dx * dx + dy * dy <= rad * rad;
};

const CLEAR = [0, 0, 0, 0];

function appIcon(u, v) {
  if (!inRound(u, v, 0.05, 0.05, 0.95, 0.95, 0.2)) return CLEAR;
  const tv = inRound(u, v, 0.2, 0.26, 0.8, 0.66, 0.04);
  const screen = inRound(u, v, 0.235, 0.295, 0.765, 0.625, 0.015);
  const stand = (u > 0.44 && u < 0.56 && v > 0.66 && v < 0.73) || inRound(u, v, 0.34, 0.72, 0.66, 0.76, 0.015);
  if (tv && !screen) return [255, 255, 255, 1];
  if (stand) return [255, 255, 255, 1];
  if (screen) {
    const d = Math.hypot(u - 0.3, v - 0.56);
    for (const rad of [0.09, 0.17, 0.25]) if (Math.abs(d - rad) < 0.016 && u > 0.3 && v < 0.56) return [255, 255, 255, 1];
    return Math.hypot(u - 0.3, v - 0.56) < 0.03 ? [255, 255, 255, 1] : [37, 99, 235, 1];
  }
  return [31, 41, 55, 1];
}

const trayShape = (color) => (u, v) => {
  const tv = inRound(u, v, 0.08, 0.16, 0.92, 0.72, 0.09);
  const hole = inRound(u, v, 0.19, 0.27, 0.81, 0.61, 0.03);
  const stand = (u > 0.42 && u < 0.58 && v >= 0.72 && v < 0.82) || inRound(u, v, 0.26, 0.8, 0.74, 0.89, 0.04);
  return (tv && !hole) || stand ? [...color, 1] : CLEAR;
};

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', png(1024, appIcon));
fs.writeFileSync('electron/trayTemplate.png', png(18, trayShape([0, 0, 0])));
fs.writeFileSync('electron/trayTemplate@2x.png', png(36, trayShape([0, 0, 0])));
fs.writeFileSync('electron/tray.png', png(32, trayShape([59, 130, 246])));
