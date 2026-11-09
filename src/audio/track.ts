/**
 * TrackEngine: one of the eight instrument channels.
 *
 * Owns a voice pool for its current engine, a resonant multimode filter, a per-track
 * LFO, choke handling, pan and effect sends. Synthesis is delegated to the three
 * engines; this class is the "instrument channel" that binds them together.
 *
 * Parameter locks and motion automation are merged into a private effective parameter
 * object (`eff`) per block, so the stored kit is never mutated by the sequencer.
 */
import {
  Svf, Ladder, SR, clamp, envTime, lfoRate, LFO_SYNC_DIVS, noteToHz, panGains, Rng,
} from './dsp';
import { FMVoice } from './fm';
import { MonoVoice } from './mono';
import { SampleBank, SampleVoice } from './sample';
import { TrackFx } from './effects';
import type { ModInputs, Voice } from './voice';
import { NO_MOD } from './voice';
import { normToValue, setRaw } from '../state/params';
import type { ParamKey, TrackParams } from '../state/types';

export const MAX_VOICES = 8;

export interface LockSnapshot {
  /** p-locks + active automation, param key -> normalised value */
  values?: Record<ParamKey, number>;
}

export class TrackEngine {
  index: number;
  params: TrackParams;
  fx: TrackFx;
  eff: TrackParams;
  /** post-filter peak, for the MIX page meters */
  meter = 0;
  peak = 0;
  /** count of voices currently sounding */
  activeVoices = 0;

  private bank: SampleBank;
  private sr: number;
  private fmVoices: FMVoice[] = [];
  private monoVoices: MonoVoice[] = [];
  private sampleVoices: SampleVoice[] = [];
  private lastNote = 60;
  private filterL = new Svf();
  private filterR = new Svf();
  private ladderL = new Ladder();
  private ladderR = new Ladder();
  private filterEnv = 0;
  private filterEnvStage = 0;
  private lfoPhase = 0;
  private lfoSH = 0;
  private lfoRng = new Rng(0x1f2e3d + 7919);
  private lfoFade = 0;
  private mod: ModInputs = { ...NO_MOD };
  private scratch = new Float32Array(0);
  private stL = new Float32Array(0);
  private stR = new Float32Array(0);
  private tempo = 120;
  /** choke state shared with the engine: group -> owning track index */
  private chokeCallback: ((group: number, exceptTrack: number) => void) | null = null;
  /**
   * The parameter-lock set currently in force for this track. Elektron semantics: a trig's
   * locks stay applied until the next trig. Keeping them here (rather than only at
   * note-on) is what makes locked sounds hold their character while they decay.
   */
  private activeLocks: Record<string, number> | null = null;

  constructor(index: number, params: TrackParams, bank: SampleBank, sr = SR) {
    this.index = index;
    this.params = params;
    this.eff = cloneParams(params);
    this.bank = bank;
    this.sr = sr;
    this.fx = new TrackFx(sr);
    for (let i = 0; i < MAX_VOICES; i++) {
      this.fmVoices.push(new FMVoice(sr));
      this.monoVoices.push(new MonoVoice(sr));
      this.sampleVoices.push(new SampleVoice(bank, sr));
    }
  }

  setTempo(tempo: number) {
    this.tempo = tempo;
  }

  setChokeHandler(cb: (group: number, exceptTrack: number) => void) {
    this.chokeCallback = cb;
  }

  private voicesFor(engine: TrackParams['engine']): Voice[] {
    if (engine === 'fm') return this.fmVoices;
    if (engine === 'mono') return this.monoVoices;
    return this.sampleVoices;
  }

  private syncEffective(locks: LockSnapshot | null) {
    copyParams(this.params, this.eff);
    const active = locks?.values ?? this.activeLocks;
    if (active) {
      for (const k in active) {
        // structural params (engine choice, loop mode...) are not lockable, but guard anyway
        setRaw(this.eff, k, normToValue(k, active[k]));
      }
    }
  }

