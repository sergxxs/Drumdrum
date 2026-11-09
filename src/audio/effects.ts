/**
 * Modular effects.
 *
 *  • TrackFx     – per-track distortion + chorus/flanger/phaser (mod) + stereo width
 *  • SendBusA    – stereo ping-pong delay with tone + feedback
 *  • SendBusB    – reverb (FDN-style 8-line diffused network with damping + pre-delay)
 *  • MasterChain – modular insert chain (drive, EQ, width, comp, and user-orderable FX)
 *
 * All effects are real DSP on the audio path — nothing here is decorative.
 */
import {
  DcBlocker, DelayLine, OnePole, SR, clamp, dbToGain,
} from './dsp';

/* ------------------------------------------------------------------ delay --- */

export class StereoDelay {
  private dl: DelayLine;
  private dr: DelayLine;
  private lpL = new OnePole();
  private lpR = new OnePole();
  private sr: number;
  private timeSamples = 4410;
  private fb = 0.4;
  private ping = true;
  private wetL = 0;
  private wetR = 0;

  constructor(sr = SR) {
    this.sr = sr;
    this.dl = new DelayLine(sr * 2 + 8);
    this.dr = new DelayLine(sr * 2 + 8);
    this.lpL.set(6000, sr);
    this.lpR.set(6000, sr);
  }

  configure(seconds: number, feedback: number, tone: number, pingPong: boolean) {
    this.timeSamples = clamp(seconds, 0.01, 1.9) * this.sr;
    this.fb = clamp(feedback, 0, 0.95);
    const cut = 300 * Math.pow(60, tone);
    this.lpL.set(cut, this.sr);
    this.lpR.set(cut * 1.05, this.sr);
    this.ping = pingPong;
  }

  clear() {
    this.dl.clear();
    this.dr.clear();
    this.lpL.reset();
    this.lpR.reset();
  }

  process(l: number, r: number, amount: number): [number, number] {
    const dL = this.dl.read(this.timeSamples);
    const dR = this.dr.read(this.timeSamples * (this.ping ? 1 : 0.75));
    const fL = this.lpL.lp(dL);
    const fR = this.lpR.lp(dR);
    if (this.ping) {
      this.dl.write(l * 0.5 + fR * this.fb);
      this.dr.write(r * 0.5 + fL * this.fb);
    } else {
      this.dl.write(l * 0.4 + fL * this.fb);
      this.dr.write(r * 0.4 + fR * this.fb);
    }
    this.wetL = dL;
    this.wetR = dR;
    return [l + dL * amount, r + dR * amount];
  }
}

/* ----------------------------------------------------------------- reverb --- */

/**
 * 8-line feedback delay network. Each line has a damping lowpass and a
 * Householder-ish mixing matrix (here: fast Walsh-Hadamard transform, which is
 * orthogonal and cheap), giving a dense, smooth tail without metallic ringing.
 */
export class Reverb {
  private lines: DelayLine[] = [];
  private damps: OnePole[] = [];
  private lengths: number[] = [];
  private pre: DelayLine;
  private sr: number;
  private mixDelay = 0;
  private size = 0.5;
  private damp = 0.5;
  private gains: number[] = [];
  private tmp = new Float32Array(8);
  private outBuf = new Float32Array(8);

  constructor(sr = SR) {
    this.sr = sr;
    const base = [0.0297, 0.0371, 0.0411, 0.0437, 0.0531, 0.0599, 0.0677, 0.0713];
    for (let i = 0; i < 8; i++) {
      this.lengths.push(Math.round(base[i] * sr));
      this.lines.push(new DelayLine(Math.round(base[i] * sr * 2.2) + 8));
      const lp = new OnePole();
      lp.set(6000, sr);
      this.damps.push(lp);
      this.gains.push(0.7);
    }
    this.pre = new DelayLine(Math.round(sr * 0.2) + 8);
  }

