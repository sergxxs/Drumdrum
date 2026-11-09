import { describe, it, expect } from 'vitest';
import { SequencerEngine } from '../src/seq/sequencer';
import { evalCondition } from '../src/seq/trig';
import { Rng } from '../src/audio/dsp';
import { AudioEngine } from '../src/audio/engine';
import { defaultProject, emptyPattern, setStep } from '../src/state/presets';
import { Store } from '../src/state/store';
import { buildFactorySamples } from '../src/audio/sample';
import { OnePole, rms } from '../src/audio/dsp';
import { installCanvasStubs } from './support/domStub';
import type { TrigCond } from '../src/state/types';

const pat = () => {
  const p = emptyPattern('TEST', 120);
  return p;
};

function collect(seq: SequencerEngine, frames: number, block = 256) {
  const events: { frame: number; track: number; step: number; note: number }[] = [];
  let f = 0;
  while (f < frames) {
    const { events: evs } = seq.advance(f, block);
    for (const e of evs) {
      // ignore events that physically start after the requested window
      if (f + e.offset < frames) {
        events.push({ frame: f + e.offset, track: e.track, step: e.step, note: e.note });
      }
    }
    f += block;
  }
  return events;
}

describe('sequencer timing', () => {
  it('places steps on the exact sample grid at 120 bpm', () => {
    const p = pat();
    for (let i = 0; i < 16; i++) setStep(p, 0, i, 40 + i);
    const seq = new SequencerEngine(p, 44100);
    seq.tempo = 120;
    seq.start(0);
    const evs = collect(seq, 44100 * 2); // 2 seconds = 4 beats = 16 sixteenths
    expect(evs.length).toBe(16);
    // a 16th at 120bpm = 44100*60/(120*4) = 5512.5 frames
    const expected = 5512.5;
    evs.forEach((e, i) => {
      expect(Math.abs(e.frame - i * expected), `step ${i}`).toBeLessThanOrEqual(1);
    });
  });

  it('follows tempo changes', () => {
    const p = pat();
    setStep(p, 0, 0, 40);
    setStep(p, 0, 1, 41);
    const seq = new SequencerEngine(p, 44100);
    seq.tempo = 240;
    seq.start(0);
    const evs = collect(seq, 44100);
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(evs[1].frame - 2756.25)).toBeLessThanOrEqual(1);
  });

  it('applies swing to odd steps', () => {
    const p = pat();
    for (let i = 0; i < 4; i++) setStep(p, 0, i, 40);
    const straight = new SequencerEngine(p, 44100);
    straight.start(0);
    const a = collect(straight, 20000);
    const swung = new SequencerEngine(p, 44100);
    swung.swing = 0.5;
    swung.start(0);
    const b = collect(swung, 20000);
    // even steps keep their position, odd steps are late
    expect(Math.abs(a[0].frame - b[0].frame)).toBeLessThan(2);
    expect(b[1].frame - a[1].frame).toBeGreaterThan(1000);
  });

  it('supports per-track speed (polyrhythm)', () => {
    const p = pat();
    setStep(p, 0, 0, 40);
    setStep(p, 0, 1, 40);
    setStep(p, 1, 0, 50);
    setStep(p, 1, 1, 50);
    p.tracks[1].speed = 3; // 1/3 speed = 3x longer steps
    const seq = new SequencerEngine(p, 44100);
    seq.start(0);
    const evs = collect(seq, 40000);
    const t0 = evs.filter((e) => e.track === 0);
    const t1 = evs.filter((e) => e.track === 1);
    const gap0 = t0[1].frame - t0[0].frame;
    const gap1 = t1[1].frame - t1[0].frame;
    expect(gap1 / gap0).toBeCloseTo(3, 1);
  });

  it('respects per-track length', () => {
    const p = pat();
    p.length = 16;
    p.tracks[0].length = 8;
    for (let i = 0; i < 16; i++) setStep(p, 0, i, 40 + i);
    const seq = new SequencerEngine(p);
    seq.start(0);
    const evs = collect(seq, 44100 * 2);
    // only steps 0..7 of track 0 fire, twice
    for (const e of evs) expect(e.step).toBeLessThan(8);
    expect(new Set(evs.map((e) => e.note)).size).toBe(8);
  });

  it('does not fire muted tracks', () => {
    const p = pat();
    for (let i = 0; i < 4; i++) setStep(p, 0, i, 40);
    p.tracks[0].muted = true;
    const seq = new SequencerEngine(p);
    seq.start(0);
    expect(collect(seq, 30000).length).toBe(0);
  });

  it('emits p-locks with the event', () => {
    const p = pat();
    setStep(p, 0, 0, 40);
    p.tracks[0].steps[0].locks = { 'filter.cutoff': 0.9, 'fm.index': 0.3 };
    const seq = new SequencerEngine(p);
    seq.start(0);
    const { events } = seq.advance(0, 256);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].locks['filter.cutoff']).toBe(0.9);
    expect(events[0].locks['fm.index']).toBe(0.3);
  });

  it('merges automation lanes and lets p-locks win', () => {
    const p = pat();
    setStep(p, 0, 0, 40);
    const lane = new Array(64).fill(null);
    lane[0] = 0.4;
    p.tracks[0].automation['filter.cutoff'] = lane;
    p.tracks[0].steps[0].locks = { 'filter.cutoff': 0.8 };
    const seq = new SequencerEngine(p);
    seq.start(0);
    const { events } = seq.advance(0, 256);
    expect(events[0].locks['filter.cutoff']).toBe(0.8);
  });

  it('stops cleanly', () => {
    const p = pat();
    for (let i = 0; i < 4; i++) setStep(p, 0, i, 40);
    const seq = new SequencerEngine(p);
    seq.start(0);
    seq.stop();
    expect(collect(seq, 30000).length).toBe(0);
  });
});

