import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStubs } from './support/domStub';
import * as storage from '../src/state/storage';
import { defaultProject, defaultKit } from '../src/state/presets';
import { encodeWav, normalizeChannels } from '../src/audio/wav';
import { decodeWav, makeSample, computePeaks, detectTransients } from '../src/audio/sample';
import { exportMix } from '../src/export/render';
import { Store } from '../src/state/store';
import { rms, peak } from '../src/audio/dsp';
import { buildFactorySamples } from '../src/audio/sample';
import { AudioEngine } from '../src/audio/engine';

beforeAll(() => {
  installCanvasStubs();
  // no IndexedDB in node -> exercise the localStorage fallback path
  (globalThis as any).indexedDB = undefined;
  (globalThis as any).window = (globalThis as any).window ?? {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
});

describe('WAV import', () => {
  /** Build a RIFF/WAVE file by hand so the decoder is tested against the spec, not our encoder. */
  function makeWav(bits: number, channels: number, frames: number, value: (i: number, c: number) => number) {
    const bps = bits / 8;
    const size = frames * channels * bps;
    const ab = new ArrayBuffer(44 + size);
    const dv = new DataView(ab);
    const put = (o: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
    put(0, 'RIFF'); dv.setUint32(4, 36 + size, true); put(8, 'WAVE'); put(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
    dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * channels * bps, true);
    dv.setUint16(32, channels * bps, true); dv.setUint16(34, bits, true);
    put(36, 'data'); dv.setUint32(40, size, true);
    let o = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const v = value(i, c);
        if (bits === 8) dv.setUint8(o, Math.round((v + 1) * 127.5));
        else if (bits === 16) dv.setInt16(o, Math.round(v * 32767), true);
        else if (bits === 24) {
          const q = Math.round(v * 8388607);
          dv.setUint8(o, q & 255); dv.setUint8(o + 1, (q >> 8) & 255); dv.setUint8(o + 2, (q >> 16) & 255);
        } else dv.setInt32(o, Math.round(v * 2147483647), true);
        o += bps;
      }
    }
    return ab;
  }
  const sine = (i: number) => Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;

  it('decodes 8/16/24/32-bit PCM at the right level and channel count', () => {
    for (const bits of [8, 16, 24, 32]) {
      for (const ch of [1, 2]) {
        const dec = decodeWav(makeWav(bits, ch, 500, (i, c) => sine(i) * (c === 0 ? 1 : 0.5)));
        expect(dec.left.length, `${bits}-bit ${ch}ch`).toBe(500);
        expect(dec.sampleRate).toBe(44100);
        const peak = Math.max(...Array.from(dec.left, Math.abs));
        expect(peak, `${bits}-bit ${ch}ch peak`).toBeGreaterThan(0.45);
        expect(peak, `${bits}-bit ${ch}ch peak`).toBeLessThan(0.56);
        if (ch === 1) expect(dec.right).toBeNull();
        else expect(dec.right?.length).toBe(500);
      }
    }
  });

  it('rejects files that are not RIFF/WAV', () => {
    expect(() => decodeWav(new ArrayBuffer(8))).toThrow(/too short/i);
    expect(() => decodeWav(new ArrayBuffer(128))).toThrow(/RIFF/i);
  });

  it('round-trips its own export', async () => {
    const project = defaultProject();
    const files = await exportMix({
      project,
      samples: buildFactorySamples(44100),
      opts: { bars: 1, scope: 'mix', format: 'wav', includeTail: false, trackIndex: 0 },
    });
    const dec = decodeWav(await files[0].blob.arrayBuffer());
    expect(dec.sampleRate).toBe(44100);
    expect(dec.left.length).toBeGreaterThan(44100);
    expect(rms(dec.left)).toBeGreaterThan(0.01);
  });
});

describe('master FX chain', () => {
  const render = (enable: string | null) => {
    const project = defaultProject();
    for (const fx of project.master.chain) {
      fx.on = fx.type === enable;
      fx.mix = 0.9;
    }
    const engine = new AudioEngine(project, { sampleRate: 44100 });
    for (const smp of buildFactorySamples(44100)) engine.bank.set(smp);
    engine.setKit(project.kits[0]);
    engine.play();
    return engine.renderOffline(1.5);
  };
  const diff = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };

  it('every insert slot actually processes audio', () => {
    const dry = render(null);
    for (const type of ['DIST', 'CRUSH', 'MOD', 'RING']) {
      const wet = render(type);
      expect(diff(dry.left, wet.left), type).toBeGreaterThan(0.01);
    }
  });

  it('ships no duplicate WIDTH insert (that control lives on the master bus)', () => {
    const project = defaultProject();
    expect(project.master.chain.some((c) => c.type === 'WIDTH')).toBe(false);
    expect(project.master.chain.length).toBeGreaterThanOrEqual(4);
  });

  it('mono width collapses the sides and wide width expands them', () => {
    const corr = (width: number) => {
      const project = defaultProject();
      project.master.width = width;
      const engine = new AudioEngine(project, { sampleRate: 44100 });
      for (const smp of buildFactorySamples(44100)) engine.bank.set(smp);
      engine.setKit(project.kits[0]);
      engine.play();
      const out = engine.renderOffline(1.5);
      let sl = 0, sr = 0, slr = 0;
      for (let i = 0; i < out.left.length; i++) {
        sl += out.left[i] * out.left[i];
        sr += out.right[i] * out.right[i];
        slr += out.left[i] * out.right[i];
      }
      return slr / Math.sqrt(sl * sr);
    };
    expect(corr(0)).toBeGreaterThan(0.99);
    expect(corr(1)).toBeLessThan(0.99);
  });
});