  configure(size: number, damp: number, preDelay: number) {
    this.size = clamp(size);
    this.damp = clamp(damp);
    this.mixDelay = clamp(preDelay) * 0.15 * this.sr;
    for (let i = 0; i < 8; i++) {
      const cut = 1200 + (1 - this.damp) * 11000;
      this.damps[i].set(cut, this.sr);
      // feedback so tail is roughly 1.5 .. 9 seconds
      const rt60 = 1.2 + this.size * 8 * (0.6 + 0.4 * ((i * 7) % 8) / 8);
      const gain = Math.pow(10, (-3 * this.lengths[i] * (1 + this.size * 0.4)) / (rt60 * this.sr));
      this.gains[i] = clamp(gain, 0.1, 0.92);
    }
  }

  clear() {
    for (const l of this.lines) l.clear();
    for (const d of this.damps) d.reset();
    this.pre.clear();
  }

  process(l: number, r: number, amount: number): [number, number] {
    const mono = (l + r) * 0.5;
    this.pre.write(mono);
    const input = this.pre.read(this.mixDelay) * 0.6;
    const tmp = this.tmp;
    for (let i = 0; i < 8; i++) tmp[i] = this.lines[i].read(this.lengths[i]);
    // in-place fast Walsh-Hadamard transform: orthogonal diffusion, 24 add/sub ops
    for (let step = 1; step < 8; step <<= 1) {
      for (let i = 0; i < 8; i += step << 1) {
        for (let j = 0; j < step; j++) {
          const x = tmp[i + j];
          const y = tmp[i + j + step];
          tmp[i + j] = x + y;
          tmp[i + j + step] = x - y;
        }
      }
    }
    const norm = 0.35355339; // 1/sqrt(8)
    const out = this.outBuf;
    for (let i = 0; i < 8; i++) {
      const damped = this.damps[i].lp(tmp[i] * norm);
      this.lines[i].write(damped * this.gains[i] + input * 0.3);
      out[i] = damped;
    }
    const lOut = (out[0] + out[2] + out[4] + out[6]) * 0.25;
    const rOut = (out[1] + out[3] + out[5] + out[7]) * 0.25;
    return [l + lOut * amount * 0.8, r + rOut * amount * 0.8];
  }
}

/* ---------------------------------------------------------- modulation fx --- */

export type ModType = 'chorus' | 'flanger' | 'phaser';

export class ModFx {
  private dl: DelayLine;
  private dr: DelayLine;
  private phase = 0;
  private sr: number;
  private depth = 0.5;
  private rate = 0.4;
  private type: ModType = 'chorus';
  private apL: number[] = [0, 0, 0, 0];
  private apR: number[] = [0, 0, 0, 0];
  private apCoef = 0.5;

  constructor(sr = SR) {
    this.sr = sr;
    this.dl = new DelayLine(sr * 0.1);
    this.dr = new DelayLine(sr * 0.1);
  }

  configure(type: ModType, depth: number, rate: number) {
    this.type = type;
    this.depth = clamp(depth);
    this.rate = 0.05 + clamp(rate) * 6;
    this.apCoef = 0.4 + this.depth * 0.4;
  }

  clear() {
    this.dl.clear();
    this.dr.clear();
    this.apL.fill(0);
    this.apR.fill(0);
  }

  process(l: number, r: number, amount: number): [number, number] {
    if (amount <= 0.001) return [l, r];
    this.phase += this.rate / this.sr;
    if (this.phase >= 1) this.phase -= 1;
    const lfo = Math.sin(this.phase * Math.PI * 2);
    const lfoQ = Math.sin(this.phase * Math.PI * 2 + Math.PI * 0.5);
    if (this.type === 'phaser') {
      // 4-stage allpass cascade, swept
      let xL = l;
      let xR = r;
      const a = 0.25 + (lfo * 0.5 + 0.5) * 0.65;
      for (let s = 0; s < 4; s++) {
        const yL = -a * xL + this.apL[s];
        this.apL[s] = xL + a * yL;
        xL = yL;
        const aR = 0.25 + (lfoQ * 0.5 + 0.5) * 0.65;
        const yR = -aR * xR + this.apR[s];
        this.apR[s] = xR + aR * yR;
        xR = yR;
      }
      return [l + xL * amount, r + xR * amount];
    }
    const baseMs = this.type === 'flanger' ? 1.2 : 12;
    const depthMs = this.type === 'flanger' ? 4 * this.depth : 9 * this.depth;
    const dL = (baseMs + depthMs * (lfo * 0.5 + 0.5)) * 0.001 * this.sr;
    const dR = (baseMs + depthMs * (lfoQ * 0.5 + 0.5)) * 0.001 * this.sr;
    const wL = this.dl.read(dL);
    const wR = this.dr.read(dR);
    this.dl.write(l);
    this.dr.write(r);
    return [l + wL * amount, r + wR * amount];
  }
}

