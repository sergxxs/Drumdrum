/**
 * Parameter dictionary.
 *
 * Every synthesis parameter is declared here ONCE. The same declaration drives:
 *   • encoder edit resolution (normalised 0..1 <-> real value, with curves)
 *   • LCD page layout (which encoder controls which parameter)
 *   • parameter locks and motion automation (always stored normalised)
 *   • value formatting on the LCD
 *
 * Param keys are dotted paths into TrackParams, e.g. "fm.ops.2.level".
 */
import type { EngineKind, TrackParams } from './types';

export type PageId = 'sound' | 'filter' | 'amp' | 'lfo' | 'fx' | 'mod' | 'sample';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  /** display/quantise */
  integer?: boolean;
  /** exponential mapping (min must be > 0) */
  exp?: boolean;
  /** centre-zero display */
  bipolar?: boolean;
  /** discrete choices -> value is the index */
  choices?: readonly string[];
  unit?: string;
  /** custom formatter */
  fmt?: (v: number) => string;
  /** non-lockable (structural) */
  structural?: boolean;
  /** value is an envelope time (normalised) -> display in ms/s */
  time?: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Envelope time in ms/s (mirrors dsp.envTime). */
export function fmtTime(n: number): string {
  const t = Math.max(0.0005, 0.0005 * Math.pow(20000, Math.min(1, Math.max(0, n))));
  if (t < 0.01) return `${(t * 1000).toFixed(1)}ms`;
  if (t < 1) return `${Math.round(t * 1000)}ms`;
  return `${t.toFixed(2)}s`;
}
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

function def(
  key: string,
  label: string,
  min: number,
  max: number,
  extra: Partial<ParamDef> = {},
): ParamDef {
  return { key, label, min, max, ...extra };
}

/* ------------------------------------------------------------- FM table ---- */
/** Musical ratio table used by FM operators (0..31 index). */
export const FM_RATIOS = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6,
  6.5, 7, 7.5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 28, 32,
];

const fmDefs: ParamDef[] = [
  def('fm.algorithm', 'ALGO', 0, 7, {
    integer: true, choices: ['1', '2', '3', '4', '5', '6', '7', '8'],
  }),
  def('fm.index', 'INDEX', 0, 1, { fmt: pct }),
  def('fm.harmonic', 'HARM', 0, 1, { fmt: pct }),
  def('fm.noise', 'NOISE', 0, 1, { fmt: pct }),
  def('fm.sat', 'SAT', 0, 1, { fmt: pct }),
  def('fm.am', 'AM', 0, 1, { fmt: pct }),
  def('fm.pitchEnv', 'P.ENV', -48, 48, { bipolar: true, unit: 'st' }),
  def('fm.pitchEnvDec', 'P.DEC', 0, 1, { time: true }),
  def('fm.tune', 'FINE', -100, 100, { bipolar: true, unit: 'ct' }),
  def('fm.glide', 'GLIDE', 0, 1, { time: true }),
];

for (let i = 0; i < 4; i++) {
  fmDefs.push(
    def(`fm.ops.${i}.ratio`, `OP${i + 1} R`, 0, FM_RATIOS.length - 1, {
      integer: true,
      fmt: (v) => `${FM_RATIOS[Math.round(v)] ?? 1}x`,
    }),
    def(`fm.ops.${i}.level`, `OP${i + 1} L`, 0, 1, { fmt: pct }),
    def(`fm.ops.${i}.feedback`, `OP${i + 1} FB`, 0, 1, { fmt: pct }),
    def(`fm.ops.${i}.detune`, `OP${i + 1} DT`, -24, 24, { bipolar: true, unit: 'st' }),
    def(`fm.ops.${i}.fixed`, `OP${i + 1} FX`, 0, 1, { integer: true, choices: ['KEY', 'FIX'] }),
    def(`fm.ops.${i}.atk`, `OP${i + 1} A`, 0, 1, { time: true }),
    def(`fm.ops.${i}.dec`, `OP${i + 1} D`, 0, 1, { time: true }),
    def(`fm.ops.${i}.sus`, `OP${i + 1} S`, 0, 1, { fmt: pct }),
    def(`fm.ops.${i}.rel`, `OP${i + 1} R`, 0, 1, { time: true }),
  );
}

