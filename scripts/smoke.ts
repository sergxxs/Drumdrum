/**
 * Headless audio smoke test. Renders the factory project in Node and reports levels so
 * we can prove the engines/sequencer/effects produce real audio.
 * Run: npm run smoke
 */
import { AudioEngine } from '../src/audio/engine';
import { defaultProject, defaultTrackParams } from '../src/state/presets';
import { buildFactorySamples } from '../src/audio/sample';
import { rms, peak } from '../src/audio/dsp';
import { encodeWav } from '../src/audio/wav';
import { writeFileSync, mkdirSync } from 'node:fs';

const project = defaultProject();
const engine = new AudioEngine(project, { sampleRate: 44100, blockSize: 256 });
for (const s of buildFactorySamples(44100)) engine.bank.set(s);

// 1. sequencer render of the factory pattern (2 bars @120bpm = 4s)
engine.play();
const t0 = Date.now();
const out = engine.renderOffline(4.0);
const elapsed = Date.now() - t0;

console.log(`rendered ${out.left.length} frames in ${elapsed} ms (${(out.left.length / 44100 / (elapsed / 1000)).toFixed(1)}x realtime)`);
console.log('pattern RMS:', rms(out.left).toFixed(5), 'peak:', peak(out.left).toFixed(4));
console.log('per-track meters:', engine.meters.tracks.map((m) => m.toFixed(3)).join(' '));

// 2. each engine alone, rendered directly through a single track
for (const name of ['fm', 'mono', 'sample'] as const) {
  const project2 = defaultProject();
  for (let t = 0; t < 8; t++) project2.kits[0].tracks[t].params.mute = t !== 0;
  const e2 = new AudioEngine(project2, { sampleRate: 44100 });
  for (const smp of buildFactorySamples(44100)) e2.bank.set(smp);
  e2.kit.tracks[0].params = defaultTrackParams(name);
  if (name === 'sample') e2.kit.tracks[0].params.sample.sampleId = 'factory-clang';
  e2.setKit(e2.kit);
  e2.tracks[0].noteOn(48, 0.9);
  const buf = new Float32Array(22050);
  const bufR = new Float32Array(22050);
  e2.processInto(buf, bufR, 22050);
  console.log(`engine ${name.padEnd(6)}: rms=${rms(buf).toFixed(4)} peak=${peak(buf).toFixed(4)}`);
}

// 3. every track soloed, so the factory pattern is proven track by track
console.log('per-track levels of the factory pattern (2 bars):');
for (let t = 0; t < 8; t++) {
  const p2 = defaultProject();
  for (let k = 0; k < 8; k++) p2.kits[0].tracks[k].params.mute = k !== t;
  const e3 = new AudioEngine(p2, { sampleRate: 44100 });
  for (const smp of buildFactorySamples(44100)) e3.bank.set(smp);
  e3.play();
  const out3 = e3.renderOffline(2.0);
  console.log(`  trk ${t + 1} ${p2.kits[0].tracks[t].name.padEnd(8)} ${p2.kits[0].tracks[t].params.engine.padEnd(6)} rms=${rms(out3.left).toFixed(4)} peak=${peak(out3.left).toFixed(3)}`);
}

mkdirSync('tmp', { recursive: true });
const wav = encodeWav(out.left, out.right, 44100, 16);
writeFileSync('tmp/smoke.wav', Buffer.from(wav));
console.log('wrote tmp/smoke.wav', (wav.byteLength / 1024).toFixed(0), 'KB');
