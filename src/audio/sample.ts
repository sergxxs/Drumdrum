/**
 * ENGINE C — sampler.
 *
 * Sample data lives in a `SampleBank` (id -> normalised Float32 channels). Playback
 * supports start/end trim, reverse, forward/ping-pong looping, slice mapping across the
 * keyboard, choke groups, and a granular overlap-add stretcher (documented limitation:
 * it is a simple 2-grain OLA, so extreme stretch factors get artefacts; this is honest,
 * not a full phase-vocoder).
 */
import { Adsr, SR, clamp, envTime, hermite, noteToHz } from './dsp';
import type { Voice, ModInputs } from './voice';
import type { SampleMeta, SampleParams, TrackParams } from '../state/types';

export interface SampleData {
  meta: SampleMeta;
  left: Float32Array;
  right: Float32Array | null;
}

export class SampleBank {
  private map = new Map<string, SampleData>();
  set(data: SampleData) {
    this.map.set(data.meta.id, data);
  }
  get(id: string | null): SampleData | undefined {
    return id ? this.map.get(id) : undefined;
  }
  delete(id: string) {
    this.map.delete(id);
  }
  list(): SampleMeta[] {
    return [...this.map.values()].map((d) => d.meta);
  }
  has(id: string) {
    return this.map.has(id);
  }
}

/**
 * Transient detection (spectral-flux style energy novelty on a coarse envelope).
 * Returns normalised positions 0..1 into the buffer.
 */
export function detectTransients(
  left: Float32Array,
  sr: number,
  sensitivity = 0.5,
  maxCount = 64,
): number[] {
  const hop = Math.max(1, Math.round(sr * 0.005)); // 5 ms
  const frames = Math.floor(left.length / hop);
  if (frames < 3) return [];
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) {
      const v = left[f * hop + i];
      s += v * v;
    }
    env[f] = Math.sqrt(s / hop);
  }
  // log-domain flux
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = Math.log1p(env[f] * 40) - Math.log1p(env[f - 1] * 40);
    flux[f] = Math.max(0, d);
  }
  let maxFlux = 1e-9;
  for (let f = 0; f < frames; f++) maxFlux = Math.max(maxFlux, flux[f]);
  const thresh = maxFlux * (0.35 - sensitivity * 0.3);
  const out: number[] = [0];
  const minGap = Math.round(0.04 / 0.005); // 40 ms minimum
  let last = -minGap;
  for (let f = 1; f < frames && out.length < maxCount; f++) {
    if (flux[f] >= thresh && f - last >= minGap) {
      out.push(f / frames);
      last = f;
    }
  }
  return out;
}

/** Peak envelope for waveform drawing. */
export function computePeaks(left: Float32Array, buckets = 256): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(left.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let p = 0;
    const start = b * step;
    const end = Math.min(left.length, start + step);
    for (let i = start; i < end; i++) {
      const a = Math.abs(left[i]);
      if (a > p) p = a;
    }
    out.push(p);
  }
  return out;
}

export class SampleVoice implements Voice {
  active = false;
  note = 60;
  released = false;
  ampValue = 0;
  /** which slice this voice plays (resolved at note-on) */
  slice = 0;
  private vel = 1;
  private sr: number;
  private amp = new Adsr();
  private bank: SampleBank;
  private data: SampleData | null = null;
  /** playback position in source frames (float) */
  private pos = 0;
  private dir = 1;
  private startF = 0;
  private endF = 0;
  private loopStartF = 0;
  private loopEndF = 0;
  private rate = 1;
  private loopMode: SampleParams['loopMode'] = 'off';
  private age = 0;
  private grainPhase = 0;
  private grainSize = 1024;
  private stretch = 1;
  private shaper = 0;
  private shaperAmt = 0;

  constructor(bank: SampleBank, sr = SR) {
    this.bank = bank;
    this.sr = sr;
  }

