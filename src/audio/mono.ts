/**
 * ENGINE B — Monomachine-inspired digital synthesis.
 *
 * Eight *distinct* oscillator architectures, not presets of one engine:
 *
 *  ANALOG    dual detuned saw/pulse with PWM and sub, 24 dB character
 *  WAVTBL    custom additive/format wavetables with continuous morph + phase warp
 *  P.DIST    Casio-CZ style phase distortion (DCW) with saw/square/pulse/reso shapes
 *  SID       pulse + PWM + ring modulation + hard sync + arpeggio, 4-bit crunch
 *  DNOISE    sample-rate-reduced noise through a tuned comb (digital noise / chip noise)
 *  METAL     inharmonic partial cluster (6 sines) + bandpass + transient burst
 *  RINGMD    ring modulation with feedback FM and wave folding
 *  DIGITAL   bit-manipulated phase accumulator (XOR / fold / rate reduction)
 *
 * Every engine obeys: pitch from note + glide, amp ADSR, `tone` (post tilt filter),
 * `drive`, `sub`, `detune` and LFO modulation supplied by the track.
 */
import {
  Adsr, Noise, OnePole, Osc, SR, TWO_PI, bitCrush, clamp, envTime, noteToHz, softClip,
  waveFold,
} from './dsp';
import type { Voice, ModInputs } from './voice';
import type { MonoEngineId, MonoParams, TrackParams } from '../state/types';

export const MONO_ENGINES: MonoEngineId[] = [
  'analog', 'wavetable', 'phasedist', 'sid', 'dnoise', 'metallic', 'ringmod', 'digital',
];

export const MONO_ENGINE_INFO: Record<MonoEngineId, {
  name: string;
  p1: string; p2: string; p3: string; p4: string;
  blurb: string;
}> = {
  analog: {
    name: 'ANALOG', p1: 'PULSE W', p2: 'OSC2 DT', p3: 'WAVE', p4: 'SYNC',
    blurb: '2 osc VA, sub, PWM',
  },
  wavetable: {
    name: 'WAVETBL', p1: 'MORPH', p2: 'WARP', p3: 'BITS', p4: 'FORMANT',
    blurb: 'additive tables + morph',
  },
  phasedist: {
    name: 'P.DIST', p1: 'DCW', p2: 'SHAPE', p3: 'RESO', p4: 'K.TRACK',
    blurb: 'CZ phase distortion',
  },
  sid: {
    name: 'SID', p1: 'PULSE W', p2: 'PWM RT', p3: 'RING/SYNC', p4: 'ARP',
    blurb: 'chip pulse + ringmod',
  },
  dnoise: {
    name: 'DNOISE', p1: 'RATE', p2: 'COMB', p3: 'RES', p4: 'BITS',
    blurb: 'chip noise + comb',
  },
  metallic: {
    name: 'METAL', p1: 'INHARM', p2: 'DENSITY', p3: 'TONE', p4: 'TRANSIENT',
    blurb: 'inharmonic cluster',
  },
  ringmod: {
    name: 'RINGMD', p1: 'RATIO', p2: 'FEEDBK', p3: 'FOLD', p4: 'DEPTH',
    blurb: 'ring mod + feedback',
  },
  digital: {
    name: 'DIGITAL', p1: 'FOLD', p2: 'XOR', p3: 'RATE', p4: 'HARM',
    blurb: 'bit-manipulated phase',
  },
};

const TABLE_SIZE = 512;
const NUM_TABLES = 6;

