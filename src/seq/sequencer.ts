/**
 * SequencerEngine — sample-accurate step clock.
 *
 * The transport is driven by an absolute frame counter (never by setTimeout or by the
 * UI's animation frame). `advance()` is called by the audio host for every block and
 * returns the trigger events that fall inside it, *with their sample offset*, so the
 * caller can split the block and start notes on the exact sample.
 *
 * Each track has its own step index and speed, which is what makes per-track downbeats
 * and polyrhythms (64/3, 64/5 …) possible.
 */
import { SR, clamp } from '../audio/dsp';
import { evalCondition } from './trig';
import { Rng } from '../audio/dsp';
import type { Pattern, Step, TrackPattern } from '../state/types';

export interface SeqEvent {
  /** sample offset inside the block */
  offset: number;
  track: number;
  step: number;
  note: number;
  vel: number;
  /** note length in frames */
  lengthFrames: number;
  /** p-lock values to apply at note-on (normalised) */
  locks: Record<string, number>;
  /** parameters that should be driven by automation for this step */
  motion: Record<string, number>;
}

export interface NoteOffEvent {
  offset: number;
  track: number;
  note: number;
}

const MAX_STEPS = 64;

export class SequencerEngine {
  private sr: number;
  playing = false;
  /** absolute frame at which the transport started */
  startFrame = 0;
  tempo = 120;
  swing = 0;
  fill = false;
  /** per track playback state */
  private stepIndex = new Int32Array(8);
  private nextFrame = new Float64Array(8);
  private pass = new Int32Array(8);
  private rng = new Rng(0xbeef01);
  /** current pattern (owned by the store, read-only here) */
  pattern: Pattern;
  /** set by the engine when a pattern/full-loop boundary happens */
  onPatternEnd: (() => void) | null = null;
  /** metronome click callback */
  onClick: ((offset: number, accent: boolean) => void) | null = null;
  clickEnabled = false;
  private pendingOffs: NoteOffEvent[] = [];
  /** last emitted step per track for UI playhead */
  lastStep = new Int32Array(8);
  private lastPatternEndFrame = 0;

  constructor(pattern: Pattern, sr = SR) {
    this.pattern = pattern;
    this.sr = sr;
    this.resetPositions(0);
  }

  setPattern(p: Pattern) {
    const sameLength = this.pattern === p;
    this.pattern = p;
    if (!sameLength) this.clampIndices();
  }

  private clampIndices() {
    for (let t = 0; t < 8; t++) {
      const len = this.trackLength(t);
      if (this.stepIndex[t] >= len) {
        this.stepIndex[t] = 0;
        this.pass[t]++;
      }
    }
  }

  private trackPattern(t: number): TrackPattern {
    return this.pattern.tracks[t];
  }

  trackLength(t: number): number {
    const tp = this.trackPattern(t);
    const len = tp?.length && tp.length > 0 ? tp.length : this.pattern.length;
    return clamp(len, 1, MAX_STEPS);
  }

  /** Base 16th-note duration in frames at the current tempo. */
  private baseStepFrames(): number {
    return (this.sr * 60) / (this.tempo * 4);
  }

  /** Frames per step for a track, including its speed divider. */
  stepFrames(t: number): number {
    const speed = this.trackPattern(t)?.speed ?? 1;
    // Elektron convention: 1 = 1x, 2 = 1/2 speed, 3 = 1/3, 4 = 1/4
    return this.baseStepFrames() * (speed / 1);
  }

  private swingOffset(t: number): number {
    const idx = this.stepIndex[t];
    if (this.swing <= 0 || idx % 2 === 0) return 0;
    const swingAmount = clamp(this.swing, 0, 0.75);
    return this.stepFrames(t) * swingAmount * 0.5;
  }

  resetPositions(frame: number) {
    for (let t = 0; t < 8; t++) {
      this.stepIndex[t] = 0;
      this.pass[t] = 0;
      this.nextFrame[t] = frame;
      this.lastStep[t] = -1;
    }
    this.pendingOffs.length = 0;
    this.lastPatternEndFrame = frame;
  }

  start(frame: number) {
    this.playing = true;
    this.startFrame = frame;
    this.resetPositions(frame);
  }

  stop() {
    this.playing = false;
    this.pendingOffs.length = 0;
    for (let t = 0; t < 8; t++) this.lastStep[t] = -1;
  }

  /** Continue from the current position (after a pause). */
  resume(frame: number) {
    if (this.playing) return;
    this.playing = true;
    for (let t = 0; t < 8; t++) {
      if (this.nextFrame[t] < frame) this.nextFrame[t] = frame;
    }
  }

  /** Jump all tracks to a given step. */
  setStep(step: number, frame: number) {
    for (let t = 0; t < 8; t++) {
      const len = this.trackLength(t);
      this.stepIndex[t] = step % len;
      this.nextFrame[t] = frame;
    }
  }

