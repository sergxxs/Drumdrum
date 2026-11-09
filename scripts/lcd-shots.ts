/**
 * Renders every LCD screen to PNG using the real page renderers (no browser needed).
 * Usage: npx vite-node scripts/lcd-shots.ts [outDir]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { installCanvasStubs, StubCanvas } from '../tests/support/domStub';
import { Lcd, LCD_W, LCD_H } from '../src/ui/lcd';
import { drawScreen } from '../src/ui/pages';
import type { Screen, Status } from '../src/ui/pages';
import { Store } from '../src/state/store';
import { buildFactorySamples } from '../src/audio/sample';

installCanvasStubs();

const outDir = process.argv[2] ?? 'docs/lcd';
mkdirSync(outDir, { recursive: true });

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, rgb: Uint8Array, scale: number): Buffer {
  const W = w * scale;
  const H = h * scale;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const si = (((y / scale) | 0) * w + ((x / scale) | 0)) * 3;
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[si];
      raw[o + 1] = rgb[si + 1];
      raw[o + 2] = rgb[si + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lcd = new Lcd(new StubCanvas() as unknown as HTMLCanvasElement);
const store = new Store();
// the real app registers the synthesised factory samples at boot; do the same so the
// SAMPLE page renders with an actual sample loaded
for (const s of buildFactorySamples(44100)) store.addSampleMeta(s.meta);
const status: Status = {
  playing: true,
  steps: [0, 4, 8, 12, 2, 6, 10, 14],
  masterL: 0.55,
  masterR: 0.42,
  trackMeters: [0.5, 0.2, 0.7, 0.1, 0.3, 0.6, 0.2, 0.1],
  recFrames: 0,
  recActive: false,
  audio: 'running',
  host: 'WORKLET',
  frames: 44100,
};

function grab(name: string, screen: Screen) {
  drawScreen(lcd, store, status, screen);
  const lit: number[] = [];
  for (let i = 0; i < LCD_W * LCD_H; i++) lit.push((lcd as unknown as { buf: Uint8Array }).buf[i]);
  const rgb = new Uint8Array(LCD_W * LCD_H * 3);
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i] ? [18, 22, 30] : [176, 192, 214];
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  writeFileSync(`${outDir}/${name}.png`, png(LCD_W, LCD_H, rgb, 4));
}

grab('pattern', { kind: 'mode', name: 'PATTERN' });
grab('kit', { kind: 'mode', name: 'KIT' });
grab('mix', { kind: 'mode', name: 'MIX' });
grab('song', { kind: 'mode', name: 'SONG' });
grab('setup', { kind: 'mode', name: 'SETUP' });
grab('masterfx', { kind: 'mode', name: 'FX' });
store.setEngine(0, 'fm');
grab('sound-fm', { kind: 'page', page: 'sound' });
grab('mod-fm', { kind: 'page', page: 'mod' });
store.setEngine(0, 'mono');
grab('sound-mono', { kind: 'page', page: 'sound' });
store.setEngine(0, 'sample');
grab('sample', { kind: 'page', page: 'sample' });
store.setEngine(0, 'fm');
grab('filter', { kind: 'page', page: 'filter' });
grab('amp', { kind: 'page', page: 'amp' });
grab('lfo', { kind: 'page', page: 'lfo' });
grab('fx', { kind: 'page', page: 'fx' });
console.log(`wrote ${outDir}/*.png`);