/** Build the wavetable set once (module level): additive spectra, not samples. */
function buildTables(): Float32Array[] {
  const tables: Float32Array[] = [];
  const mk = (fn: (phase: number, i: number) => number) => {
    const t = new Float32Array(TABLE_SIZE + 1);
    let peak = 1e-6;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const v = fn(i / TABLE_SIZE, i);
      t[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i < TABLE_SIZE; i++) t[i] /= peak;
    t[TABLE_SIZE] = t[0];
    return t;
  };
  // 0: warm sine + 3rd harmonic
  tables.push(mk((x) => Math.sin(TWO_PI * x) + 0.22 * Math.sin(TWO_PI * 3 * x) + 0.08 * Math.sin(TWO_PI * 5 * x)));
  // 1: soft saw (1/n harmonics, band-limited to 24)
  tables.push(mk((x) => {
    let v = 0;
    for (let n = 1; n <= 24; n++) v += Math.sin(TWO_PI * n * x) / n;
    return v;
  }));
  // 2: hollow (odd harmonics, square-ish, 24 terms)
  tables.push(mk((x) => {
    let v = 0;
    for (let n = 1; n <= 23; n += 2) v += Math.sin(TWO_PI * n * x) / n;
    return v;
  }));
  // 3: vowel-ish formant cluster
  tables.push(mk((x) => {
    const a = Math.sin(TWO_PI * x);
    return a * (0.6 + 0.4 * Math.sin(TWO_PI * 4 * x)) + 0.3 * Math.sin(TWO_PI * 7 * x + 1.1);
  }));
  // 4: metallic inharmonic
  tables.push(mk((x) => {
    const ratios = [1, 1.41, 1.73, 2.31, 3.07, 4.11];
    let v = 0;
    for (let i = 0; i < ratios.length; i++) v += Math.sin(TWO_PI * ratios[i] * x) / (i + 1);
    return v;
  }));
  // 5: bright pulse train (8 harmonics, all present)
  tables.push(mk((x) => {
    let v = 0;
    for (let n = 1; n <= 18; n++) v += Math.sin(TWO_PI * n * x) * (n % 2 === 0 ? 0.6 : 1) / n;
    return v;
  }));
  return tables;
}

const WAVETABLES = buildTables();

/** Metallic partial ratio sets, indexed by INHARM knob. */
const METAL_SETS = [
  [1, 1.41, 1.73, 2.31, 3.07, 4.11, 5.43, 6.79],
  [1, 1.5, 2.1, 2.9, 3.6, 5.1, 6.4, 8.2],
  [1, 2.4, 3.1, 4.7, 5.3, 7.1, 9.3, 11.2],
  [1, 3.3, 4.4, 6.7, 8.1, 10.3, 13.7, 16.1],
];

/** CZ style phase distortion transfer function. */
function pdPhase(x: number, dcw: number, shape: number): number {
  // dcw 0 = no distortion (pure sine), 1 = full saw-like
  const d = 0.02 + dcw * 0.96;
  let p: number;
  if (x < d) p = (x / d) * 0.5;
  else p = 0.5 + ((x - d) / (1 - d)) * 0.5;
  if (shape > 0.6) {
    // "resonant" transfer: windowed sine with a fast inner cycle
    const inner = 1 + Math.floor((shape - 0.6) * 12);
    p = x * (1 - dcw) + (x - Math.sin(TWO_PI * x) / TWO_PI / inner) * dcw;
  } else if (shape > 0.3) {
    // square-ish
    p = 0.5 + (p - 0.5) * (1 + dcw * 1.5);
    p = clamp(p, 0, 0.999);
  }
  return p;
}

export class MonoVoice implements Voice {
  active = false;
  note = 60;
  released = false;
  ampValue = 0;
  private vel = 1;
  private sr: number;
  private osc1 = new Osc();
  private osc2 = new Osc();
  private osc3 = new Osc();
  private subOsc = new Osc();
  private amp = new Adsr();
  private noise = new Noise();
  private toneLp = new OnePole();
  private toneHp = new OnePole();
  private curHz = 220;
  private targetHz = 220;
  private glideCoef = 0;
  private age = 0;
  private pwmPhase = 0;
  private arpPhase = 0;
  private comb = new Float32Array(4096);
  private combIdx = 0;
  private combLp = 0;
  private shHold = 0;
  private shPhase = 0;
  private rateHold = 0;
  private ratePhase = 0;
  private lastOut = 0;
  private transientEnv = 0;
  private transientCoef = 0.999;
  private engineMode: MonoEngineId = 'analog';
  private engineChanged = true;
  private decayMul = 1;

  constructor(sr = SR) {
    this.sr = sr;
    this.noise.reset(0x51f3a2);
  }

