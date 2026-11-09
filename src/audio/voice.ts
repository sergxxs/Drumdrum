/**
 * Shared voice contract. Every engine (FM / mono / sample) implements `Voice`, so the
 * track can treat them identically for choke groups, voice stealing and UI metering.
 */
export interface ModInputs {
  /** pitch multiplier for LFO->TUNE (1 = no change) */
  pitchMul: number;
  /** amplitude multiplier 0..1 for LFO->AMP */
  ampMul: number;
  /** additive offset for engine colour (FM index / mono p1 / wavetable morph) */
  colorOffset: number;
  /** multiplier for decay times (LFO->DECAY) */
  decayMul: number;
  /** pan offset for LFO->PAN (-1..1) */
  panOffset: number;
  /** cutoff offset in Hz for LFO->CUTOFF */
  cutoffMod: number;
}

export const NO_MOD: ModInputs = {
  pitchMul: 1, ampMul: 1, colorOffset: 0, decayMul: 1, panOffset: 0, cutoffMod: 0,
};

export interface Voice {
  active: boolean;
  note: number;
  released: boolean;
  /** instantaneous output amplitude 0..1 for pad LEDs / meters */
  ampValue: number;
  noteOff(): void;
  kill(): void;
  /**
   * Add `n` mono samples into `out[offset..offset+n]`.
   * `p` is the effective track parameter object (locks/automation already merged).
   */
  render(out: Float32Array, offset: number, n: number, p: TrackParams, mod: ModInputs): void;
}

import type { TrackParams } from '../state/types';
