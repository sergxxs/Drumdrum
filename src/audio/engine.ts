/**
 * AudioEngine — the instrument.
 *
 * Owns the eight TrackEngines, the effects sends, the master chain, the sequencer and
 * the transport. It is host-agnostic: `processInto()` is called by the AudioWorklet host
 * in real time and by `renderOffline()` for export. There is exactly one code path, so
 * what you export is exactly what you heard.
 */
import { SR, clamp, Rng } from './dsp';
import { TrackEngine, MAX_VOICES } from './track';
import type { LockSnapshot } from './track';
import { SampleBank } from './sample';
import { StereoDelay, Reverb, MasterChain } from './effects';
import { SequencerEngine, SEQ_MAX_STEPS } from '../seq/sequencer';
import type { SeqEvent } from '../seq/sequencer';
import type {
  Kit, MasterParams, Pattern, Project, TrackParams, Song,
} from '../state/types';

export interface EngineOptions {
  sampleRate?: number;
  /** max frames per process call */
  blockSize?: number;
}

export interface Meters {
  /** per-track peak 0..1 */
  tracks: number[];
  masterL: number;
  masterR: number;
}

export class AudioEngine {
  readonly sr: number;
  readonly bank = new SampleBank();
  tracks: TrackEngine[] = [];
  seq: SequencerEngine;
  sendA: StereoDelay;
  sendB: Reverb;
  master = new MasterChain();
  kit: Kit;
  project: Project | null = null;
  /** absolute frame counter since engine creation */
  frame = 0;
  /** recording state */
  recording = false;
  recordBufferL: Float32Array[] = [];
  recordBufferR: Float32Array[] = [];
  private sendAL: Float32Array;
  private sendAR: Float32Array;
  private sendBL: Float32Array;
  private sendBR: Float32Array;
  private busL: Float32Array;
  private busR: Float32Array;
  meters: Meters = { tracks: new Array(8).fill(0), masterL: 0, masterR: 0 };
  /** pending note-offs in absolute frames */
  private audioNoteOffs: { track: number; note: number; frame: number }[] = [];
  /** live-record callback */
  onLiveNote: ((track: number, note: number, vel: number) => void) | null = null;
  /** metronome click synth state */
  private clickEnv = 0;
  private clickAccent = false;
  private clickPhase = 0;
  clickEnabled = false;
  /** song/chain playback */
  chain: number[] = [];
  chainIndex = 0;
  chainLoop = false;
  patternProvider: ((index: number) => Pattern) | null = null;
  /** live performance state */
  private rng = new Rng();
  static MAX_VOICES = MAX_VOICES;

  constructor(project: Project, opts: EngineOptions = {}) {
    this.sr = opts.sampleRate ?? SR;
    this.project = project;
    this.kit = project.kits[project.currentKit];
    this.seq = new SequencerEngine(project.patterns[project.currentPattern], this.sr);
    this.seq.tempo = project.patterns[project.currentPattern].tempo;
    this.seq.swing = project.patterns[project.currentPattern].swing;
    this.sendA = new StereoDelay(this.sr);
    this.sendB = new Reverb(this.sr);
    this.chain = project.chain.slice();
    this.chainLoop = project.chainLoop;
    const block = opts.blockSize ?? 256;
    this.sendAL = new Float32Array(block);
    this.sendAR = new Float32Array(block);
    this.sendBL = new Float32Array(block);
    this.sendBR = new Float32Array(block);
    this.busL = new Float32Array(block);
    this.busR = new Float32Array(block);
    for (let i = 0; i < 8; i++) {
      const tr = new TrackEngine(i, this.kit.tracks[i].params, this.bank, this.sr);
      tr.setTempo(this.seq.tempo);
      tr.setChokeHandler((group, except) => {
        for (let j = 0; j < this.tracks.length; j++) {
          if (j !== except) this.tracks[j].chokeIfGroup(group);
        }
      });
      this.tracks.push(tr);
    }
    this.configureMaster();
    this.configureSends();
    this.seq.onPatternEnd = () => this.advanceSong();
  }

  /**
   * Song mode / pattern chain: when track 0 finishes a pattern we either move to the next
   * chained pattern or, in song mode, follow the arrangement.
   */
  songMode = false;
  private songStep = 0;
  private songRepeat = 0;

  setSongMode(on: boolean) {
    this.songMode = on;
    this.songStep = 0;
    this.songRepeat = 0;
  }

  private advanceSong() {
    const project = this.project;
    if (!project || !this.patternProvider) return;
    if (this.songMode) {
      const song = project.songs[project.currentSong];
      const steps = song?.steps ?? [];
      if (!steps.length) return;
      this.songRepeat++;
      if (this.songRepeat >= steps[this.songStep % steps.length].repeats) {
        this.songRepeat = 0;
        this.songStep++;
        if (this.songStep >= steps.length) {
          this.songStep = 0;
          if (!this.loopSong) {
            this.songMode = false;
            this.seq.playing = false;
            return;
          }
        }
      }
      const target = steps[this.songStep % steps.length].pattern;
      this.setPattern(this.patternProvider(target));
      return;
    }
    // pattern chain
    if (this.chain.length === 0) return;
    this.chainIndex++;
    if (this.chainIndex >= this.chain.length) {
      if (!this.chainLoop) {
        this.chainIndex = 0;
        return;
      }
      this.chainIndex = 0;
    }
    const target = this.chain[this.chainIndex];
    if (target !== undefined) this.setPattern(this.patternProvider(target));
  }