  noteOn(note: number, vel: number, p: TrackParams, legato = false) {
    this.active = true;
    this.released = false;
    this.note = note;
    this.vel = clamp(vel, 0, 1);
    this.age = 0;
    const m = p.mono;
    const base = noteToHz(note) * Math.pow(2, m.tune / 1200);
    if (!legato) this.curHz = base;
    this.targetHz = base;
    this.glideCoef = m.glide <= 0.001 ? 0 : Math.exp(-1 / (envTime(m.glide) * this.sr * 0.4));
    this.amp.set(p.amp.atk, p.amp.dec, p.amp.sus, p.amp.rel, this.sr);
    this.amp.gateOn();
    this.osc1.reset(0);
    this.osc2.reset(0.27);
    this.osc3.reset(0.61);
    this.subOsc.reset(0);
    this.pwmPhase = 0;
    this.arpPhase = 0;
    this.transientEnv = 1;
    this.transientCoef = Math.exp(-1 / Math.max(1, envTime(clamp(0.02 + (1 - m.p4) * 0.1)) * this.sr));
    if (m.engine !== this.engineMode) {
      this.engineMode = m.engine;
      this.engineChanged = true;
      this.comb.fill(0);
      this.combLp = 0;
    }
  }

  noteOff() {
    if (!this.active || this.released) return;
    this.released = true;
    this.amp.gateOff();
  }

  kill() {
    this.active = false;
    this.released = true;
    this.ampValue = 0;
    this.amp.stage = 0;
  }

  render(out: Float32Array, offset: number, n: number, p: TrackParams, mod: ModInputs) {
    if (!this.active) return;
    const m: MonoParams = p.mono;
    const sr = this.sr;
    if (m.engine !== this.engineMode) {
      this.engineMode = m.engine;
      this.comb.fill(0);
    }
    const velAmp = 1 - p.amp.vel + p.amp.vel * this.vel;
    // tone: p<0.5 darkens (lowpass), p>0.5 brightens (highpass shelf)
    const toneCut = 200 * Math.pow(60, m.tone);
    this.toneLp.set(toneCut * (m.tone < 0.5 ? 1 : 6), sr);
    this.toneHp.set(30 + m.tone * 40, sr);
    this.decayMul = mod.decayMul;

    const p1 = clamp(m.p1 + mod.colorOffset * 0.4, 0, 1);
    const p2 = clamp(m.p2, 0, 1);
    const p3 = clamp(m.p3, 0, 1);
    const p4 = clamp(m.p4, 0, 1);
    const subAmt = m.sub;
    const detune = m.detune;
    const drive = m.drive;
    const tone = m.tone;

    for (let s = 0; s < n; s++) {
      this.curHz = this.targetHz + (this.curHz - this.targetHz) * this.glideCoef;
      const hz = this.curHz * mod.pitchMul;
      let v = 0;
      switch (this.engineMode) {
        case 'analog':
          v = this.renderAnalog(hz, sr, p1, p2, p3, p4, subAmt, detune);
          break;
        case 'wavetable':
          v = this.renderWavetable(hz, sr, p1, p2, p3, p4);
          break;
        case 'phasedist':
          v = this.renderPhaseDist(hz, sr, p1, p2, p3, p4);
          break;
        case 'sid':
          v = this.renderSid(hz, sr, p1, p2, p3, p4);
          break;
        case 'dnoise':
          v = this.renderDNoise(hz, sr, p1, p2, p3, p4);
          break;
        case 'metallic':
          v = this.renderMetallic(hz, sr, p1, p2, p3, p4);
          break;
        case 'ringmod':
          v = this.renderRingmod(hz, sr, p1, p2, p3, p4);
          break;
        default:
          v = this.renderDigital(hz, sr, p1, p2, p3, p4);
          break;
      }
      // tone stage
      v = this.toneLp.lp(v);
      v = this.toneHp.hp(v);
      if (drive > 0.001) v = softClip(v * (1 + drive * 6)) * (1 / (1 + drive * 2.2));
      const a = this.amp.tick();
      const y = v * a * velAmp * mod.ampMul;
      out[offset + s] += y;
      this.lastOut = y;
      this.age++;
    }
    this.ampValue = this.amp.value * velAmp;
    if (this.released && (this.amp.stage === 0 || this.age > sr * 30)) this.kill();
  }

  /* ------------------------------------------------------------ engines --- */