/* --------------------------------------------------------------- distortion --- */

export type DistMode = 'soft' | 'hard' | 'fold' | 'crush';

export function distort(x: number, amount: number, mode: DistMode = 'soft'): number {
  if (amount <= 0.001) return x;
  switch (mode) {
    case 'hard':
      return clamp(x * (1 + amount * 12), -1, 1);
    case 'fold': {
      const y = x * (1 + amount * 6);
      return Math.abs(((y + 1) % 4 + 4) % 4 - 2) - 1;
    }
    case 'crush': {
      const bits = 16 - amount * 14;
      const q = Math.pow(2, Math.max(1, bits) - 1);
      return Math.round(x * q) / q;
    }
    default:
      return Math.tanh(x * (1 + amount * 20)) / Math.tanh(1 + amount * 20);
  }
}

/* ------------------------------------------------------------- track fx ----- */

export class TrackFx {
  mod = new ModFx();
  private dc = new DcBlocker();
  constructor(sr = SR) {
    this.mod = new ModFx(sr);
  }
  configure(kind: ModType, depth: number, rate: number) {
    this.mod.configure(kind, depth, rate);
  }
  process(l: number, r: number, distAmount: number, modAmount: number): [number, number] {
    let [a, b] = this.mod.process(l, r, modAmount * 0.7);
    a = distort(a, distAmount, 'soft');
    b = distort(b, distAmount, 'soft');
    return [this.dc.process(a), this.dc.process(b)];
  }
}

/* ----------------------------------------------------------- master chain --- */

export class Compressor {
  private env = 0;
  private sr: number;
  private threshold = 0.7;
  private ratio = 4;
  private attackC = 0.999;
  private releaseC = 0.9999;
  gainReduction = 1;
  constructor(sr = SR) {
    this.sr = sr;
    this.set(0.6, 4);
  }
  set(threshold: number, ratio: number) {
    this.threshold = clamp(threshold, 0.05, 1);
    this.ratio = clamp(ratio, 1, 20);
    this.attackC = Math.exp(-1 / (0.005 * this.sr));
    this.releaseC = Math.exp(-1 / (0.12 * this.sr));
  }
  process(x: number): number {
    const abs = Math.abs(x);
    const coef = abs > this.env ? this.attackC : this.releaseC;
    this.env = abs + (this.env - abs) * coef;
    if (this.env > this.threshold) {
      const over = this.env / this.threshold;
      const targetGain = Math.pow(over, 1 / this.ratio - 1);
      this.gainReduction += (targetGain - this.gainReduction) * (1 - this.attackC);
    } else {
      this.gainReduction += (1 - this.gainReduction) * (1 - this.releaseC);
    }
    return x * this.gainReduction;
  }
}