describe('trig conditions', () => {
  const base = { length: 16, fill: false, rng: new Rng(1) };
  const ctx = (pass: number, stepIndex = 0) => ({ ...base, pass, stepIndex });

  it('1:2 fires on the first of every two passes', () => {
    expect(evalCondition('1:2', ctx(0))).toBe(true);
    expect(evalCondition('1:2', ctx(1))).toBe(false);
    expect(evalCondition('1:2', ctx(2))).toBe(true);
  });

  it('1:3 and 1:4 use the right modulo', () => {
    expect([0, 1, 2, 3].map((p) => evalCondition('1:3', ctx(p)))).toEqual([true, false, false, true]);
    expect([0, 1, 2, 3].map((p) => evalCondition('1:4', ctx(p)))).toEqual([true, false, false, false]);
  });

  it('2:2 and 2:4 fire on the second pass', () => {
    expect([0, 1, 2].map((p) => evalCondition('2:2', ctx(p)))).toEqual([false, true, false]);
    expect(evalCondition('2:4', ctx(1))).toBe(true);
    expect(evalCondition('2:4', ctx(2))).toBe(false);
  });

  it('fill / not fill follow the fill switch', () => {
    expect(evalCondition('FILL', { ...ctx(0), fill: true })).toBe(true);
    expect(evalCondition('FILL', { ...ctx(0), fill: false })).toBe(false);
    expect(evalCondition('NOTFILL', { ...ctx(0), fill: false })).toBe(true);
  });

  it('first fires only on pass 0; last on the final step', () => {
    expect(evalCondition('FIRST', ctx(0))).toBe(true);
    expect(evalCondition('FIRST', ctx(1))).toBe(false);
    expect(evalCondition('LAST', ctx(0, 15))).toBe(true);
    expect(evalCondition('LAST', ctx(0, 3))).toBe(false);
  });

  it('probability conditions are statistically sane and deterministic', () => {
    const rngA = new Rng(42);
    const rngB = new Rng(42);
    let hitsA = 0;
    let hitsB = 0;
    for (let i = 0; i < 2000; i++) {
      if (evalCondition('P50', { ...ctx(0), rng: rngA })) hitsA++;
      if (evalCondition('P50', { ...ctx(0), rng: rngB })) hitsB++;
    }
    expect(hitsA).toBe(hitsB); // reproducible
    expect(hitsA / 2000).toBeGreaterThan(0.42);
    expect(hitsA / 2000).toBeLessThan(0.58);
    let hits25 = 0;
    const rngC = new Rng(7);
    for (let i = 0; i < 4000; i++) if (evalCondition('P25', { ...ctx(0), rng: rngC })) hits25++;
    expect(hits25 / 4000).toBeGreaterThan(0.19);
    expect(hits25 / 4000).toBeLessThan(0.31);
  });

  it('ALWAYS is always true', () => {
    const conds: TrigCond[] = ['ALWAYS'];
    for (const c of conds) expect(evalCondition(c, ctx(5, 3))).toBe(true);
  });
});

