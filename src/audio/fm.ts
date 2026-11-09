/**
 * ENGINE A — four-operator FM synthesis.
 *
 * An original routing topology in the phase-modulation "operator" tradition: four sine
 * operators whose phases are modulated by one another according to one of eight
 * algorithms. Each operator carries its own ADSR, which is what makes percussive FM
 * possible (a modulator can decay in 30 ms while the carrier rings for two seconds).
 *
 * Modulation depth is expressed in radians and scales with the source operator's level
 * and the global INDEX, so INDEX always feels musical across all algorithms.
 */
import { Adsr, SR, TWO_PI, clamp, envTime, noteToHz, saturate } from './dsp';
import type { Voice, ModInputs } from './voice';
import { FM_RATIOS, normToValue } from '../state/params';
import type { FMParams, TrackParams } from '../state/types';

export interface FMAlgo {
  name: string;
  /** [modulator, carrier, depthScale] */
  edges: [number, number, number][];
  carriers: number[];
}

export const FM_ALGOS: FMAlgo[] = [
  { name: 'CHAIN', edges: [[3, 2, 1], [2, 1, 1], [1, 0, 1]], carriers: [0] },
  { name: 'BRANCH', edges: [[3, 2, 1], [2, 1, 1], [1, 0, 1], [3, 1, 0.6]], carriers: [0] },
  { name: '2xPAIR', edges: [[3, 2, 1], [1, 0, 1]], carriers: [2, 0] },
  { name: 'STACK3', edges: [[2, 0, 1], [1, 0, 0.7], [3, 0, 0.5]], carriers: [0] },
  { name: 'TRIPLE', edges: [[3, 2, 0.6]], carriers: [0, 1, 2] },
  { name: 'SHARED', edges: [[3, 1, 0.8], [3, 2, 0.8]], carriers: [0, 1, 2] },
  { name: 'SPLIT', edges: [[3, 2, 1], [2, 0, 1], [1, 0, 0.5]], carriers: [0] },
  { name: 'ADDITV', edges: [], carriers: [0, 1, 2, 3] },
];

const MAX_MOD_RAD = 8.0;

export function ratioFromNorm(n: number): number {
  const i = clamp(Math.round(n * (FM_RATIOS.length - 1)), 0, FM_RATIOS.length - 1);
  return FM_RATIOS[i];
}

interface OpState {
  phase: number;
  last: number;
  prev: number;
  env: Adsr;
  envKey: string;
}

export class FMVoice implements Voice {
  active = false;
  note = 60;
  released = false;
  ampValue = 0;
  vel = 1;
  private ops: OpState[] = [];
  private amp = new Adsr();
  private targetHz = 440;
  private curHz = 440;
  private glideCoef = 1;
  private pitchEnvVal = 0;
  private pitchEnvCoef = 0;
  private sr: number;
  private noiseS = 0x9e3779b9;
  private fb = [0, 0, 0, 0];
  private incs = [0, 0, 0, 0];
  private age = 0;
  private decayMulSmooth = 1;

  constructor(sr = SR) {
    this.sr = sr;
    for (let i = 0; i < 4; i++) {
      // deterministic start phases keep offline renders reproducible
      this.ops.push({ phase: (i * 0.25) % 1, last: 0, prev: 0, env: new Adsr(), envKey: '' });
    }
  }

  noteOn(note: number, vel: number, p: TrackParams, legato = false) {
    const f = p.fm;
    this.active = true;
    this.released = false;
    this.note = note;
    this.vel = clamp(vel, 0, 1);
    this.age = 0;
    const base = noteToHz(note) * Math.pow(2, f.tune / 1200);
    if (!legato) this.curHz = base;
    this.targetHz = base;
    const g = envTime(f.glide);
    this.glideCoef = f.glide <= 0.001 ? 0 : Math.exp(-1 / (g * this.sr * 0.4));
    this.pitchEnvVal = f.pitchEnv;
    this.pitchEnvCoef = Math.exp(-1 / Math.max(2, envTime(f.pitchEnvDec) * this.sr * 0.4));
    for (let i = 0; i < 4; i++) {
      const o = f.ops[i];
      const st = this.ops[i];
      st.env.set(o.atk, o.dec, o.sus, o.rel, this.sr);
      st.env.gateOn();
      st.phase = i === 0 ? 0 : (st.phase + 0.113) % 1;
      st.last = 0;
      st.prev = 0;
      this.fb[i] = 0;
    }
    this.amp.set(p.amp.atk * 0.35, p.amp.dec, p.amp.sus, p.amp.rel, this.sr);
    this.amp.gateOn();
  }