  noteOn(note: number, vel = 0.9, locks: LockSnapshot | null = null) {
    // A trig replaces the lock set; a live pad hit clears it (no stale locks).
    this.activeLocks = locks?.values ?? null;
    this.syncEffective(locks);
    const p = this.eff;
    if (p.engine === 'sample' && p.sample.choke > 0) {
      for (const v of this.sampleVoices) v.kill();
      this.chokeCallback?.(p.sample.choke, this.index);
    }
    const pool = this.voicesFor(p.engine);
    let slot = pool.findIndex((v) => !v.active);
    if (slot < 0) {
      let minAmp = Infinity;
      slot = 0;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].ampValue < minAmp) {
          minAmp = pool[i].ampValue;
          slot = i;
        }
      }
      pool[slot].kill();
    }
    const v = pool[slot];
    if (p.engine === 'fm') (v as FMVoice).noteOn(note, vel, p, false);
    else if (p.engine === 'mono') (v as MonoVoice).noteOn(note, vel, p, false);
    else (v as SampleVoice).noteOn(note, vel, p, false);
    this.lastNote = note;
    this.filterEnv = 0;
    this.filterEnvStage = 1;
    if (p.lfo.retrig) {
      this.lfoPhase = 0;
      this.lfoSH = this.lfoRng.next() * 2 - 1;
      this.lfoFade = 0;
    }
  }

  noteOff(note?: number) {
    const pool = this.voicesFor(this.eff.engine);
    for (const v of pool) if (!note || v.note === note) v.noteOff();
  }

  allNotesOff() {
    this.activeLocks = null;
    for (const v of this.fmVoices) v.kill();
    for (const v of this.monoVoices) v.kill();
    for (const v of this.sampleVoices) v.kill();
    this.filterEnvStage = 0;
    this.filterEnv = 0;
  }

  /** Kill sample voices in a choke group (used for cross-track choke). */
  chokeIfGroup(group: number) {
    if (this.params.engine === 'sample' && this.params.sample.choke === group) {
      for (const v of this.sampleVoices) v.kill();
    }
  }

  /**
   * Render one block (`n` frames starting at `offset`) of this track into the stereo
   * bus and its two send buses. Insert FX (drive + chorus/phaser) run per track.
   */
  render(
    busL: Float32Array, busR: Float32Array,
    sendAL: Float32Array, sendAR: Float32Array,
    sendBL: Float32Array, sendBR: Float32Array,
    offset: number, n: number, locks: LockSnapshot | null,
  ) {
    this.syncEffective(locks);
    const p = this.eff;
    const sr = this.sr;
    if (this.scratch.length < n) {
      this.scratch = new Float32Array(n);
      this.stL = new Float32Array(n);
      this.stR = new Float32Array(n);
    }
    const mono = this.scratch;
    mono.fill(0);
    const pool = this.voicesFor(p.engine);
    const mod = this.computeMod(p, n);
    let sounding = 0;
    for (const v of pool) {
      if (v.active) {
        v.render(mono, 0, n, p, mod);
        sounding++;
      }
    }
    this.activeVoices = sounding;

    /* ---- filter + pan + sends ------------------------------------------------- */
    const keyHz = noteToHz(this.lastNote);
    const kt = clamp(p.filter.keytrack);
    const cutoffBase = clamp(
      p.filter.cutoff * (1 + (keyHz / 261.63 - 1) * kt * 0.9) + mod.cutoffMod,
      20, 19000,
    );
    const q = 0.7 + p.filter.reso * 14;
    const typeIdx = ['LP12', 'LP24', 'HP12', 'BP12', 'NOTCH'].indexOf(p.filter.type);
    const useLadder = p.filter.type === 'LP24';
    const drive = p.filter.drive;
    const fEnvCoefA = Math.exp(-1 / Math.max(1, envTime(p.filter.envAtk) * sr * 0.35));
    const fEnvCoefD = Math.exp(-1 / Math.max(1, envTime(p.filter.envDec) * sr * 0.35));
    const envAmt = p.filter.env;
    const vol = p.volume * (p.mute ? 0 : 1);
    const panPos = clamp(p.pan + mod.panOffset, -1, 1);
    const [gl, gr] = panGains(panPos);
    // sendA/sendB are the physical FX SEND amount; fx.delay / fx.reverb scale how much of
    // that send goes to the delay vs the reverb bus (both are real audio paths).
    const sendA = p.sendA * Math.max(p.fx.delay, p.sendB > 0 ? 0.15 : 0);
    const sendB = p.sendB * Math.max(p.fx.reverb, 0.15);
    const chunk = 32;
    let blockPeak = 0;
    const stL = this.stL;
    const stR = this.stR;
    for (let s = 0; s < n; s += chunk) {
      if (this.filterEnvStage === 1) {
        this.filterEnv += (1 - this.filterEnv) * (1 - fEnvCoefA);
        if (this.filterEnv > 0.995) {
          this.filterEnv = 1;
          this.filterEnvStage = 2;
        }
      } else if (this.filterEnvStage === 2) {
        this.filterEnv *= fEnvCoefD;
        if (this.filterEnv < 1e-4) {
          this.filterEnv = 0;
          this.filterEnvStage = 0;
        }
      }
      const fc = clamp(cutoffBase + this.filterEnv * envAmt * 11000, 25, sr * 0.45);
      if (useLadder) {
        this.ladderL.set(fc, p.filter.reso, sr);
        this.ladderR.set(fc, p.filter.reso, sr);
      } else {
        this.filterL.set(fc, q, sr);
        this.filterR.set(fc, q, sr);
      }
      const lim = Math.min(n, s + chunk);
      for (let i = s; i < lim; i++) {
        let x = mono[i];
        if (drive > 0.001) x = Math.tanh(x * (1 + drive * 10)) / (1 + drive * 2.5);
        let y: number;
        if (useLadder) {
          y = this.ladderL.process(x);
        } else {
          this.filterL.process(x);
          this.filterR.process(x);
          switch (typeIdx) {
            case 2: y = this.filterL.hp; break;
            case 3: y = this.filterL.bp; break;
            case 4: y = x - q * this.filterL.bp - this.filterL.lp; break;
            default: y = this.filterL.lp; break;
          }
        }
        const a = y < 0 ? -y : y;
        if (a > blockPeak) blockPeak = a;
        const oL = y * vol * gl;
        const oR = y * vol * gr;
        stL[i] = oL;
        stR[i] = oR;
      }
    }
    // per-track insert fx (dist + chorus/flanger/phaser) on the filtered stereo signal
    const distAmt = p.fx.distortion;
    const modAmt = p.fx.mod;
    this.fx.configure('chorus', 0.5, 0.35);
    for (let i = 0; i < n; i++) {
      let [l, r] = this.fx.process(stL[i], stR[i], distAmt, modAmt);
      if (l > 8) l = 8; else if (l < -8) l = -8;
      if (r > 8) r = 8; else if (r < -8) r = -8;
      busL[offset + i] += l;
      busR[offset + i] += r;
      if (sendA > 0.001) {
        sendAL[offset + i] += l * sendA;
        sendAR[offset + i] += r * sendA;
      }
      if (sendB > 0.001) {
        sendBL[offset + i] += l * sendB;
        sendBR[offset + i] += r * sendB;
      }
    }
    this.meter = this.meter * 0.75 + blockPeak * 0.25;
    if (blockPeak > this.peak) this.peak = blockPeak;
  }

  private computeMod(p: TrackParams, n: number): ModInputs {
    const m = this.mod;
    m.pitchMul = 1;
    m.ampMul = 1;
    m.colorOffset = 0;
    m.decayMul = 1;
    m.panOffset = 0;
    m.cutoffMod = 0;
    const lfo = p.lfo;
    if (lfo.depth <= 0.0005) {
      this.lfoFade = 0;
      return m;
    }
    const rate = lfo.sync
      ? (this.tempo / 60) /
        LFO_SYNC_DIVS[clamp(Math.round(lfo.speed * (LFO_SYNC_DIVS.length - 1)), 0, LFO_SYNC_DIVS.length - 1)]
      : lfoRate(lfo.speed);
    this.lfoPhase += (rate * n) / this.sr;
    if (this.lfoPhase >= 1) {
      this.lfoPhase -= Math.floor(this.lfoPhase);
      this.lfoSH = this.lfoRng.next() * 2 - 1;
    }
    this.lfoFade = Math.min(1, this.lfoFade + (n / this.sr) / Math.max(0.005, lfo.fade * 3));
    const ph = this.lfoPhase;
    let v: number;
    switch (lfo.shape) {
      case 'TRI': v = 4 * Math.abs(ph - 0.5) - 1; break;
      case 'SAW': v = ph * 2 - 1; break;
      case 'SQR': v = ph < 0.5 ? 1 : -1; break;
      case 'S&H': v = this.lfoSH; break;
      case 'RAMP': v = 1 - ph * 2; break;
      default: v = Math.sin(ph * Math.PI * 2); break;
    }
    const depth = lfo.depth * this.lfoFade;
    const amt = v * depth;
    switch (lfo.dest) {
      case 'TUNE': m.pitchMul = Math.pow(2, amt); break; // +-12 semitones at full depth
      case 'AMP': m.ampMul = clamp(1 - depth + depth * (0.5 + 0.5 * v), 0, 1); break;
      case 'PAN': m.panOffset = amt; break;
      case 'INDEX': m.colorOffset = amt; break;
      case 'DECAY': m.decayMul = Math.pow(4, -amt); break;
      case 'CUTOFF': m.cutoffMod = amt * 6000; break;
      default: break;
    }
    return m;
  }
}

/* ----------------------------------------------------------------- helpers --- */

export function copyParams(src: TrackParams, dst: TrackParams) {
  dst.engine = src.engine;
  dst.volume = src.volume;
  dst.pan = src.pan;
  dst.mute = src.mute;
  dst.solo = src.solo;
  dst.sendA = src.sendA;
  dst.sendB = src.sendB;
  Object.assign(dst.amp, src.amp);
  Object.assign(dst.filter, src.filter);
  Object.assign(dst.lfo, src.lfo);
  Object.assign(dst.fx, src.fx);
  Object.assign(dst.fm, src.fm);
  Object.assign(dst.mono, src.mono);
  Object.assign(dst.sample, src.sample);
  for (let i = 0; i < 4; i++) Object.assign(dst.fm.ops[i], src.fm.ops[i]);
}

export function cloneParams(p: TrackParams): TrackParams {
  return JSON.parse(JSON.stringify(p)) as TrackParams;
}
