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

// 2. each engine alone
engine.stop();
for (const name of ['fm', 'mono', 'sample'] as const) {
  const p = defaultTrackParams(name);
  if (name === 'sample') p.sample.sampleId = 'factory-clang';
  project.kits[0].tracks[0].params = p;
  engine.setKit(project.kits[0]);
  engine.tracks[0].noteOn(48, 0.9);
  const buf = new Float32Array(22050);
  const bufR = new Float32Array(22050);
  engine.processInto(buf, bufR, 22050);
  console.log(`engine ${name}: rms=${rms(buf).toFixed(5)} peak=${peak(buf).toFixed(4)}`);
}

mkdirSync('tmp', { recursive: true });
const wav = encodeWav(out.left, out.right, 44100, 16);
writeFileSync('tmp/smoke.wav', Buffer.from(wav));
console.log('wrote tmp/smoke.wav', (wav.byteLength / 1024).toFixed(0), 'KB');