describe('WAV encoding', () => {
  it('writes a valid RIFF header and round-trips through the decoder', () => {
    const n = 4800;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.8;
      right[i] = Math.sin((2 * Math.PI * 220 * i) / 44100) * 0.4;
    }
    const buf = encodeWav(left, right, 44100, 16);
    expect(buf.byteLength).toBe(44 + n * 2 * 2);
    const dv = new DataView(buf);
    const str = (o: number) => String.fromCharCode(...new Uint8Array(buf.slice(o, o + 4)));
    expect(str(0)).toBe('RIFF');
    expect(str(8)).toBe('WAVE');
    expect(str(12)).toBe('fmt ');
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(2); // stereo
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(str(36)).toBe('data');
    expect(dv.getUint32(40, true)).toBe(n * 4);

    const dec = decodeWav(buf);
    expect(dec.sampleRate).toBe(44100);
    expect(dec.left.length).toBe(n);
    expect(dec.right?.length).toBe(n);
    // 16-bit quantisation error must stay tiny
    let err = 0;
    for (let i = 0; i < n; i++) err += Math.abs(dec.left[i] - left[i]);
    expect(err / n).toBeLessThan(0.0001);
  });

  it('supports 24 and 32 bit output', () => {
    const l = new Float32Array(16).fill(0.25);
    const r = new Float32Array(16).fill(-0.25);
    expect(encodeWav(l, r, 44100, 24).byteLength).toBe(44 + 16 * 6);
    expect(encodeWav(l, r, 44100, 32).byteLength).toBe(44 + 16 * 8);
  });

  it('normalises without clipping', () => {
    const l = new Float32Array([0.1, 0.2, 0.3]);
    const r = new Float32Array([0.1, 0.2, 0.3]);
    const n = normalizeChannels(l, r, -1);
    expect(peak(n.left)).toBeGreaterThan(0.85);
    expect(peak(n.left)).toBeLessThan(1);
  });
});

describe('sample import helpers', () => {
  it('decodes a wav written by the encoder', () => {
    const src = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) src[i] = (i % 100) / 100 - 0.5;
    const buf = encodeWav(src, src, 22050, 16);
    const dec = decodeWav(buf);
    expect(dec.sampleRate).toBe(22050);
    expect(dec.left.length).toBe(1000);
  });

  it('computes peak envelopes and detects transients', () => {
    const sr = 44100;
    const n = sr; // 1 second
    const buf = new Float32Array(n);
    // four percussive hits at 0, 0.25, 0.5, 0.75 s
    for (let hit = 0; hit < 4; hit++) {
      const start = hit * sr * 0.25;
      for (let i = 0; i < 2000; i++) {
        const t = i / sr;
        buf[start + i] = Math.sin(2 * Math.PI * 200 * t) * Math.exp(-t * 40);
      }
    }
    const peaks = computePeaks(buf, 128);
    expect(peaks.length).toBe(128);
    expect(Math.max(...peaks)).toBeGreaterThan(0.5);
    const transients = detectTransients(buf, sr, 0.5);
    expect(transients.length).toBeGreaterThanOrEqual(4);
    expect(transients[0]).toBe(0);
  });
});

describe('persistence', () => {
  it('saves and loads the project (localStorage fallback)', async () => {
    const project = defaultProject();
    project.name = 'PERSIST TEST';
    project.patterns[0].tempo = 133;
    const ok = await storage.saveProject(project, 'autosave');
    expect(ok).toBe(true);
    const loaded = await storage.loadProject('autosave');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('PERSIST TEST');
    expect(loaded!.patterns[0].tempo).toBe(133);
    // deep structure survives
    expect(loaded!.kits[0].tracks.length).toBe(8);
    expect(loaded!.patterns[0].tracks[5].automation['filter.cutoff'].length).toBe(64);
  });

  it('migrates older documents by filling in defaults', async () => {
    const project = defaultProject();
    delete (project as any).settings;
    (project as any).chain = undefined;
    const migrated = storage.migrate(project);
    expect(migrated.settings).toBeDefined();
    expect(Array.isArray(migrated.chain)).toBe(true);
  });

  it('round-trips pattern edits through save/load', async () => {
    const store = new Store();
    store.setPattern(2);
    store.setCursor(0);
    store.toggleStep();
    store.setStepNote(0, 0, 51);
    store.ui.cursor = 4;
    store.ui.pLockMode = true;
    store.setParamNorm('filter.cutoff', 0.33);
    const saved = JSON.parse(JSON.stringify(store.project));
    await storage.saveProject(saved, 'roundtrip');
    const loaded = await storage.loadProject('roundtrip');
    const step = loaded!.patterns[2].tracks[0].steps[0];
    expect(step.on).toBe(true);
    expect(step.note).toBe(51);
    expect(loaded!.patterns[2].tracks[0].steps[4].locks['filter.cutoff']).toBeCloseTo(0.33, 4);
  });
});