/* ----------------------------------------------------------- MONO table ---- */
const monoDefs: ParamDef[] = [
  def('mono.engine', 'ENGINE', 0, 7, {
    integer: true,
    choices: ['ANALOG', 'WAVTBL', 'P.DIST', 'SID', 'DNOISE', 'METAL', 'RINGMD', 'DIGITAL'],
    structural: true,
  }),
  def('mono.p1', 'P1', 0, 1, { fmt: pct }),
  def('mono.p2', 'P2', 0, 1, { fmt: pct }),
  def('mono.p3', 'P3', 0, 1, { fmt: pct }),
  def('mono.p4', 'P4', 0, 1, { fmt: pct }),
  def('mono.sub', 'SUB', 0, 1, { fmt: pct }),
  def('mono.detune', 'DETUNE', 0, 1, { fmt: pct }),
  def('mono.glide', 'GLIDE', 0, 1, { fmt: pct }),
  def('mono.tone', 'TONE', 0, 1, { fmt: pct }),
  def('mono.drive', 'DRIVE', 0, 1, { fmt: pct }),
  def('mono.tune', 'FINE', -100, 100, { bipolar: true, unit: 'ct' }),
];

/* --------------------------------------------------------- SAMPLE table ---- */
const sampleDefs: ParamDef[] = [
  def('sample.start', 'START', 0, 1, { fmt: pct, structural: true }),
  def('sample.end', 'END', 0, 1, { fmt: pct, structural: true }),
  def('sample.loopStart', 'L.START', 0, 1, { fmt: pct, structural: true }),
  def('sample.loopEnd', 'L.END', 0, 1, { fmt: pct, structural: true }),
  def('sample.loopMode', 'LOOP', 0, 2, {
    integer: true, choices: ['OFF', 'FWD', 'PING'], structural: true,
  }),
  def('sample.reverse', 'REV', 0, 1, { integer: true, choices: ['OFF', 'ON'], structural: true }),
  def('sample.pitch', 'PITCH', -24, 24, { bipolar: true, unit: 'st', integer: true }),
  def('sample.rate', 'RATE', 0.25, 4, { exp: true, fmt: (v) => `${v.toFixed(2)}x` }),
  def('sample.stretch', 'STRETCH', 0.5, 2, { exp: true, fmt: (v) => `${v.toFixed(2)}x` }),
  def('sample.slices', 'SLICES', 1, 16, { integer: true, structural: true }),
  def('sample.sliceSensitivity', 'SL.SENS', 0, 1, { fmt: pct, structural: true }),
  def('sample.choke', 'CHOKE', 0, 4, { integer: true, choices: ['-', '1', '2', '3', '4'], structural: true }),
  def('sample.atk', 'ATK', 0, 1, { time: true }),
  def('sample.dec', 'DEC', 0, 1, { time: true }),
  def('sample.sus', 'SUS', 0, 1, { fmt: pct }),
  def('sample.rel', 'REL', 0, 1, { time: true }),
  def('sample.shaper', 'SHAPE', 0, 3, {
    integer: true, choices: ['GAIN', 'CRUSH', 'FOLD', 'DRIVE'],
  }),
  def('sample.shaperAmt', 'SH.AMT', 0, 1, { fmt: pct }),
  def('sample.tune', 'FINE', -100, 100, { bipolar: true, unit: 'ct' }),
];