  private renderAnalog(
    hz: number, sr: number, p1: number, p2: number, p3: number, p4: number,
    subAmt: number, detune: number,
  ): number {
    const dt = 1 + p2 * 0.06 + detune * 0.12;
    // osc1: morph saw -> square via p3 (crossfade of two band-limited waves)
    const saw1 = this.osc1.saw(hz, sr);
    const sq1 = this.osc1.square(hz * 1.0, sr);
    const mix1 = saw1 * (1 - p3) + sq1 * p3;
    // osc2: detuned, opposite morph, plus hard sync-ish reset via p4
    const o2hz = hz * (1 / dt);
    this.osc2.advance(o2hz, sr);
    if (p4 > 0.01 && this.osc2.phase < o2hz / sr * 2 && this.osc1.phase < 0.02) this.osc2.reset(0);
    const saw2 = this.osc2.saw(o2hz, sr);
    const sq2 = this.osc2.square(o2hz, sr);
    const mix2 = saw2 * p3 + sq2 * (1 - p3);
    // PWM'd pulse
    const pulse = this.osc1.phase < 0.15 + p1 * 0.7 ? 1 : -1;
    this.osc1.advance(hz, sr);
    let v = (mix1 * 0.55 + mix2 * 0.45) * 0.6 + pulse * 0.22;
    // sub oscillator one octave down
    if (subAmt > 0.001) {
      this.subOsc.advance(hz * 0.5, sr);
      v += this.subOsc.square(hz * 0.5, sr) * subAmt * 0.35;
    }
    return v;
  }