  loopSong = true;

  /* ------------------------------------------------------------- config --- */

  get currentPattern(): Pattern {
    return this.seq.pattern;
  }

  setPattern(p: Pattern) {
    this.seq.setPattern(p);
    this.seq.tempo = p.tempo;
    this.seq.swing = p.swing;
    for (const t of this.tracks) t.setTempo(p.tempo);
  }

  setTempo(tempo: number) {
    this.seq.tempo = clamp(tempo, 30, 300);
    for (const t of this.tracks) t.setTempo(this.seq.tempo);
  }

  setSwing(swing: number) {
    this.seq.swing = clamp(swing, 0, 0.75);
  }

  setKit(kit: Kit) {
    this.kit = kit;
    for (let i = 0; i < 8; i++) {
      this.tracks[i].params = kit.tracks[i].params;
      this.tracks[i].eff = JSON.parse(JSON.stringify(kit.tracks[i].params));
    }
    this.configureMaster();
    this.configureSends();
  }

  configureMaster() {
    this.master.configure(this.kit.master ?? (this.project?.master as MasterParams));
  }

  configureSends() {
    const s = this.kit.sends;
    this.sendA.configure(s.delayTime, s.delayFeedback, s.delayTone, s.delayPingPong);
    this.sendB.configure(s.revSize, s.revDamp, s.revPre);
  }

  setClick(on: boolean) {
    this.clickEnabled = on;
    this.seq.clickEnabled = on;
    if (!this.seq.onClick) {
      this.seq.onClick = (_offset, accent) => {
        this.clickEnv = 1;
        this.clickAccent = accent;
        this.clickPhase = 0;
      };
    }
    if (!on) this.clickEnv = 0;
  }

  /* ---------------------------------------------------------- transport --- */

  play() {
    if (this.seq.playing) return;
    if (this.seq.startFrame === 0 || this.seq.lastStep[0] === -1) {
      this.seq.start(this.frame);
    } else {
      this.seq.resume(this.frame);
    }
  }

  stop() {
    this.seq.stop();
    for (const t of this.tracks) t.allNotesOff();
    this.audioNoteOffs.length = 0;
    this.master.comp.gainReduction = 1;
  }

  togglePlay() {
    if (this.seq.playing) this.stop();
    else this.play();
  }

  /** Live pad / keyboard trigger. */
  trigger(track: number, note: number, vel = 0.9, lengthFrames?: number) {
    const t = this.tracks[track];
    if (!t) return;
    t.noteOn(note, vel, null);
    if (lengthFrames !== undefined) {
      this.audioNoteOffs.push({ track, note, frame: this.frame + lengthFrames });
    } else {
      // default gate: 1/16 note or until release
      this.audioNoteOffs.push({
        track, note,
        frame: this.frame + Math.round(this.seq.stepFrames(track) * 0.9),
      });
    }
    this.onLiveNote?.(track, note, vel);
  }

  release(track: number, note: number) {
    this.tracks[track]?.noteOff(note);
    this.audioNoteOffs = this.audioNoteOffs.filter((o) => !(o.track === track && o.note === note));
  }

  startRecording() {
    this.recording = true;
    this.recordBufferL = [];
    this.recordBufferR = [];
  }

  stopRecording(): { left: Float32Array; right: Float32Array } {
    this.recording = false;
    const total = this.recordBufferL.reduce((a, b) => a + b.length, 0);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let o = 0;
    for (let i = 0; i < this.recordBufferL.length; i++) {
      left.set(this.recordBufferL[i], o);
      right.set(this.recordBufferR[i], o);
      o += this.recordBufferL[i].length;
    }
    this.recordBufferL = [];
    this.recordBufferR = [];
    return { left, right };
  }

  get recordedFrames() {
    return this.recordBufferL.reduce((a, b) => a + b.length, 0);
  }

  /* ---------------------------------------------------------- rendering --- */