/* --------------------------------------------------------- shared tables --- */
const sharedDefs: ParamDef[] = [
  def('filter.type', 'TYPE', 0, 4, {
    integer: true, choices: ['LP12', 'LP24', 'HP12', 'BP12', 'NOTCH'], structural: true,
  }),
  def('filter.cutoff', 'CUTOFF', 30, 18000, { exp: true, fmt: (v) => `${hz(v)}Hz` }),
  def('filter.reso', 'RESO', 0, 1, { fmt: pct }),
  def('filter.drive', 'DRIVE', 0, 1, { fmt: pct }),
  def('filter.keytrack', 'KEYTRK', 0, 1, { fmt: pct }),
  def('filter.env', 'F.ENV', -1, 1, { bipolar: true, fmt: (v) => `${Math.round(v * 100)}` }),
  def('filter.envAtk', 'F.ATK', 0, 1, { time: true }),
  def('filter.envDec', 'F.DEC', 0, 1, { time: true }),

  def('amp.atk', 'ATK', 0, 1, { time: true }),
  def('amp.dec', 'DEC', 0, 1, { time: true }),
  def('amp.sus', 'SUS', 0, 1, { fmt: pct }),
  def('amp.rel', 'REL', 0, 1, { time: true }),
  def('amp.vel', 'VELO', 0, 1, { fmt: pct }),
  def('amp.level', 'LEVEL', 0, 1, { fmt: pct }),

  def('lfo.shape', 'SHAPE', 0, 5, {
    integer: true, choices: ['SINE', 'TRI', 'SAW', 'SQR', 'S&H', 'RAMP'], structural: true,
  }),
  def('lfo.speed', 'SPEED', 0.02, 40, { exp: true, fmt: (v) => `${v.toFixed(2)}Hz` }),
  def('lfo.depth', 'DEPTH', 0, 1, { fmt: pct }),
  def('lfo.dest', 'DEST', 0, 5, {
    integer: true,
    choices: ['TUNE', 'CUTOFF', 'AMP', 'PAN', 'INDEX', 'DECAY'],
    structural: true,
  }),
  def('lfo.sync', 'SYNC', 0, 1, { integer: true, choices: ['FREE', 'SYNC'], structural: true }),
  def('lfo.retrig', 'RETRIG', 0, 1, { integer: true, choices: ['OFF', 'ON'], structural: true }),
  def('lfo.fade', 'FADE', 0, 1, { time: true }),

  def('fx.reverb', 'REV', 0, 1, { fmt: pct }),
  def('fx.delay', 'DLY', 0, 1, { fmt: pct }),
  def('fx.distortion', 'DST', 0, 1, { fmt: pct }),
  def('fx.mod', 'MOD', 0, 1, { fmt: pct }),

  def('volume', 'VOLUME', 0, 1, { fmt: pct }),
  def('pan', 'PAN', -1, 1, {
    bipolar: true,
    fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
  }),
  def('sendA', 'FX SEND', 0, 1, { fmt: pct }),
  def('sendB', 'SEND B', 0, 1, { fmt: pct }),
];

export const PARAM_DEFS: Record<string, ParamDef> = {};
for (const d of [...fmDefs, ...monoDefs, ...sampleDefs, ...sharedDefs]) PARAM_DEFS[d.key] = d;

/* --------------------------------------------------------------- pages ---- */

export interface PageDef {
  id: PageId;
  title: string;
  /** 4 encoders A..D */
  knobs: string[];
}

/** SOUND page per engine, plus MOD. */
export const ENGINE_PAGES: Record<EngineKind, { sound: string[]; mod: string[] }> = {
  fm: {
    sound: ['fm.index', 'fm.harmonic', 'fm.ops.0.ratio', 'fm.noise'],
    mod: ['fm.pitchEnv', 'fm.pitchEnvDec', 'fm.am', 'fm.sat'],
  },
  mono: {
    sound: ['mono.p1', 'mono.p2', 'mono.p3', 'mono.p4'],
    mod: ['mono.sub', 'mono.detune', 'mono.glide', 'mono.tone'],
  },
  sample: {
    sound: ['sample.pitch', 'sample.dec', 'sample.rate', 'sample.stretch'],
    mod: ['sample.shaper', 'sample.shaperAmt', 'sample.choke', 'sample.tune'],
  },
};

export const PAGE_KNOBS: Record<Exclude<PageId, 'sound' | 'mod' | 'sample'>, string[]> = {
  filter: ['filter.cutoff', 'filter.reso', 'filter.drive', 'filter.type'],
  amp: ['amp.atk', 'amp.dec', 'amp.sus', 'amp.rel'],
  lfo: ['lfo.speed', 'lfo.depth', 'lfo.shape', 'lfo.dest'],
  fx: ['fx.reverb', 'fx.delay', 'fx.distortion', 'fx.mod'],
};

export const SAMPLE_PAGE_KNOBS = ['sample.start', 'sample.end', 'sample.loopMode', 'sample.slices'];

/* ------------------------------------------------------------ accessors ---- */

type AnyObj = Record<string, any>;

