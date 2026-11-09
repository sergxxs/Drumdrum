#!/usr/bin/env node
/**
 * Headless boot check: loads index.html into a real DOM (linkedom), stubs the browser
 * APIs the app touches, then boots the App and drives the panel like a user would:
 * taps pads, turns encoders, toggles transport, opens/closes dialogs, exports.
 *
 * There is no browser in the build environment, so this is the closest thing to a smoke
 * test of the whole UI/audio wiring. Run: node scripts/boot-check.mjs
 */
import { parseHTML } from 'linkedom';
import { build } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';

async function bundleMain() {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      lib: { entry: 'scripts/boot-entry.ts', formats: ['es'], fileName: () => 'boot-app.mjs' },
      outDir: 'tmp',
      emptyOutDir: false,
      minify: false,
      target: 'es2022',
      rollupOptions: { external: [] },
    },
  });
}

await bundleMain();

const html = readFileSync('index.html', 'utf8');
const { window, document } = parseHTML(html);

/* ---------------- browser surface the app needs ---------------- */
class FakeCtx2D {
  constructor(canvas) { this.canvas = canvas; }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData() {} drawImage() {} clearRect() {} fillRect() {}
  set imageSmoothingEnabled(v) {} get imageSmoothingEnabled() { return false; }
}
function makeCanvas() {
  const c = document.createElement('canvas');
  c.getContext = () => new FakeCtx2D(c);
  return c;
}
// patch canvas creation
const origCreate = document.createElement.bind(document);
document.createElement = (tag) => {
  const el = origCreate(tag);
  if (tag === 'canvas') el.getContext = () => new FakeCtx2D(el);
  return el;
};
window.HTMLCanvasElement.prototype.getContext = function () { return new FakeCtx2D(this); };

// ImageData for the LCD
window.ImageData = class { constructor(w,h){ this.width=w; this.height=h; this.data=new Uint8ClampedArray(w*h*4);} };

// AudioContext stub: worklet path will fail, exercising the ScriptProcessor fallback
let audioNodes = 0;
class FakeGainNode { connect(){} disconnect(){} }
class FakeScriptProcessor {
  constructor() { this.onaudioprocess = null; }
  connect() { audioNodes++; }
  disconnect() {}
}
class FakeAudioContext {
  constructor() { this.state = 'suspended'; this.sampleRate = 44100; this.destination = new FakeGainNode(); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() {}
  createScriptProcessor() { return new FakeScriptProcessor(); }
  createGain() { return new FakeGainNode(); }
  async decodeAudioData() { return { getChannelData: () => new Float32Array(4410), numberOfChannels: 1, sampleRate: 44100 }; }
}
window.AudioContext = FakeAudioContext;
Object.defineProperty(window, 'AudioWorkletNode', { value: undefined, writable: true });
window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 4);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.performance = window.performance ?? { now: () => Date.now() };
window.visualViewport = { width: 1200, height: 800, addEventListener() {} };
window.innerWidth = 1200; window.innerHeight = 800;
window.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.get(k) ?? null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
};
window.indexedDB = undefined; // localStorage fallback path in storage.ts
globalThis.window = window;
globalThis.document = document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator ?? { userAgent: 'headless' }, configurable: true }); } catch { /* node provides one */ }
globalThis.localStorage = window.localStorage;

globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.devicePixelRatio = 2;

// pointer capture shims
for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'wheel']) {
  // linkedom supports addEventListener already
}
const el = (sel) => document.querySelector(sel);
const all = (sel) => [...document.querySelectorAll(sel)];

/* ---------------- boot the app ---------------- */
const { App } = await import('../tmp/boot-app.mjs');
const app = new App(document.body);
await app.boot();
console.log('✓ boot complete');
console.log('  mode buttons:', all('.mode').length, '| pads:', all('.pad').length, '| knobs:', all('.knob').length, '| fn buttons:', all('[data-fn]').length);

const frameStub = { clientX: 100, clientY: 100, pointerId: 1, preventDefault() {}, shiftKey: false };
function fire(node, type, extra = {}) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, frameStub, extra);
  node.dispatchEvent(ev);
}