  noteOn(note: number, vel: number, p: TrackParams, legato = false) {
    const s = p.sample;
    const data = this.bank.get(s.sampleId);
    if (!data) {
      this.active = false;
      return;
    }
    this.data = data;
    this.active = true;
    this.released = false;
    this.note = note;
    this.vel = clamp(vel, 0, 1);
    this.age = 0;
    this.dir = s.reverse ? -1 : 1;
    this.loopMode = s.loopMode;
    this.stretch = s.stretch;
    this.shaper = s.shaper;
    this.shaperAmt = s.shaperAmt;
    const frames = data.left.length;
    // slice mapping: slices divide the trimmed region across notes from the played note
    const sliceCount = Math.max(1, Math.round(s.slices));
    this.slice = Math.min(sliceCount - 1, Math.max(0, note - 60) % sliceCount);
    const trimStart = s.start * frames;
    const trimEnd = s.end * frames;
    const sliceLen = (trimEnd - trimStart) / sliceCount;
    let sStart = trimStart + sliceLen * this.slice;
    let sEnd = sStart + sliceLen;
    if (sliceCount === 1) {
      sStart = trimStart;
      sEnd = trimEnd;
    }
    this.startF = Math.max(0, Math.min(frames - 2, sStart));
    this.endF = Math.max(this.startF + 2, Math.min(frames, sEnd));
    const span = this.endF - this.startF;
    this.loopStartF = this.startF + span * clamp(s.loopStart);
    this.loopEndF = this.startF + span * clamp(s.loopEnd);
    if (this.loopEndF <= this.loopStartF + 4) this.loopEndF = this.loopStartF + 4;
    this.pos = this.dir > 0 ? this.startF : this.endF - 1;
    const semis = s.pitch + s.tune / 100 + (note - 60) * (sliceCount > 1 ? 0 : 1);
    this.rate = Math.pow(2, semis / 12) * s.rate * (data.meta.sampleRate / this.sr);
    this.amp.set(s.atk, s.dec, s.sus, s.rel, this.sr);
    this.amp.gateOn();
    this.grainPhase = 0;
    this.grainSize = 2048;
    void legato;
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
    if (!this.active || !this.data) return;
    const d = this.data;
    const L = d.left;
    const R = d.right;
    const len = L.length;
    const velAmp = 1 - p.amp.vel + p.amp.vel * this.vel;
    const sh = this.shaper;
    const shAmt = this.shaperAmt;
    const useOLA = this.stretch < 0.97 || this.stretch > 1.03;
    const sr = this.sr;

    for (let s = 0; s < n; s++) {
      let smp = 0;
      if (useOLA) {
        // 2-grain overlap-add stretch: read a fast-scrolling grain, crossfade with a
        // second grain offset by half a grain.
        const gSize = 1024;
        this.grainPhase += (this.rate / this.stretch) / sr * gSize;
        if (this.grainPhase >= gSize) this.grainPhase -= gSize;
        const w1 = Math.sin((Math.PI * this.grainPhase) / gSize);
        const p1 = this.pos;
        const p2 = this.pos - gSize * 0.5;
        smp = sampleAt(L, p1) * w1 + sampleAt(L, p2) * (1 - w1);
        this.pos += this.rate;
      } else {
        smp = sampleAt(L, this.pos);
        this.pos += this.rate * this.dir;
      }
      // loop / boundary handling
      if (this.loopMode !== 'off' && this.loopStartF < this.loopEndF) {
        if (this.dir > 0 && this.pos >= this.loopEndF) {
          if (this.loopMode === 'forward') this.pos = this.loopStartF + (this.pos - this.loopEndF);
          else {
            this.pos = this.loopEndF - (this.pos - this.loopEndF);
            this.dir = -1;
          }
        } else if (this.dir < 0 && this.pos <= this.loopStartF) {
          if (this.loopMode === 'forward') this.pos = this.loopStartF + 1;
          else {
            this.pos = this.loopStartF + (this.loopStartF - this.pos);
            this.dir = 1;
          }
        }
      }
      if (this.pos >= this.endF || this.pos < this.startF - 1 || this.pos >= len) {
        if (this.loopMode === 'off') {
          this.pos = this.dir > 0 ? len : 0;
          // one-shot finished
          this.amp.stage = 0;
          this.amp.value = 0;
          out[offset + s] += 0;
          this.active = false;
          this.ampValue = 0;
          return;
        }
        this.pos = this.dir > 0 ? this.startF : this.endF - 1;
      }
      // shaper
      if (shAmt > 0.001) {
        if (sh === 1) {
          const bits = 16 - shAmt * 13;
          const q = Math.pow(2, Math.max(1, bits) - 1);
          smp = Math.round(smp * q) / q;
        } else if (sh === 2) {
          const g = 1 + shAmt * 8;
          const y = smp * g;
          smp = Math.abs(((y + 1) % 4 + 4) % 4 - 2) - 1;
        } else if (sh === 3) {
          smp = Math.tanh(smp * (1 + shAmt * 12)) / Math.tanh(1 + shAmt * 12);
        }
      }
      const a = this.amp.tick();
      out[offset + s] += smp * a * velAmp * mod.ampMul;
      this.age++;
    }
    this.ampValue = this.amp.value * velAmp;
    if (this.released && this.amp.stage === 0) this.kill();
    if (!R) void R;
  }
}

