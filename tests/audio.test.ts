import { describe, it, expect } from 'vitest';
import { AudioEngine } from '../src/audio/engine';
import { defaultProject, defaultTrackParams, applyFMPreset, FM_PRESETS, MONO_PRESETS } from '../src/state/presets';
import { buildFactorySamples } from '../src/audio/sample';
import { rms, peak, noteToHz } from '../src/audio/dsp';
import { FM_RATIOS } from '../src/state/params';
import { MONO_ENGINES } from '../src/audio/mono';

function makeEngine() {
  const project = defaultProject();
  const engine = new AudioEngine(project, { sampleRate: 44100, blockSize: 256 });
  for (const s of buildFactorySamples(44100)) engine.bank.set(s);
  return { engine, project };
}

/** Render `frames` of engine output (no sequencer) into fresh buffers. */
function render(engine: AudioEngine, frames: number) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let done = 0;
  const bl = new Float32Array(256);
  const br = new Float32Array(256);
  while (done < frames) {
    const n = Math.min(256, frames - done);
    bl.fill(0);
    br.fill(0);
    engine.processInto(bl, br, n);
    l.set(bl.subarray(0, n), done);
    r.set(br.subarray(0, n), done);
    done += n;
  }
  return { left: l, right: r };
}

/** Coarse fundamental estimator via autocorrelation, used to prove tuning. */
function estimatePitch(buf: Float32Array, sr = 44100): number {
  const start = 2048;
  const len = 4096;
  let bestLag = 0;
  let bestVal = -1;
  for (let lag = Math.floor(sr / 1200); lag < sr / 50; lag++) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += buf[start + i] * buf[start + i + lag];
    if (sum > bestVal) {
      bestVal = sum;
      bestLag = lag;
    }
  }
  return sr / bestLag;
}

describe('FM engine', () => {
  it('produces audible output on a fresh default track', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('fm');
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(48, 0.9);
    const out = render(engine, 4410);
    expect(rms(out.left)).toBeGreaterThan(0.01);
  });

  it('every factory FM preset makes sound', () => {
    const { engine } = makeEngine();
    for (const preset of FM_PRESETS) {
      const p = defaultTrackParams('fm');
      applyFMPreset(p, preset.name);
      engine.kit.tracks[0].params = p;
      engine.setKit(engine.kit);
      engine.tracks[0].allNotesOff();
      engine.tracks[0].noteOn(57, 1);
      const out = render(engine, 8820);
      expect(rms(out.left), `preset ${preset.name}`).toBeGreaterThan(0.002);
      engine.tracks[0].allNotesOff();
    }
  });

  it('tracks the played note', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('fm');
    // pure carrier: index 0 so no modulation sidebands disturb the fundamental
    p.fm.index = 0;
    p.fm.ops[0].ratio = 3 / (FM_RATIOS.length - 1); // ratio 1.0
    p.amp.atk = 0;
    p.filter.cutoff = 18000;
    p.filter.type = 'LP12';
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(69, 1); // A4 = 440
    const out = render(engine, 22050);
    const f = estimatePitch(out.left);
    expect(f).toBeGreaterThan(400);
    expect(f).toBeLessThan(480);
  });

  it('FM index changes timbre (more sidebands = more high-band energy)', () => {
    // Two-operator patch: op2 modulates op1 (algorithm 1 = CHAIN), so INDEX alone
    // controls how much sideband energy appears above the fundamental.
    const bandEnergy = (buf: Float32Array, f0: number, f1: number) => {
      let e = 0;
      for (let f = f0; f <= f1; f += 40) {
        const w = (2 * Math.PI * f) / 44100;
        let re = 0;
        let im = 0;
        for (let i = 0; i < 4096; i++) {
          re += buf[i] * Math.cos(w * i);
          im += buf[i] * Math.sin(w * i);
        }
        e += re * re + im * im;
      }
      return e;
    };
    const measure = (index: number) => {
      const e2 = new AudioEngine(defaultProject(), { sampleRate: 44100 });
      const p = defaultTrackParams('fm');
      p.fm.algorithm = 0;
      p.fm.ops[0].ratio = 3 / (FM_RATIOS.length - 1);
      p.fm.ops[0].level = 0.9;
      p.fm.ops[1].ratio = 3 / (FM_RATIOS.length - 1);
      p.fm.ops[1].level = 1;
      p.fm.ops[2].level = 0;
      p.fm.ops[3].level = 0;
      p.fm.index = index;
      p.amp.atk = 0.4;
      p.amp.sus = 1;
      p.filter.cutoff = 18000;
      e2.kit.tracks[0].params = p;
      e2.setKit(e2.kit);
      e2.tracks[0].noteOn(60, 1);
      const out = render(e2, 12000);
      const seg = out.left.subarray(4000, 8096);
      return bandEnergy(seg, 1500, 8000) / bandEnergy(seg, 200, 900);
    };
    const low = measure(0);
    const high = measure(1);
    expect(high).toBeGreaterThan(low * 5);
  });
});