  noteOff() {
    if (!this.active || this.released) return;
    this.released = true;
    for (const o of this.ops) o.env.gateOff();
    this.amp.gateOff();
  }

  kill() {
    this.active = false;
    this.released = true;
    this.ampValue = 0;
    for (const o of this.ops) o.env.stage = 0;
    this.amp.stage = 0;
  }

  render(out: Float32Array, offset: number, n: number, p: TrackParams, mod: ModInputs) {
    if (!this.active) return;
    const f: FMParams = p.fm;
    const sr = this.sr;
    const alg = FM_ALGOS[clamp(Math.round(f.algorithm), 0, 7)];
    const carriers = alg.carriers;
    const index = clamp(f.index + mod.colorOffset * 0.5, 0, 1);
    const harmonic = f.harmonic;
    const noiseAmt = f.noise;
    const satAmt = f.sat;
    const amAmt = f.am;
    const incs = this.incs;
    const velAmp = 1 - p.amp.vel + p.amp.vel * this.vel;

    // Smooth decay-time modulation to avoid zipper noise.
    this.decayMulSmooth += (mod.decayMul - this.decayMulSmooth) * 0.002;
    const decayMul = this.decayMulSmooth;

    for (let i = 0; i < 4; i++) {
      const o = f.ops[i];
      const ratio = ratioFromNorm(o.ratio);
      let hz: number;
      if (o.fixed) hz = 8 * Math.pow(2, o.ratio * 8);
      else hz = this.curHz * ratio * (carriers.indexOf(i) >= 0 ? 1 + harmonic * 2 : 1);
      hz *= Math.pow(2, o.detune / 12);
      incs[i] = hz / sr;
    }

    for (let s = 0; s < n; s++) {
      this.curHz = this.targetHz + (this.curHz - this.targetHz) * this.glideCoef;
      this.pitchEnvVal *= this.pitchEnvCoef;
      const pitchMul = Math.pow(2, this.pitchEnvVal / 12) * mod.pitchMul;

      const m0 = 0, m1 = 0, m2 = 0, m3 = 0;
      const mods = [m0, m1, m2, m3];
      const outs = [0, 0, 0, 0];
      // reverse index order guarantees modulators are computed before carriers,
      // because all algorithms only route from higher index to lower index.
      for (let i = 3; i >= 0; i--) {
        const o = f.ops[i];
        const st = this.ops[i];
        let env = st.env.tick();
        if (decayMul < 0.999 && st.env.stage === 2) env = Math.pow(env, decayMul);
        const level = o.level * env;
        const feedback = o.feedback * (this.fb[i] + st.last) * 0.5;
        const noise = i === 3 && noiseAmt > 0 ? this.nextNoise() * noiseAmt * 1.8 : 0;
        st.phase += incs[i] * pitchMul;
        if (st.phase >= 1 || st.phase < 0) st.phase -= Math.floor(st.phase);
        const y = Math.sin(st.phase * TWO_PI + mods[i] + feedback + noise);
        this.fb[i] = st.last;
        st.prev = st.last;
        st.last = y;
        const scaled = y * level;
        outs[i] = scaled;
        for (let e = 0; e < alg.edges.length; e++) {
          const ed = alg.edges[e];
          if (ed[0] === i) mods[ed[1]] += scaled * ed[2] * index * MAX_MOD_RAD;
        }
      }
      let acc = 0;
      for (let c = 0; c < carriers.length; c++) acc += outs[carriers[c]];
      acc *= carriers.length > 1 ? 0.45 : 0.8;
      if (amAmt > 0.001) {
        const m = 1 - amAmt + amAmt * (this.ops[1].last * 0.5 + 0.5);
        acc *= m;
      }
      if (satAmt > 0.001) acc = saturate(acc * 1.4, satAmt * 0.9);
      acc = Math.tanh(acc * 1.15);
      const a = this.amp.tick();
      out[offset + s] += acc * a * velAmp * mod.ampMul;
      this.age++;
    }
    this.ampValue = this.amp.value * velAmp;
    if (this.released && (this.amp.stage === 0 || this.age > sr * 25)) this.kill();
  }

  private nextNoise(): number {
    let x = this.noiseS;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noiseS = x;
    return x / 2147483648;
  }

  get hz() {
    return this.curHz * Math.pow(2, this.pitchEnvVal / 12);
  }
}

/** Convenience for the preset browser: real ratio for a normalised value. */
export const fmRatioValue = (norm: number) => ratioFromNorm(norm);
export const fmDetuneFromNorm = (norm: number) => normToValue('fm.ops.0.detune', norm);