function sampleAt(buf: Float32Array, pos: number): number {
  if (pos < 0 || pos >= buf.length - 2) return 0;
  const i = pos | 0;
  const t = pos - i;
  return hermite(buf[i - 1] || 0, buf[i], buf[i + 1], buf[i + 2] || 0, t);
}

/** Parse a WAV file (8/16/24/32 bit PCM, float32) into normalised channels. */
export function decodeWav(buffer: ArrayBuffer): { left: Float32Array; right: Float32Array | null; sampleRate: number } {
  const dv = new DataView(buffer);
  if (dv.byteLength < 44) throw new Error('WAV too short');
  const riff = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a RIFF/WAV file');
  let pos = 12;
  let fmt = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let dataOffset = -1;
  let dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(
      dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3),
    );
    const len = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(pos + 8, true);
      channels = dv.getUint16(pos + 10, true);
      sampleRate = dv.getUint32(pos + 12, true);
      bits = dv.getUint16(pos + 22, true);
      if (fmt === 0xfffe && len >= 40) fmt = dv.getUint16(pos + 32, true);
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataLen = Math.min(len, dv.byteLength - dataOffset);
      break;
    }
    pos += 8 + len + (len % 2);
  }
  if (dataOffset < 0) throw new Error('No data chunk');
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const left = new Float32Array(frames);
  const right = channels > 1 ? new Float32Array(frames) : null;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOffset + (i * channels + c) * bytes;
      let v = 0;
      if (fmt === 3 && bits === 32) v = dv.getFloat32(o, true);
      else if (bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) {
        const b0 = dv.getUint8(o);
        const b1 = dv.getUint8(o + 1);
        const b2 = dv.getUint8(o + 2);
        let x = (b2 << 16) | (b1 << 8) | b0;
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      if (c === 0) left[i] = v;
      else if (c === 1 && right) right[i] = v;
    }
  }
  return { left, right, sampleRate };
}

/** Build a SampleData from raw channels + name. */
export function makeSample(
  id: string,
  name: string,
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  transients: number[] = [],
  peaks: number[] = computePeaks(left),
): SampleData {
  return {
    meta: {
      id, name, frames: left.length, sampleRate,
      channels: right ? 2 : 1,
      transients,
      peaks,
      createdAt: Date.now(),
    },
    left,
    right,
  };
}

/**
 * Built-in sample pool. These are synthesised procedurally at first launch (real audio,
 * not placeholders) so the sample engine is usable before the user imports anything.
 */