describe('Mono engine', () => {
  it('all eight engines produce distinct, audible output', () => {
    const { engine } = makeEngine();
    const spectra: number[] = [];
    for (const id of MONO_ENGINES) {
      const p = defaultTrackParams('mono');
      p.mono.engine = id;
      p.mono.p1 = 0.5;
      p.mono.p2 = 0.5;
      p.mono.tone = 0.9;
      p.filter.cutoff = 18000;
      engine.kit.tracks[0].params = p;
      engine.setKit(engine.kit);
      engine.tracks[0].allNotesOff();
      engine.tracks[0].noteOn(48, 1);
      const out = render(engine, 8820);
      const r = rms(out.left);
      expect(r, `engine ${id}`).toBeGreaterThan(0.005);
      // fingerprint: zero-crossing rate
      let zc = 0;
      for (let i = 1; i < out.left.length; i++) {
        if ((out.left[i] >= 0) !== (out.left[i - 1] >= 0)) zc++;
      }
      spectra.push(zc / out.left.length);
      engine.tracks[0].allNotesOff();
    }
    // Engines must not sound the same. Zero-crossing rate separates bright models (SID,
    // ringmod, digital) from warm ones (analog, wavetable) and every model differs from
    // the analog reference in its crossing density.
    const unique = new Set(spectra.map((z) => Math.round(z * 100)));
    expect(unique.size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < spectra.length; i++) {
      expect(Math.abs(spectra[i] - spectra[0]), `engine ${MONO_ENGINES[i]} vs analog`)
        .toBeGreaterThan(0.0005);
    }
  });

  it('every mono preset makes sound', () => {
    const { engine } = makeEngine();
    for (const preset of MONO_PRESETS) {
      const p = defaultTrackParams('mono');
      Object.assign(p.mono, preset.params);
      if (preset.amp) Object.assign(p.amp, preset.amp);
      if (preset.filter) Object.assign(p.filter, preset.filter);
      engine.kit.tracks[0].params = p;
      engine.setKit(engine.kit);
      engine.tracks[0].allNotesOff();
      engine.tracks[0].noteOn(45, 1);
      const out = render(engine, 8820);
      expect(rms(out.left), `mono preset ${preset.name}`).toBeGreaterThan(0.002);
      engine.tracks[0].allNotesOff();
    }
  });
});

