/**
 * Core data types for HYBRID GROOVEBOX.
 * Everything here is plain JSON-serialisable data: patterns, kits and songs can be
 * stored verbatim in IndexedDB.
 */

export type EngineKind = 'fm' | 'mono' | 'sample';

export const ENGINE_LABELS: Record<EngineKind, string> = {
  fm: 'FM',
  mono: 'MONO',
  sample: 'SMPL',
};

/* ------------------------------------------------------------------ FM ---- */

export interface FMOpParams {
  /** frequency ratio to the note (0.25 .. 16, quantised into a musical table) */
  ratio: number;
  /** output level 0..1 */
  level: number;
  /** self-feedback amount 0..1 */
  feedback: number;
  /** free-running (not key-tracked) */
  fixed: boolean;
  /** coarse detune in semitones of the whole operator (-24..24) */
  detune: number;
  /** attack / decay / sustain / release seconds 0..1 normalised (see dsp.envTime) */
  atk: number;
  dec: number;
  sus: number;
  rel: number;
}

export interface FMParams {
  algorithm: number; // 0..7
  ops: FMOpParams[]; // always 4
  /** global FM index scaling of modulator->carrier depth 0..1 */
  index: number;
  /** harmonic ratio "color" 0..1, shifts all carrier ratios up a harmonic table */
  harmonic: number;
  /** noise injection 0..1 (mixed into operator 4) */
  noise: number;
  /** waveshaper drive 0..1 */
  sat: number;
  /** amp modulation depth op2 -> carrier 0..1 */
  am: number;
  /** pitch envelope amount in semitones -48..48, and decay 0..1 */
  pitchEnv: number;
  pitchEnvDec: number;
  /** global fine tune in cents -100..100 */
  tune: number;
  /** glide time 0..1 */
  glide: number;
}

/* ---------------------------------------------------------------- MONO ---- */

export type MonoEngineId =
  | 'analog'
  | 'wavetable'
  | 'phasedist'
  | 'sid'
  | 'dnoise'
  | 'metallic'
  | 'ringmod'
  | 'digital';

export interface MonoParams {
  engine: MonoEngineId;
  /** engine specific, all 0..1 normalised */
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  /** sub oscillator level 0..1 */
  sub: number;
  /** unison detune / spread 0..1 */
  detune: number;
  /** glides to note pitch over this long (0..1) */
  glide: number;
  /** colour of the noise/ally stage */
  tone: number;
  /** drive */
  drive: number;
  /** fine tune cents */
  tune: number;
}

/* -------------------------------------------------------------- SAMPLE ---- */

export type SampleLoopMode = 'off' | 'forward' | 'pingpong';

export interface SampleParams {
  /** samples in the pool, or null for "empty" */
  sampleId: string | null;
  start: number; // 0..1 into buffer
  end: number; // 0..1 into buffer
  /** loop start/end as fractions of the trimmed region (0..1) */
  loopStart: number;
  loopEnd: number;
  loopMode: SampleLoopMode;
  reverse: boolean;
  /** playback rate multiplier in semitones -24..24 */
  pitch: number;
  /** independent rate multiplier (tape speed) 0.25..4 */
  rate: number;
  /** granular time stretch factor 0.5..2 (1 = off) */
  stretch: number;
  /** slice count (1 = no slicing); slices map notes across the keyboard */
  slices: number;
  sliceSensitivity: number;
  /** choke group 0 = none, 1..4 */
  choke: number;
  /** amp env */
  atk: number;
  dec: number;
  sus: number;
  rel: number;
  /** 0=gain,1=crush,2=fold,3=saturate */
  shaper: number;
  shaperAmt: number;
  tune: number;
}

/* --------------------------------------------------------- SHARED PER TRK -- */

export type FilterType = 'LP12' | 'LP24' | 'HP12' | 'BP12' | 'NOTCH';
export const FILTER_TYPES: FilterType[] = ['LP12', 'LP24', 'HP12', 'BP12', 'NOTCH'];

export interface FilterParams {
  type: FilterType;
  cutoff: number; // 0..1 -> 30 Hz .. 18 kHz exponential
  reso: number; // 0..1
  drive: number; // 0..1
  keytrack: number; // 0..1
  env: number; // -1..1 filter env amount
  envAtk: number;
  envDec: number;
}

export interface AmpParams {
  atk: number;
  dec: number;
  sus: number;
  rel: number;
  /** velocity -> amplitude */
  vel: number;
  /** level 0..1 */
  level: number;
}

export type LfoShape = 'SINE' | 'TRI' | 'SAW' | 'SQR' | 'S&H' | 'RAMP';
export const LFO_SHAPES: LfoShape[] = ['SINE', 'TRI', 'SAW', 'SQR', 'S&H', 'RAMP'];
export type LfoDest = 'TUNE' | 'CUTOFF' | 'AMP' | 'PAN' | 'INDEX' | 'DECAY';
export const LFO_DESTS: LfoDest[] = ['TUNE', 'CUTOFF', 'AMP', 'PAN', 'INDEX', 'DECAY'];