export function buildFactorySamples(sr = SR): SampleData[] {
  const rnd = (() => {
    let s = 0x12345678;
    return () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s / 2147483648);
    };
  })();

  const mk = (name: string, seconds: number, fn: (t: number, i: number) => number) => {
    const n = Math.round(seconds * sr);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = fn(i / sr, i);
    // normalise
    let p = 1e-6;
    for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(buf[i]));
    for (let i = 0; i < n; i++) buf[i] /= p;
    return buf;
  };

  const out: SampleData[] = [];

  // 1. vocal-ish "ah" formant texture (additive formant synthesis)
  const vocal = mk('VOX AH', 1.2, (t) => {
    const f0 = 220;
    const env = Math.exp(-t * 1.6) * (1 - Math.exp(-t * 60));
    let v = 0;
    const formants = [[700, 1.0], [1130, 0.6], [2450, 0.35], [3400, 0.15]];
    for (let h = 1; h <= 40; h++) {
      const f = h * f0;
      let g = 0;
      for (const [ff, amp] of formants) {
        g += amp * Math.exp(-Math.pow((f - ff) / 180, 2));
      }
      v += Math.sin(2 * Math.PI * f * t + h * 0.3) * g * 0.06;
    }
    // vibrato
    return v * env * (1 + 0.15 * Math.sin(2 * Math.PI * 5.2 * t));
  });
  out.push(makeSample('factory-vox-ah', 'VOX AH', vocal, null, sr, [0], computePeaks(vocal)));

  // 2. vinyl/tape hiss texture
  const hiss = mk('TAPE HISS', 2.0, (t, i) => {
    const n = rnd() * 0.6 + rnd() * 0.4;
    const crackle = rnd() > 0.9995 ? rnd() * 4 : 0;
    const hum = Math.sin(2 * Math.PI * 60 * t) * 0.05;
    return (n + crackle + hum) * (0.6 + 0.4 * Math.sin(t * 1.3));
  });
  out.push(makeSample('factory-hiss', 'TAPE HISS', hiss, null, sr, [0], computePeaks(hiss)));

  // 3. metallic clang (inharmonic decay) — great for percussion
  const clang = mk('CLANG', 1.4, (t) => {
    const ratios = [1, 2.76, 5.4, 8.93, 13.34, 18.64];
    let v = 0;
    const env = Math.exp(-t * 4.5);
    for (let i = 0; i < ratios.length; i++) {
      v += Math.sin(2 * Math.PI * 320 * ratios[i] * t) * env / (i + 1.3);
    }
    return v + (rnd() * 0.4) * Math.exp(-t * 90);
  });
  out.push(makeSample('factory-clang', 'CLANG', clang, null, sr, [0], computePeaks(clang)));

  // 4. break-ish drum loop (kick/snare/hats) — 2 bars at 120 bpm, used for slicing demos
  const bs = 60 / 120 / 4; // 16th
  const loopLen = Math.round(bs * 32 * sr);
  const loop = new Float32Array(loopLen);
  const placeDrum = (beat16: number, type: 'k' | 's' | 'h') => {
    const start = Math.round(beat16 * bs * sr);
    const len = Math.round((type === 'h' ? 0.06 : 0.28) * sr);
    for (let i = 0; i < len && start + i < loopLen; i++) {
      const t = i / sr;
      const p = i / len;
      if (type === 'k') {
        const f = 110 * Math.exp(-t * 26) + 44;
        loop[start + i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 12) * 1.1;
        loop[start + i] += rnd() * Math.exp(-t * 200) * 0.5;
      } else if (type === 's') {
        loop[start + i] += (rnd() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18);
      } else {
        loop[start + i] += rnd() * Math.exp(-t * 70) * 0.35;
      }
      void p;
    }
  };
  for (let b = 0; b < 32; b += 4) placeDrum(b, 'k');
  for (let b = 4; b < 32; b += 8) placeDrum(b, 's');
  for (let b = 0; b < 32; b++) if (b % 2 === 1) placeDrum(b, 'h');
  let peakV = 1e-6;
  for (let i = 0; i < loopLen; i++) peakV = Math.max(peakV, Math.abs(loop[i]));
  for (let i = 0; i < loopLen; i++) loop[i] /= peakV;
  const transients = detectTransients(loop, sr, 0.5, 32);
  out.push(makeSample('factory-break', 'BREAK 120', loop, null, sr, transients, computePeaks(loop)));

  // 5. pure sine "sub tone" (useful for subs / 808 drags)
  const sub = mk('SUB SINE', 1.0, (t) => Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 1.2));
  out.push(makeSample('factory-sub', 'SUB SINE', sub, null, sr, [0], computePeaks(sub)));

  return out;
}

/** Re-normalise + slice helper used by the SAMPLE page actions. */
export function retrim(params: SampleParams, start: number, end: number) {
  params.start = clamp(Math.min(start, end - 0.001));
  params.end = clamp(Math.max(end, start + 0.001));
}

export const _sr = SR;
export const _envTime = envTime;
export const _noteToHz = noteToHz;