export function getRaw(obj: AnyObj, key: string): any {
  const parts = key.split('.');
  let cur: any = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

export function setRaw(obj: AnyObj, key: string, value: any): void {
  const parts = key.split('.');
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Choice parameters (filter type, LFO shape/destination, play modes...) are stored as
 * *strings* in the model — that is what the DSP switches on. The normalised form is the
 * index in `choices`. Everything else is a plain number.
 */
function choiceIndex(key: string, value: any): number | null {
  const d = PARAM_DEFS[key];
  if (!d?.choices) return null;
  if (typeof value === 'number') return Math.round(value);
  const i = d.choices.indexOf(String(value).toUpperCase());
  return i < 0 ? 0 : i;
}

/** The value a parameter actually stores for a given normalised position. */
export function normToStored(key: string, n: number): any {
  const d = PARAM_DEFS[key];
  if (d?.choices) {
    const i = Math.min(d.choices.length - 1, Math.max(0, Math.round(n * (d.choices.length - 1))));
    return d.choices[i];
  }
  return normToValue(key, n);
}

/** real value -> 0..1 */
export function valueToNorm(key: string, value: any): number {
  const d = PARAM_DEFS[key];
  if (!d) return Number(value) || 0;
  if (d.choices) {
    const i = choiceIndex(key, value) ?? 0;
    return d.choices.length > 1 ? i / (d.choices.length - 1) : 0;
  }
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  let n: number;
  if (d.exp) {
    n = Math.log(Math.max(v, d.min) / d.min) / Math.log(d.max / d.min);
  } else {
    n = (v - d.min) / (d.max - d.min);
  }
  return Math.min(1, Math.max(0, n));
}

/** 0..1 -> numeric value (choices return their index) */
export function normToValue(key: string, n: number): number {
  const d = PARAM_DEFS[key];
  if (!d) return n;
  n = Math.min(1, Math.max(0, n));
  let v: number;
  if (d.exp) v = d.min * Math.pow(d.max / d.min, n);
  else v = d.min + (d.max - d.min) * n;
  if (d.integer) v = Math.round(v);
  return v;
}

export function getNorm(params: AnyObj, key: string): number {
  return valueToNorm(key, getRaw(params, key));
}

export function setNorm(params: AnyObj, key: string, n: number): void {
  setRaw(params, key, normToStored(key, n));
}

export function formatValue(key: string, norm: number): string {
  const d = PARAM_DEFS[key];
  if (!d) return norm.toFixed(2);
  // Choice parameters are stored as strings, so read the label straight from the table.
  if (d.choices) return String(normToStored(key, norm));
  const v = normToValue(key, norm);
  if (d.time) return fmtTime(v);
  if (d.fmt) return d.fmt(v);
  if (d.bipolar) {
    return `${v >= 0 ? '+' : ''}${d.integer ? v : v.toFixed(2)}${d.unit ? ` ${d.unit}` : ''}`;
  }
  const num = d.integer ? Math.round(v) : v >= 100 ? v.toFixed(0) : v.toFixed(2);
  return `${num}${d.unit ? ` ${d.unit}` : ''}`;
}

export function paramLabel(key: string): string {
  return PARAM_DEFS[key]?.label ?? key.split('.').pop()!.toUpperCase();
}

/** Is this parameter lockable on the sequencer? */
export function isLockable(key: string): boolean {
  return !!PARAM_DEFS[key] && !PARAM_DEFS[key].structural;
}

/** All knob keys for a page of a given track. */
export function pageKnobs(page: PageId, engine: EngineKind): string[] {
  if (page === 'sound') return ENGINE_PAGES[engine].sound;
  if (page === 'mod') return ENGINE_PAGES[engine].mod;
  if (page === 'sample') return SAMPLE_PAGE_KNOBS;
  return PAGE_KNOBS[page];
}

export const PAGE_ORDER: PageId[] = ['sound', 'filter', 'amp', 'lfo', 'fx', 'mod', 'sample'];

export function pageTitle(page: PageId): string {
  switch (page) {
    case 'sound': return 'SOUND';
    case 'filter': return 'FILTER';
    case 'amp': return 'AMP';
    case 'lfo': return 'LFO';
    case 'fx': return 'FX';
    case 'mod': return 'MOD';
    case 'sample': return 'SAMPLE';
  }
}