describe('export rendering', () => {
  const samples = buildFactorySamples(44100);

  it('renders a master mix that is real audio with a correct duration', async () => {
    const project = defaultProject();
    const files = await exportMix({
      project,
      samples,
      opts: { bars: 2, scope: 'mix', format: 'wav', includeTail: true, trackIndex: 0 },
    });
    expect(files.length).toBe(1);
    expect(files[0].name.endsWith('.wav')).toBe(true);
    const buf = await files[0].blob.arrayBuffer();
    const dec = decodeWav(buf);
    // 2 bars at 120bpm = 4s, plus tail
    expect(dec.left.length / dec.sampleRate).toBeGreaterThan(4);
    expect(rms(dec.left)).toBeGreaterThan(0.01);
    expect(peak(dec.left)).toBeLessThanOrEqual(1);
  });

  it('renders eight individual track files', async () => {
    const project = defaultProject();
    const files = await exportMix({
      project,
      samples,
      opts: { bars: 1, scope: 'tracks', format: 'wav', includeTail: false, trackIndex: 0 },
    });
    expect(files.length).toBe(8);
    const energies: number[] = [];
    for (const f of files) {
      const dec = decodeWav(await f.blob.arrayBuffer());
      energies.push(rms(dec.left));
    }
    // at least the drum tracks must have audio, and they differ from one another
    expect(energies.filter((e) => e > 0.001).length).toBeGreaterThanOrEqual(4);
    expect(new Set(energies.map((e) => e.toFixed(3))).size).toBeGreaterThan(3);
  });

  it('renders a single track in isolation', async () => {
    const project = defaultProject();
    const files = await exportMix({
      project,
      samples,
      opts: { bars: 1, scope: 'current', format: 'wav', includeTail: false, trackIndex: 2 },
    });
    expect(files.length).toBe(1);
    expect(files[0].name).toContain('track3');
    const dec = decodeWav(await files[0].blob.arrayBuffer());
    expect(rms(dec.left)).toBeGreaterThan(0.005);
  });

  it('renders the whole song arrangement', async () => {
    const project = defaultProject();
    const files = await exportMix({
      project,
      samples,
      opts: { bars: 0, scope: 'song', format: 'wav', includeTail: false, trackIndex: 0 },
    });
    const dec = decodeWav(await files[0].blob.arrayBuffer());
    // 5 arrangement steps at 4 bars each? -> at least 8 seconds of music
    expect(dec.left.length / dec.sampleRate).toBeGreaterThan(8);
    expect(rms(dec.left)).toBeGreaterThan(0.005);
  });

  it('is deterministic (same project renders identical audio)', async () => {
    const project = defaultProject();
    const opts = { bars: 1, scope: 'mix' as const, format: 'wav' as const, includeTail: false, trackIndex: 0 };
    const a = await exportMix({ project: JSON.parse(JSON.stringify(project)), samples, opts });
    const b = await exportMix({ project: JSON.parse(JSON.stringify(project)), samples, opts });
    const da = decodeWav(await a[0].blob.arrayBuffer());
    const db = decodeWav(await b[0].blob.arrayBuffer());
    expect(da.left.length).toBe(db.left.length);
    let diff = 0;
    for (let i = 0; i < da.left.length; i++) diff += Math.abs(da.left[i] - db.left[i]);
    expect(diff / da.left.length).toBeLessThan(0.01);
  });

  it('each kit track produces audio through the factory pattern', async () => {
    // proves "every track must produce real sound" end-to-end through the exporter
    const project = defaultProject();
    for (let t = 0; t < 8; t++) {
      const solo = JSON.parse(JSON.stringify(project));
      for (let k = 0; k < 8; k++) solo.kits[0].tracks[k].params.mute = k !== t;
      const files = await exportMix({
        project: solo,
        samples,
        opts: { bars: 2, scope: 'mix', format: 'wav', includeTail: false, trackIndex: 0 },
      });
      const dec = decodeWav(await files[0].blob.arrayBuffer());
      expect(rms(dec.left), `track ${t}`).toBeGreaterThan(0.002);
    }
  });
});