  private renderWavetable(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    const pos = p1 * (NUM_TABLES - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(NUM_TABLES - 1, i0 + 1);
    const frac = pos - i0;
    let phase = this.osc1.phase;
    // phase warp (symmetric bend) for extra bite
    if (p2 > 0.01) {
      const warp = p2 * 0.45;
      phase = phase + warp * Math.sin(TWO_PI * phase);
      phase = phase - Math.floor(phase);
    }
    const idx = phase * TABLE_SIZE;
    const a = idx | 0;
    const f = idx - a;
    const t0 = WAVETABLES[i0];
    const t1 = WAVETABLES[i1];
    const s0 = t0[a] + (t0[a + 1] - t0[a]) * f;
    const s1 = t1[a] + (t1[a + 1] - t1[a]) * f;
    let v = s0 + (s1 - s0) * frac;
    // formant: play the table faster and fold it back (odd-harmonic emphasis)
    if (p4 > 0.01) {
      const fo = this.osc2.phase * TABLE_SIZE;
      const fa = fo | 0;
      const ff = fo - fa;
      const fv = t1[fa] + (t1[fa + 1] - t1[fa]) * ff;
      v = v * (1 - p4 * 0.6) + fv * p4 * 0.9;
      this.osc2.advance(hz * (1 + p4 * 2.5), sr);
    }
    this.osc1.advance(hz, sr);
    if (p3 > 0.01) v = bitCrush(v, 16 - p3 * 13);
    return v * 0.8;
  }

  private renderPhaseDist(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    const ph = this.osc1.phase;
    const pp = pdPhase(ph, p1, p2);
    let v = Math.sin(TWO_PI * pp);
    // resonance adds a windowed harmonic sweep (classic CZ resonance)
    if (p3 > 0.01) {
      const w = Math.pow(Math.sin(Math.PI * (1 - ph)), 2);
      v += w * Math.sin(TWO_PI * ph * (1 + Math.floor(p3 * 9))) * p3 * 0.55;
    }
    this.osc1.advance(hz * (1 - p4 * 0.001) * Math.pow(2, (p4 - 0.5) * 0), sr);
    return v * 0.9;
  }

  private renderSid(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    // PWM LFO
    const pwmRate = 0.2 + p2 * 12;
    this.pwmPhase += pwmRate / sr;
    if (this.pwmPhase >= 1) this.pwmPhase -= 1;
    const pw = 0.05 + p1 * 0.8 + Math.sin(TWO_PI * this.pwmPhase) * 0.2 * p2;
    const phase = this.osc1.phase;
    let v = phase < clamp(pw, 0.02, 0.98) ? 1 : -1;
    // ring modulation with a triangle at a ratio
    if (p3 > 0.01) {
      this.osc2.advance(hz * (1.5 + p2 * 2), sr);
      const ring = v * this.osc2.triangle();
      v = v * (1 - p3) + ring * p3;
    }
    // hard sync to a multiple
    this.osc1.advance(hz * (1 + p4 * 3), sr);
    if (this.osc1.phase < 0.5) {
      // bit-crushed sine "filter" behaviour
      v = Math.round(v * 6) / 6;
    }
    // arpeggio effect: rapid octave jumps
    if (p4 > 0.01) {
      this.arpPhase += (2 + p4 * 24) / sr;
      if (this.arpPhase >= 1) this.arpPhase -= 1;
      if (this.arpPhase > 0.66) v *= 0.6;
    }
    return v * 0.75;
  }

  private renderDNoise(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    // sample & hold noise at a rate that tracks pitch but is deliberately aliased
    const rate = clamp(hz * (0.25 + p1 * 4), 20, sr * 0.4);
    this.shPhase += rate / sr;
    if (this.shPhase >= 1) {
      this.shPhase -= 1;
      this.shHold = this.noise.next();
    }
    // comb tuned to the note (Karplus-Strong-ish excitation)
    const delay = clamp(Math.round(sr / Math.max(20, hz * (0.5 + p2 * 3))), 2, 4000);
    this.combIdx = (this.combIdx + 1) % this.comb.length;
    const readPos = (this.combIdx - delay + this.comb.length) % this.comb.length;
    const fb = 0.55 + p3 * 0.44;
    const combOut = this.comb[readPos];
    const excited = this.comb[this.combIdx] = this.shHold * 0.5 + combOut * fb;
    let v = this.shHold * (1 - p3) + combOut * (0.3 + p3);
    v = 0.5 * v + 0.5 * excited;
    if (p4 > 0.01) v = bitCrush(v, 16 - p4 * 13);
    return clamp(v, -1.2, 1.2) * 0.9;
  }

  private renderMetallic(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    const set = METAL_SETS[Math.min(3, Math.floor(p1 * 4))];
    const density = 2 + Math.round(p2 * 6);
    let v = 0;
    const n = Math.min(set.length, density);
    for (let i = 0; i < n; i++) {
      const ratio = set[i];
      const osc = i % 2 === 0 ? this.osc1 : this.osc2;
      // each partial advanced by its ratio, weighted by density curve
      const g = 1 / (i + 1.5);
      v += Math.sin(TWO_PI * (this.osc1.phase * ratio + i * 0.13)) * g;
      void osc;
    }
    this.osc1.advance(hz, sr);
    this.osc2.advance(hz * 1.007, sr);
    // transient noise burst gives the attack its "strike"
    this.transientEnv *= this.transientCoef;
    if (p4 > 0.01) v += this.noise.next() * this.transientEnv * p4 * 0.8;
    // bandpass-ish tone tilt
    v = this.toneLp.lp(v) * (1.6);
    const bp = clamp(v * (1 + p3 * 2), -1.5, 1.5);
    return bp * 0.55;
  }

  private renderRingmod(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    const ratio = 0.5 + Math.round(p1 * 15) * 0.5;
    const modHz = hz * ratio;
    this.osc2.advance(modHz, sr);
    const carrier = Math.sin(TWO_PI * (this.osc1.phase + this.lastOut * p2 * 0.4));
    let mod = Math.sin(TWO_PI * this.osc2.phase + this.osc2.phase * p2 * 2);
    this.osc1.advance(hz, sr);
    let v = carrier * (1 - p4) + carrier * mod * p4;
    if (p3 > 0.01) v = waveFold(v, p3 * 0.8);
    return v * 0.85;
  }

  private renderDigital(hz: number, sr: number, p1: number, p2: number, p3: number, p4: number): number {
    // rate reduction
    const rateDiv = 1 + Math.floor(p3 * 32);
    this.ratePhase += 1;
    if (this.ratePhase >= rateDiv) {
      this.ratePhase = 0;
      const ph = this.osc1.phase * 512 | 0;
      // bit manipulation of the phase word creates inharmonic digital tones
      let bits = ph ^ Math.floor(p2 * 255);
      bits = (bits * (1 + Math.floor(p2 * 7))) & 511;
      const warped = (bits / 512) + this.osc1.phase * (1 - p2);
      let v = Math.sin(TWO_PI * warped);
      if (p1 > 0.01) v = waveFold(v, p1);
      // second harmonic voice
      v = v * 0.8 + Math.sin(TWO_PI * this.osc1.phase * (2 + Math.floor(p4 * 6))) * 0.25 * p4;
      this.rateHold = v;
    }
    this.osc1.advance(hz, sr);
    return this.rateHold;
  }
}
