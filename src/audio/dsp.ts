/**
 * Low-level DSP primitives. No dependency on Web Audio: everything here runs
 * identically in an AudioWorklet, in the offline export renderer, and in Node tests.
 */

export const TWO_PI = Math.PI * 2;
export const SR = 44100;

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const noteToHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/** Deterministic PRNG (mulberry32) — used for humanise, randomisation and built-in samples. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

/** Fast white noise with a long period (xorshift32). */
export class Noise {
  private s = 0x1234567;
  reset(seed = (Math.random() * 0xffffff) | 0) {
    this.s = seed || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x / 2147483648) - 1; // -1..1
  }
}

/* --------------------------------------------------------------- curves ---- */

/** normalised 0..1 -> seconds, exponential, 0.5 ms .. 10 s */
export function envTime(n: number): number {
  const t = clamp(n);
  if (t <= 0.0001) return 0.0005;
  return 0.0005 * Math.pow(20000, t);
}

/** Inverse of envTime: seconds -> normalised 0..1 (used by presets for readability). */
export function envNorm(seconds: number): number {
  return Math.log(Math.max(0.0005, seconds) / 0.0005) / Math.log(20000);
}

/** normalised 0..1 -> Hz, 20 Hz .. 20 kHz */
export function normHz(n: number): number {
  return 20 * Math.pow(1000, clamp(n));
}

/** Musical LFO rate from normalised 0..1: 0.02 .. 40 Hz */
export function lfoRate(n: number): number {
  return 0.02 * Math.pow(2000, clamp(n));
}

/** tempo-synced LFO divisors, from slow to fast */
export const LFO_SYNC_DIVS = [8, 4, 2, 1, 0.5, 0.25, 1 / 6, 1 / 8];

/* ------------------------------------------------------------ envelopes ---- */

/** Sampled ADSR with exponential segments and a fixed small release floor. */
export class Adsr {
  stage: 0 | 1 | 2 | 3 | 4 = 0; // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
  value = 0;
  private aTime = 0.005;
  private dTime = 0.2;
  private sLevel = 0.8;
  private rTime = 0.2;
  private aCoef = 0;
  private dCoef = 0;
  private rCoef = 0;
  /** seconds remaining in release */
  private relRemaining = 0;
  /** duration tracking for one-shot percussion behaviour */
  private target = 0;

  set(a: number, d: number, s: number, r: number, sr = SR) {
    this.aTime = envTime(a);
    this.dTime = envTime(d);
    this.sLevel = clamp(s);
    this.rTime = envTime(r);
    // 1-pole exponential coefficients: reach ~99% in aTime
    this.aCoef = Math.exp(-1 / (0.35 * this.aTime * sr));
    this.dCoef = Math.exp(-1 / Math.max(1e-6, 0.35 * this.dTime * sr));
    this.rCoef = Math.exp(-1 / Math.max(1e-6, 0.12 * this.rTime * sr));
  }

  gateOn() {
    this.stage = 1;
    this.target = 1;
  }

  gateOff() {
    if (this.stage !== 0) {
      this.stage = 4;
      this.relRemaining = Math.max(1, this.rTime * 0.12 * SR);
    }
  }

  get active() {
    return this.stage !== 0;
  }

  tick(): number {
    switch (this.stage) {
      case 1: // attack: exponential approach to 1 with overshoot-free curve
        this.value += (1.0 - this.value) * (1 - this.aCoef);
        if (this.value >= 0.999) {
          this.value = 1;
          this.stage = 2;
        }
        break;
      case 2: // decay toward sustain
        this.value = this.sLevel + (this.value - this.sLevel) * this.dCoef;
        if (Math.abs(this.value - this.sLevel) < 1e-4) {
          this.value = this.sLevel;
          this.stage = 3;
        }
        break;
      case 3:
        this.value = this.sLevel;
        break;
      case 4: // release
        this.value *= this.rCoef;
        this.relRemaining--;
        if (this.value < 1e-4 || this.relRemaining <= 0) {
          this.value = 0;
          this.stage = 0;
        }
        break;
      default:
        this.value = 0;
    }
    return this.value;
  }
}

/** Click-free smoothed parameter (one-pole). */
export class Smoothed {
  value: number;
  private coef: number;
  constructor(initial = 0, ms = 12, sr = SR) {
    this.value = initial;
    this.coef = Math.exp(-1 / (0.001 * ms * sr));
  }
  setTime(ms: number, sr = SR) {
    this.coef = Math.exp(-1 / (0.001 * Math.max(0.01, ms) * sr));
  }
  set(target: number) {
    this.value = target;
  }
  tick(target: number) {
    this.value = target + (this.value - target) * this.coef;
    return this.value;
  }
}

/* ---------------------------------------------------------- oscillators ---- */