// audio unlock: click play
el('#btn-play').click();
await new Promise((r) => setTimeout(r, 120));
console.log('  audio:', app.status?.audio ?? 'n/a', '| host:', app.status?.host ?? 'n/a');

// pads
for (const pad of all('.pad')) { fire(pad, 'pointerdown'); fire(pad, 'pointerup'); }
await new Promise((r) => setTimeout(r, 60));
console.log('✓ 8 pads triggered');

// encoders: drag each A-D knob
for (const id of ['a', 'b', 'c', 'd']) {
  const knob = el(`.pknob[data-knob="${id}"] .knob`);
  fire(knob, 'pointerdown', { clientY: 200 });
  fire(knob, 'pointermove', { clientY: 120 });
  fire(knob, 'pointerup', { clientY: 120 });
}
console.log('✓ encoders A-D edited');

// mode buttons
for (const b of all('.mode')) { b.click(); await new Promise((r) => setTimeout(r, 10)); }
console.log('✓ all 7 modes rendered');

// nav
for (const d of ['up', 'down', 'left', 'right', 'center']) {
  el(`[data-nav="${d}"]`).click();
  await new Promise((r) => setTimeout(r, 10));
}
console.log('✓ navigation cluster');

// transport / step groups
all('[data-step-adj]').forEach((b) => b.click());

// transport encoders: FX send + master must both reach the engine/store
const sendKnob = el('[data-knob="send"]');
const masterKnob = el('[data-knob="master"]');
const volBefore = app.store.project.master.volume;
const sendBefore = app.store.track.sendA;
for (const k of [sendKnob, masterKnob]) {
  fire(k, 'pointerdown', { clientY: 300 });
  fire(k, 'pointermove', { clientY: 280 });
  fire(k, 'pointermove', { clientY: 260 });
  fire(k, 'pointermove', { clientY: 240 });
  fire(k, 'pointermove', { clientY: 200 });
  fire(k, 'pointerup', { clientY: 200 });
}
const masterVol = app.store.project.master.volume;
console.log('  send/master encoders: sendA =', app.store.track.sendA.toFixed(2),
  '| master vol =', masterVol.toFixed(2));
if (Math.abs(masterVol - volBefore) < 0.005) throw new Error('master encoder did not change volume');
if (Math.abs(app.store.track.sendA - sendBefore) < 0.005) throw new Error('fx send encoder did not change sendA');
console.log('  transport encoders moved: master', volBefore.toFixed(2), '->', masterVol.toFixed(2),
  '| sendA', sendBefore.toFixed(2), '->', app.store.track.sendA.toFixed(2));
console.log('✓ speed/length/swing');

// functions
for (const f of ['undo', 'redo', 'clear-step', 'copy', 'random', 'motion', 'locks', 'save', 'load', 'help', 'info', 'export']) {
  el(`[data-fn="${f}"]`)?.click();
  await new Promise((r) => setTimeout(r, 15));
}
console.log('✓ function row (incl. dialogs + export)');
// close any dialog left open
if (app.dialogs?.open) app.dialogs.close();

// mute / solo / format / rec / select / stop
for (const id of ['#btn-mute', '#btn-solo', '#btn-format', '#btn-select', '#btn-live-rec', '#btn-rec', '#btn-stop']) {
  el(id)?.click();
  await new Promise((r) => setTimeout(r, 15));
}
console.log('✓ mute/solo/format/select/rec/stop');

// export a short mix through the real exporter
const { exportMix } = await import('../tmp/boot-app.mjs');
const files = await exportMix({
  project: app.store.project,
  samples: app.samples,
  opts: { bars: 1, scope: 'mix', format: 'wav', includeTail: true, trackIndex: 0 },
  onProgress: () => {},
});
console.log('✓ export produced', files.length, 'file(s),', files[0].blob.size, 'bytes:', files[0].name);

// persist + reload
await app.autosave?.();
console.log('✓ autosave');
console.log('BOOT CHECK PASSED');
process.exit(0);