/** 3-band shelving/peaking EQ built from one-pole filters (cheap, musical). */
export class MasterEq {
  private lowL = new OnePole();
  private lowR = new OnePole();
  private midL = new OnePole();
  private midR = new OnePole();
  private gLow = 1;
  private gMid = 1;
  private gHigh = 1;
  constructor(sr = SR) {
    this.lowL.set(220, sr);
    this.lowR.set(220, sr);
    this.midL.set(2200, sr);
    this.midR.set(2200, sr);
  }
  set(low: number, mid: number, high: number) {
    // -12..+12 dB
    this.gLow = dbToGain(low);
    this.gMid = dbToGain(mid);
    this.gHigh = dbToGain(high);
  }
  process(l: number, r: number): [number, number] {
    const lowL = this.lowL.lp(l);
    const lowR = this.lowR.lp(r);
    const mLowL = this.midL.lp(l);
    const mLowR = this.midR.lp(r);
    const bandLowL = lowL;
    const bandLowR = lowR;
    const bandMidL = mLowL - lowL;
    const bandMidR = mLowR - lowR;
    const bandHighL = l - mLowL;
    const bandHighR = r - mLowR;
    return [
      bandLowL * this.gLow + bandMidL * this.gMid + bandHighL * this.gHigh,
      bandLowR * this.gLow + bandMidR * this.gMid + bandHighR * this.gHigh,
    ];
  }
  reset() {
    this.lowL.reset();
    this.lowR.reset();
    this.midL.reset();
    this.midR.reset();
  }
}

/** Ring modulator for the master insert chain. */
export class RingMod {
  private phase = 0;
  private sr: number;
  private freq = 220;
  constructor(sr = SR) {
    this.sr = sr;
  }
  set(freq: number) {
    this.freq = clamp(freq, 20, 4000);
  }
  process(l: number, r: number, amount: number): [number, number] {
    if (amount <= 0.001) return [l, r];
    this.phase += this.freq / this.sr;
    if (this.phase >= 1) this.phase -= 1;
    const m = Math.sin(this.phase * Math.PI * 2);
    return [l * (1 - amount) + l * m * amount, r * (1 - amount) + r * m * amount];
  }
}

/** Aggregated master processor: insert chain + EQ + width + drive + comp. */
export class MasterChain {
  eq = new MasterEq();
  comp = new Compressor();
  mod = new ModFx();
  ring = new RingMod();
  width = 1;
  drive = 0;
  compOn = true;
  chainState: { type: string; on: boolean; mix: number; p1: number; p2: number; p3: number }[] = [];

  setWidth(w: number) {
    this.width = clamp(w, 0, 2);
  }

  process(l: number, r: number): [number, number] {
    let [a, b] = this.eq.process(l, r);
    for (const fx of this.chainState) {
      if (!fx.on) continue;
      switch (fx.type) {
        case 'DIST': {
          const da = distort(a, fx.mix, 'soft');
          const db = distort(b, fx.mix, 'soft');
          a = a * (1 - fx.mix) + da * fx.mix;
          b = b * (1 - fx.mix) + db * fx.mix;
          break;
        }
        case 'CRUSH': {
          const da = distort(a, fx.mix, 'crush');
          const db = distort(b, fx.mix, 'crush');
          a = da; b = db;
          break;
        }
        case 'MOD':
          [a, b] = this.mod.process(a, b, fx.mix);
          break;
        case 'RING':
          [a, b] = this.ring.process(a, b, fx.mix);
          break;
        case 'WIDTH': {
          const mid = (a + b) * 0.5;
          const side = (a - b) * 0.5 * this.width;
          a = mid + side;
          b = mid - side;
          break;
        }
        default:
          break;
      }
    }
    // master drive
    if (this.drive > 0.001) {
      const g = 1 + this.drive * 6;
      a = Math.tanh(a * g) / Math.tanh(g);
      b = Math.tanh(b * g) / Math.tanh(g);
    }
    // mid/side width
    if (this.width !== 1) {
      const mid = (a + b) * 0.5;
      const side = (a - b) * 0.5 * this.width;
      a = mid + side;
      b = mid - side;
    }
    if (this.compOn) {
      a = this.comp.process(a);
      b = this.comp.process(b);
    }
    return [a, b];
  }

  configure(state: {
    eqLow: number; eqMid: number; eqHigh: number; width: number; drive: number;
    compOn: boolean; compThresh: number; compRatio: number;
    chain: { type: string; on: boolean; mix: number; p1: number; p2: number; p3: number }[];
  }) {
    this.eq.set(state.eqLow, state.eqMid, state.eqHigh);
    this.setWidth(state.width);
    this.drive = state.drive;
    this.compOn = state.compOn;
    this.comp.set(state.compThresh, state.compRatio);
    this.chainState = state.chain;
  }
}