export interface LfoParams {
  shape: LfoShape;
  /** rate 0..1 -> 0.02 .. 40 Hz (or tempo synced mult when sync) */
  speed: number;
  depth: number;
  dest: LfoDest;
  sync: boolean;
  /** retrigger per voice */
  retrig: boolean;
  /** fade in 0..1 */
  fade: number;
}

export interface TrackFxParams {
  reverb: number;
  delay: number;
  distortion: number;
  mod: number;
}

export interface TrackParams {
  engine: EngineKind;
  fm: FMParams;
  mono: MonoParams;
  sample: SampleParams;
  filter: FilterParams;
  amp: AmpParams;
  lfo: LfoParams;
  fx: TrackFxParams;
  /** 0..1 */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** choke handling across tracks handled inside track */
  sendA: number;
  sendB: number;
}

/* ------------------------------------------------------------- PATTERNS ---- */

export type TrigCond =
  | 'ALWAYS'
  | '1:2' | '1:3' | '1:4'
  | '2:2' | '2:3' | '2:4'
  | '3:4'
  | 'P50' | 'P25'
  | 'FILL' | 'NOTFILL'
  | 'FIRST' | 'LAST';

export const TRIG_CONDS: TrigCond[] = [
  'ALWAYS', '1:2', '1:3', '1:4', '2:2', '2:3', '2:4', '3:4',
  'P50', 'P25', 'FILL', 'NOTFILL', 'FIRST', 'LAST',
];

export type ParamKey = string; // e.g. 'fm.index', 'filter.cutoff'

export interface Step {
  /** step is an active trig */
  on: boolean;
  /** note number 0..127 */
  note: number;
  /** 0..1 */
  vel: number;
  /** length in steps (>=1) */
  len: number;
  /** micro timing in steps, -0.5 .. 0.5 */
  micro: number;
  cond: TrigCond;
  /** parameter locks: param path -> normalised 0..1 value */
  locks: Record<ParamKey, number>;
}

export interface TrackPattern {
  steps: Step[];
  /** 1,2,3,4 -> 1x,1/2,1/3,1/4 relative track speed */
  speed: 1 | 2 | 3 | 4;
  /** automation lanes: param path -> 64 slots (null = no motion value) */
  automation: Record<ParamKey, (number | null)[]>;
  /** last step count used for this track */
  length: number;
  muted: boolean;
}

export interface Pattern {
  name: string;
  /** 16..64 */
  length: number;
  tempo: number;
  swing: number;
  tracks: TrackPattern[];
}

export interface KitTrack {
  name: string;
  params: TrackParams;
}

export interface Kit {
  name: string;
  tracks: KitTrack[];
  sends: SendParams;
  master: MasterParams;
}

export interface MasterFxChainEntry {
  type: string;
  on: boolean;
  mix: number;
  p1: number;
  p2: number;
  p3: number;
}

export interface SendParams {
  /** delay */
  delayTime: number;
  delayFeedback: number;
  delayTone: number;
  delayPingPong: boolean;
  /** reverb */
  revSize: number;
  revDamp: number;
  revPre: number;
  /** how much each track feeds A/B is on TrackParams.sendA/sendB */
}

export interface MasterParams {
  volume: number;
  drive: number;
  /** eq + compressor + width */
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  width: number;
  compOn: boolean;
  compThresh: number;
  compRatio: number;
  /** modular insert chain (dist, crush, chorus, phaser, flanger, ringmod) */
  chain: MasterFxChainEntry[];
}

export interface SongStep {
  pattern: number;
  repeats: number;
}

export interface Song {
  name: string;
  steps: SongStep[];
}

export interface SampleMeta {
  id: string;
  name: string;
  /** length in frames */
  frames: number;
  sampleRate: number;
  channels: 1 | 2;
  /** normalised peak points for the UI (0..1 of the buffer) */
  transients: number[];
  /** peak envelope for drawing, 0..1, N buckets */
  peaks: number[];
  createdAt: number;
}

export interface Project {
  version: number;
  name: string;
  patterns: Pattern[];
  kits: Kit[];
  songs: Song[];
  currentPattern: number;
  currentKit: number;
  currentSong: number;
  /** track index 0..7 */
  currentTrack: number;
  /** patterns in a chain, indices */
  chain: number[];
  chainLoop: boolean;
  master: MasterParams;
  samples: SampleMeta[];
  settings: Settings;
  savedAt: number;
}

export interface Settings {
  /** 0..1 -> headroom */
  masterVol: number;
  /** show grid velocity vs on/off */
  showVelocity: boolean;
  /** LCD contrast 0..1 */
  contrast: number;
  /** metronome */
  click: boolean;
  /** rec quantise in steps (0 = off) */
  recQuant: number;
  /** MIDI channel */
  midiCh: number;
  /** auto-save on */
  autosave: boolean;
  /** screen scale hint for tiny phones */
  scale: number;
}