describe('Sample engine', () => {
  it('plays factory samples', () => {
    const { engine } = makeEngine();
    for (const id of ['factory-vox-ah', 'factory-hiss', 'factory-clang', 'factory-break', 'factory-sub']) {
      const p = defaultTrackParams('sample');
      p.sample.sampleId = id;
      engine.kit.tracks[0].params = p;
      engine.setKit(engine.kit);
      engine.tracks[0].allNotesOff();
      engine.tracks[0].noteOn(60, 1);
      const out = render(engine, 8820);
      expect(rms(out.left), `sample ${id}`).toBeGreaterThan(0.002);
    }
  });

  it('detects transients in the factory break', () => {
    const samples = buildFactorySamples(44100);
    const brk = samples.find((s) => s.meta.id === 'factory-break')!;
    // 16th grid with kick+snare+hats → at least 8 detected transients
    expect(brk.meta.transients.length).toBeGreaterThanOrEqual(8);
  });

  it('reverse changes the waveform', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('sample');
    p.sample.sampleId = 'factory-clang';
    p.sample.start = 0;
    p.sample.end = 1;
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(60, 1);
    const fwd = render(engine, 4096);
    engine.tracks[0].allNotesOff();
    const p2 = JSON.parse(JSON.stringify(p));
    p2.sample.reverse = true;
    engine.kit.tracks[0].params = p2;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(60, 1);
    const rev = render(engine, 4096);
    let diff = 0;
    for (let i = 0; i < 4096; i++) diff += Math.abs(fwd.left[i] - rev.left[i]);
    expect(diff / 4096).toBeGreaterThan(0.001);
  });

  it('slices trigger different regions', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('sample');
    p.sample.sampleId = 'factory-break';
    p.sample.slices = 8;
    p.sample.sus = 1;
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    const a = (() => {
      engine.tracks[0].noteOn(60, 1);
      return render(engine, 2205);
    })();
    engine.tracks[0].allNotesOff();
    const b = (() => {
      engine.tracks[0].noteOn(63, 1); // slice 3
      return render(engine, 2205);
    })();
    let diff = 0;
    for (let i = 0; i < 2205; i++) diff += Math.abs(a.left[i] - b.left[i]);
    expect(diff / 2205).toBeGreaterThan(0.0005);
  });

  it('choke groups cut the previous hit', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('sample');
    p.sample.sampleId = 'factory-break';
    p.sample.loopMode = 'forward';
    p.sample.choke = 2;
    p.sample.sus = 1;
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(60, 1);
    render(engine, 4410);
    engine.tracks[0].noteOn(64, 1);
    expect(engine.tracks[0].activeVoices).toBeLessThanOrEqual(1);
  });
});

describe('Mixer / effects', () => {
  it('track volume and pan affect the output', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('mono');
    p.volume = 1;
    p.pan = -1;
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(48, 1);
    const out = render(engine, 4410);
    expect(rms(out.left)).toBeGreaterThan(rms(out.right) * 2);
  });

  it('filter cutoff changes brightness', () => {
    const { engine } = makeEngine();
    const bright = (cutoff: number) => {
      const p = defaultTrackParams('mono');
      p.filter.cutoff = cutoff;
      p.filter.type = 'LP24';
      p.filter.reso = 0.1;
      p.mono.tone = 1;
      engine.kit.tracks[0].params = p;
      engine.setKit(engine.kit);
      engine.tracks[0].allNotesOff();
      engine.tracks[0].noteOn(45, 1);
      const out = render(engine, 8192);
      let hf = 0;
      for (let i = 1; i < out.left.length; i++) hf += Math.abs(out.left[i] - out.left[i - 1]);
      return hf;
    };
    expect(bright(18000)).toBeGreaterThan(bright(300) * 2);
  });

  it('reverb send adds a decaying tail', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('mono');
    p.sendB = 1;
    p.sendA = 0;
    engine.kit.tracks[0].params = p;
    engine.kit.sends.revSize = 1;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(48, 1);
    render(engine, 4410);
    engine.tracks[0].allNotesOff();
    // after the source is gated off the tail must still be audible
    const tail = render(engine, 22050);
    expect(peak(tail.left)).toBeGreaterThan(0.001);
  });

  it('master distortion alters the signal', () => {
    const { engine } = makeEngine();
    const p = defaultTrackParams('mono');
    p.fx.distortion = 0;
    engine.kit.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(45, 1);
    const clean = render(engine, 4096);
    engine.tracks[0].allNotesOff();
    p.fx.distortion = 0.9;
    engine.tracks[0].params = p;
    engine.setKit(engine.kit);
    engine.tracks[0].noteOn(45, 1);
    const dirty = render(engine, 4096);
    let d = 0;
    for (let i = 0; i < 4096; i++) d += Math.abs(clean.left[i] - dirty.left[i]);
    expect(d / 4096).toBeGreaterThan(0.001);
  });

  it('noteToHz is correct', () => {
    expect(noteToHz(69)).toBeCloseTo(440, 3);
    expect(noteToHz(57)).toBeCloseTo(220, 3);
  });
});