/** PolyBLEP correction for band-limited saw/square. */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export class Osc {
  phase = 0; // 0..1
  reset(phase = 0) {
    this.phase = phase % 1;
  }
  advance(freq: number, sr = SR) {
    this.phase += freq / sr;
    if (this.phase >= 1) this.phase -= Math.floor(this.phase);
  }
  sine() {
    return Math.sin(this.phase * TWO_PI);
  }
  /** band-limited saw, -1..1 */
  saw(freq: number, sr = SR) {
    const dt = Math.min(0.5, Math.abs(freq) / sr);
    return 2 * this.phase - 1 - polyBlep(this.phase, dt);
  }
  /** band-limited square */
  square(freq: number, sr = SR) {
    const dt = Math.min(0.5, Math.abs(freq) / sr);
    let v = this.phase < 0.5 ? 1 : -1;
    v += polyBlep(this.phase, dt);
    v -= polyBlep((this.phase + 0.5) % 1, dt);
    return v;
  }
  triangle() {
    const p = this.phase;
    return 4 * Math.abs(p - 0.5) - 1;
  }
  /** 25% pulse (SID flavour) */
  pulse25(freq: number, sr = SR) {
    const dt = Math.min(0.5, Math.abs(freq) / sr);
    let v = this.phase < 0.25 ? 1 : -1;
    v += polyBlep(this.phase, dt);
    v -= polyBlep((this.phase + 0.75) % 1, dt);
    return v;
  }
  /** classic 4-bit SID-ish waveform via sample-and-hold quantisation of a saw */
  sidNoise(freq: number, sr = SR) {
    const dt = Math.min(0.5, Math.abs(freq) / sr);
    const s = 2 * this.phase - 1 - polyBlep(this.phase, dt);
    return Math.round(s * 7.5) / 7.5;
  }
}

/* ------------------------------------------------------------- filters ----- */

/** Topology-preserving-transform state variable filter (Simper). Stable at audio rate. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  set(cutoff: number, q: number, sr = SR) {
    const f = clamp(cutoff, 10, sr * 0.45);
    const g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / Math.max(0.5, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  process(input: number): number {
    const v3 = input - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = input - this.k * v1 - v2;
    return v2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
}

/** 24 dB ladder (Moog style) — used for LP24. */
export class Ladder {
  private s = [0, 0, 0, 0];
  private g = 0;
  private k = 0;
  private res = 0;
  set(cutoff: number, res: number, sr = SR) {
    const f = clamp(cutoff, 10, sr * 0.45);
    this.g = Math.tan((Math.PI * f) / sr);
    this.k = this.g / (1 + this.g);
    this.res = 4.0 * clamp(res, 0, 0.98);
  }
  process(input: number): number {
    const g = this.k;
    let in4 = input - this.res * this.s[3];
    in4 = Math.tanh(in4 * 0.8) / 0.8; // soft clip keeps it stable at high res
    let out = in4;
    for (let i = 0; i < 4; i++) {
      const v = (out - this.s[i]) * g;
      out = v + this.s[i];
      this.s[i] = out + v;
    }
    return out;
  }
  reset() {
    this.s[0] = this.s[1] = this.s[2] = this.s[3] = 0;
  }
}

export class OnePole {
  private z = 0;
  private a = 0.5;
  set(cutoff: number, sr = SR) {
    const f = clamp(cutoff, 1, sr * 0.45);
    this.a = 1 - Math.exp((-TWO_PI * f) / sr);
  }
  lp(x: number) {
    this.z += this.a * (x - this.z);
    return this.z;
  }
  hp(x: number) {
    return x - this.lp(x);
  }
  reset() {
    this.z = 0;
  }
}

export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  process(x: number) {
    const y = x - this.x1 + 0.995 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/* ---------------------------------------------------------- delay lines ---- */

export class DelayLine {
  buf: Float32Array;
  private idx = 0;
  private size: number;
  constructor(maxSamples: number) {
    this.size = maxSamples + 4;
    this.buf = new Float32Array(this.size);
  }
  write(x: number) {
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.size;
  }
  /** fractional read, `delay` in samples */
  read(delay: number): number {
    let d = delay;
    if (d < 0) d = 0;
    if (d > this.size - 2) d = this.size - 2;
    const pos = this.idx - d + this.size;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = this.buf[i0 % this.size];
    const b = this.buf[(i0 + 1) % this.size];
    // linear interpolation is fine for modulated delays < 3 kHz
    return a + (b - a) * frac;
  }
  clear() {
    this.buf.fill(0);
  }
}

/* ------------------------------------------------------------- shapers ----- */

export function softClip(x: number): number {
  return Math.tanh(x);
}

/** Waveshaper with drive 0..1: transparent -> hard-ish saturation */
export function saturate(x: number, drive: number): number {
  if (drive <= 0.0001) return x;
  const d = 1 + drive * 24;
  return Math.tanh(x * d) / Math.tanh(d);
}

/** Asymmetric tube-ish curve for colour */
export function tube(x: number, drive: number): number {
  const d = 1 + drive * 12;
  const y = Math.tanh(x * d + 0.15 * x * x * d);
  return y / Math.tanh(d);
}

export function waveFold(x: number, amount: number): number {
  if (amount <= 0.0001) return x;
  const g = 1 + amount * 8;
  let y = x * g;
  // triangle fold
  y = Math.abs(((y + 1) % 4 + 4) % 4 - 2) - 1;
  return y;
}

export function bitCrush(x: number, bits: number): number {
  if (bits >= 16) return x;
  const q = Math.pow(2, bits - 1);
  return Math.round(x * q) / q;
}

/* ---------------------------------------------------------------- utils ---- */

export function panGains(pan: number): [number, number] {
  const p = clamp(pan, -1, 1);
  const a = (p + 1) * 0.25 * Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

/** 4-point Hermite interpolation for sample playback. */
export function hermite(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

export function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}