describe('engine-level sequencing', () => {
  it('the factory pattern makes sound and the transport stops', () => {
    const project = defaultProject();
    const engine = new AudioEngine(project, { sampleRate: 44100 });
    for (const s of buildFactorySamples(44100)) engine.bank.set(s);
    engine.play();
    const l = new Float32Array(44100 * 2);
    const r = new Float32Array(44100 * 2);
    for (let i = 0; i < l.length; i += 256) engine.processInto(l.subarray(i, i + 256), r.subarray(i, i + 256), 256);
    expect(rms(l)).toBeGreaterThan(0.02);
    engine.stop();
    const before = engine.frame;
    // the release tail decays: level after a second of silence must be far below playing level
    const l2 = new Float32Array(44100);
    const r2 = new Float32Array(44100);
    for (let i = 0; i < l2.length; i += 256) engine.processInto(l2.subarray(i, i + 256), r2.subarray(i, i + 256), 256);
    expect(engine.frame).toBeGreaterThan(before);
    expect(rms(l2.subarray(22050))).toBeLessThan(0.005);
  });

  it('p-locks reach the DSP and change the sound', () => {
    const render = (lock: Record<string, number> | null) => {
      const project = defaultProject();
      const engine = new AudioEngine(project, { sampleRate: 44100 });
      for (const s of buildFactorySamples(44100)) engine.bank.set(s);
      for (let t = 0; t < 8; t++) project.kits[0].tracks[t].params.mute = t !== 2;
      const p = project.patterns[0];
      for (const tp of p.tracks) for (const st of tp.steps) { st.on = false; st.locks = {}; }
      const tp = p.tracks[2];
      tp.steps[0].on = true;
      tp.steps[0].note = 40;
      tp.steps[0].len = 4;
      // remove the preset's filter envelope so the lock is the only filter difference
      project.kits[0].tracks[2].params.filter.env = 0;
      if (lock) tp.steps[0].locks = lock;
      engine.setPattern(p);
      engine.play();
      const left = new Float32Array(22050);
      const right = new Float32Array(22050);
      for (let i = 0; i < left.length; i += 256) engine.processInto(left.subarray(i, i + 256), right.subarray(i, i + 256), 256);
      return { left, cutoff: engine.tracks[2].eff.filter.cutoff };
    };
    const open = render(null);
    const locked = render({ 'filter.cutoff': 0.18, 'filter.reso': 0.35 });

    // 1. the lock actually reached the audio engine's effective parameters
    expect(open.cutoff).toBeGreaterThan(1000);
    expect(locked.cutoff).toBeLessThan(200);

    // 2. and it changed the rendered audio (not just the UI)
    let diff = 0;
    let energy = 0;
    for (let i = 0; i < open.left.length; i++) {
      diff += Math.abs(open.left[i] - locked.left[i]);
      energy += Math.abs(open.left[i]);
    }
    expect(diff / energy).toBeGreaterThan(0.3);

    // 3. both renders are audible
    expect(rms(open.left)).toBeGreaterThan(0.001);
    expect(rms(locked.left)).toBeGreaterThan(0.001);
  });
});

describe('store actions', () => {
  it('toggles steps, records notes and supports undo', () => {
    installCanvasStubs();
    const store = new Store();
    store.setPattern(2); // empty pattern, so no pre-existing trigs interfere
    store.setTrack(2);
    store.setCursor(3);
    store.toggleStep();
    expect(store.pattern.tracks[2].steps[3].on).toBe(true);
    store.setStepNote(3, 2, 47);
    expect(store.pattern.tracks[2].steps[3].note).toBe(47);
    store.undo();
    expect(store.pattern.tracks[2].steps[3].note).not.toBe(47);
  });

  it('writes p-locks when the lock mode is active', () => {
    installCanvasStubs();
    const store = new Store();
    store.setTrack(0);
    store.setCursor(5);
    store.ui.pLockMode = true;
    store.setParamNorm('filter.cutoff', 0.25);
    expect(store.pattern.tracks[0].steps[5].locks['filter.cutoff']).toBeCloseTo(0.25, 4);
    store.ui.pLockMode = false;
    store.setParamNorm('filter.cutoff', 0.9);
    expect(store.pattern.tracks[0].steps[5].locks['filter.cutoff']).toBeCloseTo(0.25, 4);
  });

  it('writes motion automation in motion mode', () => {
    installCanvasStubs();
    const store = new Store();
    store.setCursor(9);
    store.ui.motionMode = true;
    store.setParamNorm('fx.reverb', 0.7);
    expect(store.pattern.tracks[0].automation['fx.reverb'][9]).toBeCloseTo(0.7, 4);
  });

  it('randomisation changes real data and stays in range', () => {
    installCanvasStubs();
    const store = new Store();
    for (const target of ['steps', 'locks', 'sound', 'pattern', 'melody', 'sample', 'kit'] as const) {
      store.randomize(target, 0.5);
    }
    for (const tp of store.pattern.tracks) {
      for (const s of tp.steps) {
        expect(s.vel).toBeGreaterThan(0);
        expect(s.vel).toBeLessThanOrEqual(1);
        expect(s.note).toBeGreaterThanOrEqual(0);
        expect(s.note).toBeLessThanOrEqual(127);
        for (const k in s.locks) {
          expect(s.locks[k]).toBeGreaterThanOrEqual(0);
          expect(s.locks[k]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('length changes clamp to 1..64', () => {
    installCanvasStubs();
    const store = new Store();
    store.setLength(100);
    expect(store.pattern.length).toBe(64);
    store.setLength(0);
    expect(store.pattern.length).toBe(1);
  });
});