  /**
   * Render `n` frames into the provided stereo buffers (overwrites).
   * This is the single audio path used live and offline.
   */
  processInto(outL: Float32Array, outR: Float32Array, n: number) {
    if (this.busL.length < n) {
      this.busL = new Float32Array(n);
      this.busR = new Float32Array(n);
      this.sendAL = new Float32Array(n);
      this.sendAR = new Float32Array(n);
      this.sendBL = new Float32Array(n);
      this.sendBR = new Float32Array(n);
    }
    const busL = this.busL;
    const busR = this.busR;
    const sendAL = this.sendAL, sendAR = this.sendAR, sendBL = this.sendBL, sendBR = this.sendBR;
    for (let i = 0; i < n; i++) {
      busL[i] = 0; busR[i] = 0;
      sendAL[i] = 0; sendAR[i] = 0; sendBL[i] = 0; sendBR[i] = 0;
    }
    const { events, offs } = this.seq.advance(this.frame, n);
    // split the block at event boundaries so each trigger starts on its exact sample
    let cursor = 0;
    const renderSegment = (end: number) => {
      const len = end - cursor;
      if (len <= 0) return;
      for (let t = 0; t < 8; t++) {
        const tr = this.tracks[t];
        tr.render(busL, busR, sendAL, sendAR, sendBL, sendBR, cursor, len, null);
      }
      cursor = end;
    };
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      const at = clamp(ev.offset, 0, n);
      renderSegment(at);
      this.startSequencedNote(ev);
    }
    // audio-rate note-offs inside this block
    for (const o of this.audioNoteOffs) {
      if (o.frame < this.frame + n) {
        const at = clamp(Math.round(o.frame - this.frame), 0, n);
        if (at > cursor) renderSegment(at);
        this.tracks[o.track]?.noteOff(o.note);
      }
    }
    this.audioNoteOffs = this.audioNoteOffs.filter((o) => o.frame >= this.frame + n);
    // sequencer note-offs (from previous blocks)
    for (const o of offs) {
      if (o.offset > cursor) renderSegment(o.offset);
      this.tracks[o.track]?.noteOff(o.note);
    }
    renderSegment(n);

    // metronome click: short sine blip, audible but never in the recorded export path
    if (this.clickEnabled) {
      for (let i = 0; i < n; i++) {
        if (this.clickEnv > 0.0001) {
          const freq = this.clickAccent ? 1600 : 1000;
          this.clickPhase += freq / this.sr;
          const env = this.clickEnv * this.clickEnv;
          const v = Math.sin(this.clickPhase * Math.PI * 2) * env * 0.22;
          busL[i] += v;
          busR[i] += v;
          this.clickEnv *= 0.9994;
        }
      }
    }

    // sends (track sendA/sendB already scale how much each track feeds the bus)
    const masterVol = this.masterVol();
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < n; i++) {
      const [sl, sr] = this.sendA.process(sendAL[i], sendAR[i], 1);
      const [rl, rr] = this.sendB.process(sendBL[i], sendBR[i], 1);
      let l = busL[i] + sl + rl;
      let r = busR[i] + sr + rr;
      [l, r] = this.master.process(l, r);
      l *= masterVol;
      r *= masterVol;
      // final safety limiter (soft, no hard clipping clicks)
      l = Math.tanh(l * 1.02);
      r = Math.tanh(r * 1.02);
      outL[i] = l;
      outR[i] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
    }
    for (let t = 0; t < 8; t++) this.meters.tracks[t] = this.tracks[t].meter;
    this.meters.masterL = this.meters.masterL * 0.7 + peakL * 0.3;
    this.meters.masterR = this.meters.masterR * 0.7 + peakR * 0.3;
    if (this.recording) {
      this.recordBufferL.push(new Float32Array(outL.subarray(0, n)));
      this.recordBufferR.push(new Float32Array(outR.subarray(0, n)));
    }
    this.frame += n;
  }

  private startSequencedNote(ev: SeqEvent) {
    const tr = this.tracks[ev.track];
    if (!tr) return;
    tr.noteOn(ev.note, ev.vel, { values: ev.locks });
    if (ev.lengthFrames > 0) {
      this.seq.scheduleNoteOff(ev.track, ev.note, this.frame + ev.lengthFrames);
    }
  }

  private masterVol() {
    const m = this.kit.master;
    const v = m ? m.volume : 0.8;
    return clamp(v, 0, 1) * 0.9;
  }

  /**
   * Offline render of a full performance (used by export and tests).
   * `from` / `to` are pattern indices in the project; if `song` is true the project song /
   * chain order is used, otherwise the current pattern repeats.
   */
  renderOffline(
    seconds: number,
    opts: { pattern?: Pattern; song?: Song | null; sampleRate?: number } = {},
  ): { left: Float32Array; right: Float32Array; sampleRate: number } {
    const sr = opts.sampleRate ?? this.sr;
    const total = Math.round(seconds * sr);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    const block = 256;
    const bl = new Float32Array(block);
    const br = new Float32Array(block);
    if (opts.pattern) this.setPattern(opts.pattern);
    let written = 0;
    while (written < total) {
      const n = Math.min(block, total - written);
      bl.fill(0);
      br.fill(0);
      this.processInto(bl, br, n);
      left.set(n === block ? bl : bl.subarray(0, n), written);
      right.set(n === block ? br : br.subarray(0, n), written);
      written += n;
    }
    return { left, right, sampleRate: sr };
  }
}

/* ---------------------------------------------------------- track helpers --- */

/** Clone a pattern deeply (used for undo/redo snapshots and clipboard). */
export function clonePattern(p: Pattern): Pattern {
  return JSON.parse(JSON.stringify(p)) as Pattern;
}

export function cloneTrackParams(t: TrackParams): TrackParams {
  return JSON.parse(JSON.stringify(t)) as TrackParams;
}

export { SEQ_MAX_STEPS };
