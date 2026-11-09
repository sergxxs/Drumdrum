/**
 * Trig condition & probability evaluation.
 *
 * Conditions are evaluated per track, per step, with a "pass" counter that counts how
 * many times the step has come around (so 1:2 fires on the first of every two passes).
 * Probability conditions use a deterministic-per-step PRNG so that live playback and
 * offline export of the same performance differ only where you'd want them to: we seed
 * from (pattern, bar, step) so renders are reproducible.
 */
import type { TrigCond } from '../state/types';
import { Rng } from '../audio/dsp';

export interface TrigContext {
  /** how many complete passes of the track pattern have happened (0-based) */
  pass: number;
  /** 0-based step index inside this pass */
  stepIndex: number;
  /** total steps in the track pattern */
  length: number;
  fill: boolean;
  /** seeded rng for probability */
  rng: Rng;
}

export function evalCondition(cond: TrigCond, ctx: TrigContext): boolean {
  switch (cond) {
    case 'ALWAYS':
      return true;
    case '1:2': return ctx.pass % 2 === 0;
    case '1:3': return ctx.pass % 3 === 0;
    case '1:4': return ctx.pass % 4 === 0;
    case '2:2': return ctx.pass % 2 === 1;
    case '2:3': return ctx.pass % 3 === 1;
    case '2:4': return ctx.pass % 4 === 1;
    case '3:4': return ctx.pass % 4 === 2;
    case 'P50': return ctx.rng.next() < 0.5;
    case 'P25': return ctx.rng.next() < 0.25;
    case 'FILL': return ctx.fill;
    case 'NOTFILL': return !ctx.fill;
    case 'FIRST': return ctx.pass === 0;
    case 'LAST': return ctx.stepIndex === ctx.length - 1;
    default:
      return true;
  }
}

/** Short label for the LCD. */
export function condLabel(cond: TrigCond): string {
  switch (cond) {
    case 'ALWAYS': return '';
    case 'P50': return '50%';
    case 'P25': return '25%';
    case 'FILL': return 'FIL';
    case 'NOTFILL': return '!FIL';
    case 'FIRST': return '1ST';
    case 'LAST': return 'LST';
    default: return cond; // 1:2 etc.
  }
}