  /** Build the lock snapshot for a step: static p-locks override automation lanes. */
  locksFor(t: number, stepInTrack: number, step: Step): Record<string, number> {
    const out: Record<string, number> = {};
    const tp = this.trackPattern(t);
    const automation = tp?.automation;
    if (automation) {
      for (const key in automation) {
        const lane = automation[key];
        if (!lane) continue;
        const v = lane[stepInTrack % MAX_STEPS];
        if (v != null) out[key] = v;
      }
    }
    if (step.locks) {
      for (const k in step.locks) out[k] = step.locks[k];
    }
    return out;
  }

  /**
   * Advance the transport over `n` frames starting at `blockStart` (absolute frame).
   * Returns events sorted by offset, plus due note-offs.
   */
  advance(blockStart: number, n: number): { events: SeqEvent[]; offs: NoteOffEvent[] } {
    const events: SeqEvent[] = [];
    const offs: NoteOffEvent[] = [];
    if (!this.playing) {
      // still flush note-offs scheduled before the transport stopped
      return { events, offs };
    }
    const blockEnd = blockStart + n;
    // Guard against pathological tempo/length combos (e.g. a stale nextFrame far behind).
    for (let t = 0; t < 8; t++) {
      if (this.nextFrame[t] < blockStart - this.stepFrames(t) * 4) {
        this.nextFrame[t] = blockStart;
      }
    }
    let guard = 0;
    for (;;) {
      // find the next due step across tracks
      let bestTrack = -1;
      let bestFrame = Infinity;
      for (let t = 0; t < 8; t++) {
        if (this.nextFrame[t] < bestFrame) {
          bestFrame = this.nextFrame[t];
          bestTrack = t;
        }
      }
      if (bestTrack < 0 || bestFrame >= blockEnd || guard++ > 512) break;
      const t = bestTrack;
      const tp = this.trackPattern(t);
      if (!tp) {
        this.nextFrame[t] = blockEnd;
        continue;
      }
      const len = this.trackLength(t);
      const idx = this.stepIndex[t];
      const step = tp.steps[idx];
      const frame = bestFrame + this.swingOffset(t);
      const offset = Math.max(0, Math.round(frame - blockStart));
      this.lastStep[t] = idx;
      if (step && step.on && !tp.muted) {
        const fired = evalCondition(step.cond, {
          pass: this.pass[t],
          stepIndex: idx,
          length: len,
          fill: this.fill,
          rng: this.rng,
        });
        if (fired) {
          const locks = this.locksFor(t, idx, step);
          const stepDur = this.stepFrames(t);
          events.push({
            offset,
            track: t,
            step: idx,
            note: step.note,
            vel: step.vel,
            lengthFrames: Math.max(1, Math.round(step.len * stepDur)),
            locks,
            motion: {},
          });
        }
      }
      // click on every downbeat of track 0 (or any track's trigger) for the metronome
      if (this.clickEnabled && t === 0 && this.onClick) {
        this.onClick(offset, idx % 4 === 0);
      }
      // advance this track
      const swing = this.swingOffset(t);
      this.nextFrame[t] = bestFrame + this.stepFrames(t);
      this.stepIndex[t] = idx + 1;
      if (this.stepIndex[t] >= len) {
        this.stepIndex[t] = 0;
        this.pass[t]++;
        // pattern loop detection uses track 0 only
        if (t === 0) {
          this.onPatternEnd?.();
        }
      }
      void swing;
    }
    // note-offs
    for (let i = this.pendingOffs.length - 1; i >= 0; i--) {
      const o = this.pendingOffs[i];
      if (o.offset < blockStart + n) {
        offs.push({ offset: Math.max(0, Math.round(o.offset - blockStart)), track: o.track, note: o.note });
        this.pendingOffs.splice(i, 1);
      }
    }
    events.sort((a, b) => a.offset - b.offset || a.track - b.track);
    offs.sort((a, b) => a.offset - b.offset);
    return { events, offs };
  }

  scheduleNoteOff(track: number, note: number, atFrame: number) {
    this.pendingOffs.push({ offset: atFrame, track, note });
    if (this.pendingOffs.length > 256) this.pendingOffs.splice(0, 64);
  }

  /** UI playhead: normalised position of track 0 within the pattern. */
  playhead(frame: number): number {
    const len = this.trackLength(0);
    const s = this.stepIndex[0] % len;
    const frac = this.playing
      ? clamp((frame - (this.nextFrame[0] - this.stepFrames(0))) / this.stepFrames(0))
      : 0;
    return clamp((s + frac) / len);
  }

  currentStep(t: number): number {
    return this.stepIndex[t] % this.trackLength(t);
  }

  isPlaying() {
    return this.playing;
  }

  /** Fill switch (used by trig conditions FILL / NOTFILL). */
  setFill(on: boolean) {
    this.fill = on;
  }
}

export const SEQ_MAX_STEPS = MAX_STEPS;
