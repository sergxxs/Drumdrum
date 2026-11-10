/**
 * Factory content: default project, kits, patterns, FM presets and mono engine presets.
 * All parameter values are *real* values (Hz, seconds-as-normalised) and every preset is
 * a complete sound — no placeholder patches.
 */
import { FM_RATIOS } from './params';
import { envNorm } from '../audio/dsp';
import type {
  FMParams, Kit, KitTrack, MonoParams, MasterParams, Pattern, Project, SampleParams,
  Settings, TrackParams, Song,
} from './types';

const ratioNorm = (r: number): number => {
  const idx = FM_RATIOS.indexOf(r);
  const i = idx < 0 ? 3 : idx;
  return i / (FM_RATIOS.length - 1);
};

export function defaultFMParams(): FMParams {
  return {
    algorithm: 0,
    // operator 1 is a carrier at full level so a fresh FM track always makes sound;
    // operators 2-4 start silent and are dialled in on the SOUND page.
    ops: [0, 1, 2, 3].map((i) => ({
      ratio: ratioNorm(i === 0 ? 1 : 2), level: i === 0 ? 1 : 0, feedback: 0, fixed: false,
      detune: 0, atk: 0.05, dec: 0.5, sus: 0.7, rel: 0.3,
    })),
    index: 0.35, harmonic: 0, noise: 0, sat: 0, am: 0, pitchEnv: 0, pitchEnvDec: 0.4,
    tune: 0, glide: 0,
  };
}

export function defaultMonoParams(): MonoParams {
  return {
    engine: 'analog', p1: 0.4, p2: 0.3, p3: 0.5, p4: 0.2,
    sub: 0.3, detune: 0.2, glide: 0, tone: 0.6, drive: 0.1, tune: 0,
  };
}

export function defaultSampleParams(): SampleParams {
  return {
    sampleId: null, start: 0, end: 1, loopStart: 0, loopEnd: 1, loopMode: 'off',
    reverse: false, pitch: 0, rate: 1, stretch: 1, slices: 1, sliceSensitivity: 0.5,
    choke: 0, atk: 0.02, dec: 0.6, sus: 0.7, rel: 0.25, shaper: 0, shaperAmt: 0, tune: 0,
  };
}

export function defaultTrackParams(engine: TrackParams['engine'] = 'fm'): TrackParams {
  return {
    engine,
    fm: defaultFMParams(),
    mono: defaultMonoParams(),
    sample: defaultSampleParams(),
    filter: {
      type: 'LP12', cutoff: 12000, reso: 0.1, drive: 0, keytrack: 0.3,
      env: 0, envAtk: 0.1, envDec: 0.4,
    },
    amp: { atk: 0.004, dec: 0.45, sus: 0.7, rel: 0.35, vel: 0.7, level: 0.8 },
    lfo: { shape: 'SINE', speed: 0.42, depth: 0, dest: 'CUTOFF', sync: false, retrig: false, fade: 0.2 },
    fx: { reverb: 0.1, delay: 0.1, distortion: 0, mod: 0 },
    volume: 0.8, pan: 0, mute: false, solo: false, sendA: 0.15, sendB: 0.15,
  };
}

export function defaultMasterParams(): MasterParams {
  return {
    volume: 0.8, drive: 0, eqLow: 0, eqMid: 0, eqHigh: 0, width: 1,
    compOn: true, compThresh: 0.75, compRatio: 3,
    chain: [
      { type: 'DIST', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
      { type: 'CRUSH', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
      { type: 'MOD', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
      { type: 'RING', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
    ],
  };
}

export function defaultSettings(): Settings {
  return {
    masterVol: 0.8, showVelocity: true, contrast: 0.6, click: false, recQuant: 0,
    midiCh: 1, autosave: true, scale: 1,
  };
}

/* ------------------------------------------------------------ FM presets --- */

export interface FMPreset {
  name: string;
  params: Partial<FMParams>;
  /** optional amp/filter shaping that belongs to the sound */
  amp?: Partial<TrackParams['amp']>;
  filter?: Partial<TrackParams['filter']>;
}

/**
 * Operator envelope helper. `dec` / `rel` are given in **seconds** for readability and
 * converted to the engine's normalised parameter space.
 */
const op = (
  ratio: number, level: number, decSeconds: number,
  extra: Partial<FMParams['ops'][0]> = {},
) => ({
  ratio: ratioNorm(ratio), level, feedback: 0, fixed: false, detune: 0,
  atk: envNorm(0.002), dec: envNorm(decSeconds), sus: 0, rel: envNorm(0.25), ...extra,
});

export const FM_PRESETS: FMPreset[] = [
  {
    name: 'KICK',
    params: {
      // 2xPAIR: op1 is the 0.5x sub body, op2 a very short click modulator
      algorithm: 2, index: 0.22, harmonic: 0, pitchEnv: 42,
      pitchEnvDec: envNorm(0.055),
      ops: [op(0.5, 1, 0.8, { sus: 0.55 }), op(1, 0.5, 0.06), op(1, 0, 0.1), op(1, 0, 0.1)],
    },
    amp: { atk: envNorm(0.001), dec: envNorm(0.8), sus: 0, rel: envNorm(0.2), vel: 0.25 },
    filter: { type: 'LP12', cutoff: 3200, reso: 0.1, drive: 0.15 },
  },
  {
    name: 'SNARE',
    params: {
      algorithm: 1, index: 0.55, noise: 0.62, pitchEnv: 0,
      ops: [op(2, 0.75, 0.3, { sus: 0.45 }), op(3, 0.6, 0.22, { sus: 0.35 }), op(1.5, 0.3, 0.1), op(7, 0.4, 0.06)],
    },
    amp: { atk: envNorm(0.001), dec: envNorm(0.75), sus: 0, rel: envNorm(0.16), vel: 0.5 },
    filter: { type: 'HP12', cutoff: 380, reso: 0.12 },
  },
  {
    name: 'METALLIC',
    params: {
      algorithm: 6, index: 0.62, harmonic: 0.8, pitchEnv: 0,
      ops: [op(1, 0.9, 0.7, { sus: 0.25 }), op(3.5, 0.55, 0.45), op(5.5, 0.6, 0.3), op(9, 0.7, 0.12)],
    },
    amp: { atk: envNorm(0.001), dec: envNorm(0.9), sus: 0.12, rel: envNorm(0.4), vel: 0.6 },
    filter: { cutoff: 14000, reso: 0.1 },
  },
  {
    name: 'BELL',
    params: {
      algorithm: 5, index: 0.55, harmonic: 0.35, pitchEnv: 0,
      ops: [op(1, 0.7, 0.8), op(3, 0.5, 0.6), op(7, 0.4, 0.5), op(2.5, 0.45, 0.4)],
    },
    amp: { atk: envNorm(0.005), dec: envNorm(0.8), sus: 0.35, rel: envNorm(0.6), vel: 0.5 },
    filter: { cutoff: 16000, reso: 0.05 },
  },
  {
    name: 'DIGI BASS',
    params: {
      algorithm: 3, index: 0.6, harmonic: 0, glide: envNorm(0.15), pitchEnv: -6, pitchEnvDec: envNorm(0.15),
      ops: [
        op(0.5, 1, 0.5, { sus: 0.85, atk: envNorm(0.004) }),
        op(1, 0.5, 0.4), op(2, 0.22, 0.3), op(1, 0.3, 0.06),
      ],
    },
    amp: { atk: envNorm(0.003), dec: envNorm(0.5), sus: 0.85, rel: envNorm(0.2), vel: 0.4 },
    filter: { cutoff: 4200, reso: 0.3, env: 0.35, envDec: envNorm(0.25) },
  },
  {
    name: 'GLASS',
    params: {
      algorithm: 4, index: 0.42, harmonic: 0.7, pitchEnv: 0,
      ops: [op(1, 0.5, 0.7), op(4, 0.4, 0.6), op(6, 0.3, 0.5), op(11, 0.35, 0.4)],
    },
    amp: { atk: envNorm(0.01), dec: envNorm(0.7), sus: 0.5, rel: envNorm(0.5), vel: 0.6 },
    filter: { cutoff: 15000, reso: 0.08 },
  },
  {
    name: 'PERC',
    params: {
      algorithm: 7, index: 0.5, harmonic: 0.2, sat: 0.25, pitchEnv: 14, pitchEnvDec: envNorm(0.05),
      ops: [op(1, 0.85, 0.4, { sus: 0.2 }), op(1.5, 0.7, 0.25), op(2.5, 0.55, 0.15), op(4.5, 0.45, 0.1)],
    },
    amp: { atk: envNorm(0.001), dec: envNorm(0.35), sus: 0, rel: envNorm(0.12), vel: 0.7 },
    filter: { cutoff: 12000, reso: 0.15 },
  },
  {
    name: 'FX RISE',
    params: {
      algorithm: 0, index: 0.85, noise: 0.3, pitchEnv: -24, pitchEnvDec: envNorm(0.7), sat: 0.4,
      ops: [op(1, 0.7, 0.9), op(2, 0.8, 0.8, { feedback: 0.35 }), op(3, 0.6, 0.7), op(5, 0.9, 0.6, { feedback: 0.5 })],
    },
    amp: { atk: envNorm(0.2), dec: envNorm(0.9), sus: 0.55, rel: envNorm(0.8), vel: 0.3 },
    filter: { cutoff: 6000, reso: 0.3, env: 0.6, envAtk: envNorm(0.5), envDec: envNorm(0.8) },
  },
];

/* ---------------------------------------------------------- mono presets --- */

export const MONO_PRESETS: { name: string; params: Partial<MonoParams>; amp?: Partial<TrackParams['amp']>; filter?: Partial<TrackParams['filter']> }[] = [
  { name: 'VA BASS', params: { engine: 'analog', p1: 0.35, p2: 0.2, p3: 0.7, p4: 0.1, sub: 0.6, detune: 0.15, tone: 0.45, drive: 0.2 },
    amp: { atk: envNorm(0.004), dec: envNorm(0.5), sus: 0.8, rel: envNorm(0.2) }, filter: { cutoff: 1800, reso: 0.32, env: 0.4, envDec: envNorm(0.3) } },
  { name: 'GLASS WT', params: { engine: 'wavetable', p1: 0.55, p2: 0.3, p3: 0, p4: 0.25, sub: 0.1, detune: 0.1, tone: 0.8, drive: 0 },
    amp: { atk: envNorm(0.01), dec: envNorm(0.7), sus: 0.6, rel: envNorm(0.5) }, filter: { cutoff: 14000 } },
  { name: 'CZ LEAD', params: { engine: 'phasedist', p1: 0.45, p2: 0.5, p3: 0.35, p4: 0.1, sub: 0.15, detune: 0.05, tone: 0.65, drive: 0.15 },
    amp: { atk: envNorm(0.005), dec: envNorm(0.4), sus: 0.75, rel: envNorm(0.3) }, filter: { cutoff: 9000, reso: 0.2 } },
  { name: 'CHIP LEAD', params: { engine: 'sid', p1: 0.4, p2: 0.25, p3: 0.1, p4: 0.2, sub: 0.2, detune: 0, tone: 0.7, drive: 0.1 },
    amp: { atk: envNorm(0.002), dec: envNorm(0.3), sus: 0.8, rel: envNorm(0.15) }, filter: { cutoff: 12000 } },
  { name: 'NOISE HAT', params: { engine: 'dnoise', p1: 0.9, p2: 0.3, p3: 0.6, p4: 0.1, sub: 0, detune: 0, tone: 0.9, drive: 0 },
    amp: { atk: envNorm(0.001), dec: envNorm(0.08), sus: 0, rel: envNorm(0.06) }, filter: { type: 'HP12', cutoff: 7000 } },
  { name: 'METAL PERC', params: { engine: 'metallic', p1: 0.5, p2: 0.7, p3: 0.4, p4: 0.6, sub: 0, detune: 0, tone: 0.7, drive: 0.15 },
    amp: { atk: envNorm(0.001), dec: envNorm(0.25), sus: 0, rel: envNorm(0.15) }, filter: { cutoff: 9000, reso: 0.2 } },
  { name: 'RING TONE', params: { engine: 'ringmod', p1: 0.45, p2: 0.3, p3: 0.3, p4: 0.8, sub: 0.1, detune: 0.1, tone: 0.6, drive: 0.1 },
    amp: { atk: envNorm(0.01), dec: envNorm(0.6), sus: 0.4, rel: envNorm(0.4) }, filter: { cutoff: 10000 } },
  { name: 'DIGITAL FX', params: { engine: 'digital', p1: 0.4, p2: 0.55, p3: 0.35, p4: 0.5, sub: 0, detune: 0, tone: 0.7, drive: 0.3 },
    amp: { atk: envNorm(0.02), dec: envNorm(0.6), sus: 0.5, rel: envNorm(0.4) }, filter: { cutoff: 8000, reso: 0.3 } },
];

/* --------------------------------------------------------------- tracks ---- */

export function makeTrack(name: string, engine: TrackParams['engine'], patch: (p: TrackParams) => void): KitTrack {
  const params = defaultTrackParams(engine);
  patch(params);
  return { name, params };
}

export function applyFMPreset(p: TrackParams, presetName: string) {
  const pr = FM_PRESETS.find((x) => x.name === presetName) ?? FM_PRESETS[0];
  const fm = defaultFMParams();
  Object.assign(fm, pr.params);
  if (pr.params.ops) {
    for (let i = 0; i < 4; i++) {
      fm.ops[i] = { ...defaultFMParams().ops[i], ...pr.params.ops[i] };
    }
  }
  p.fm = fm;
  if (pr.amp) Object.assign(p.amp, pr.amp);
  if (pr.filter) Object.assign(p.filter, pr.filter);
}

export function defaultKit(): Kit {
  const tracks = [
    makeTrack('KICK', 'fm', (p) => {
      applyFMPreset(p, 'KICK');
      p.volume = 0.95; p.pan = 0; p.sendA = 0.02; p.sendB = 0.03;
    }),
    makeTrack('SNARE', 'fm', (p) => {
      applyFMPreset(p, 'SNARE');
      p.volume = 0.78; p.pan = 0.05; p.sendB = 0.16;
    }),
    makeTrack('BASS', 'mono', (p) => {
      Object.assign(p.mono, MONO_PRESETS[0].params);
      Object.assign(p.amp, MONO_PRESETS[0].amp!);
      Object.assign(p.filter, MONO_PRESETS[0].filter!);
      p.volume = 0.8; p.sendB = 0.04; p.sendA = 0.05;
    }),
    makeTrack('METAL', 'fm', (p) => {
      applyFMPreset(p, 'METALLIC');
      p.volume = 0.6; p.pan = -0.25; p.sendB = 0.25; p.sendA = 0.3;
    }),
    makeTrack('VOCAL', 'sample', (p) => {
      p.sample.sampleId = 'factory-vox-ah';
      p.sample.pitch = 0; p.sample.choke = 1; p.sendB = 0.35; p.sendA = 0.2;
      p.filter.cutoff = 8000; p.volume = 0.7; p.pan = 0.2;
    }),
    makeTrack('LEAD', 'mono', (p) => {
      Object.assign(p.mono, MONO_PRESETS[2].params);
      Object.assign(p.amp, MONO_PRESETS[2].amp!);
      Object.assign(p.filter, MONO_PRESETS[2].filter!);
      p.lfo = { shape: 'TRI', speed: 0.35, depth: 0.12, dest: 'TUNE', sync: false, retrig: true, fade: 0.3 };
      p.volume = 0.62; p.pan = 0.2; p.sendA = 0.3; p.sendB = 0.2;
    }),
    makeTrack('PERC', 'fm', (p) => {
      applyFMPreset(p, 'PERC');
      p.volume = 0.6; p.pan = -0.35; p.sendA = 0.25; p.sendB = 0.2;
    }),
    makeTrack('TEXTURE', 'sample', (p) => {
      p.sample.sampleId = 'factory-hiss';
      p.sample.loopMode = 'forward'; p.sample.loopStart = 0.05; p.sample.loopEnd = 0.95;
      p.amp.atk = 0.25; p.amp.rel = 0.4; p.sample.dec = 0.7; p.sample.sus = 0.7;
      p.filter.cutoff = 5200; p.filter.reso = 0.2;
      p.volume = 0.45; p.pan = 0.4; p.sendB = 0.4; p.sendA = 0.25;
    }),
  ];
  return {
    name: 'KIT 01 INIT',
    tracks,
    sends: {
      delayTime: 0.28, delayFeedback: 0.38, delayTone: 0.45, delayPingPong: true,
      revSize: 0.55, revDamp: 0.45, revPre: 0.05,
    },
    master: defaultMasterParams(),
  };
}

/* -------------------------------------------------------------- patterns --- */

export function emptyPattern(name: string, tempo = 120): Pattern {
  return {
    name,
    length: 16,
    tempo,
    swing: 0,
    tracks: Array.from({ length: 8 }, () => ({
      steps: Array.from({ length: 64 }, () => ({
        on: false, note: 60, vel: 0.85, len: 0.6, micro: 0, cond: 'ALWAYS' as const, locks: {},
      })),
      speed: 1 as const,
      automation: {},
      length: 16,
      muted: false,
    })),
  };
}

/** Set a trig helper. */
export function setStep(pattern: Pattern, track: number, step: number, note: number, vel = 0.85, len = 0.6) {
  const s = pattern.tracks[track].steps[step];
  s.on = true;
  s.note = note;
  s.vel = vel;
  s.len = len;
}

/** The factory pattern: a real groove across all eight tracks. */
export function factoryPattern(): Pattern {
  const p = emptyPattern('P01 FUNK', 120);
  // kick: 4-on-floor + ghost
  const kick = [0, 4, 8, 12];
  for (const s of kick) setStep(p, 0, s, 36, 0.95, 0.5);
  p.tracks[0].steps[14].on = true; p.tracks[0].steps[14].note = 36; p.tracks[0].steps[14].vel = 0.45;
  // snare
  setStep(p, 1, 4, 60, 0.9); setStep(p, 1, 12, 60, 0.9);
  p.tracks[1].steps[7].cond = '1:2'; setStep(p, 1, 7, 60, 0.35);
  // bass line (MONOMACHINE-style)
  const bassNotes = [0, 3, 6, 10, 12, 15];
  const bassVals = [36, 36, 43, 41, 36, 48];
  bassNotes.forEach((s, i) => setStep(p, 2, s, bassVals[i], 0.85, 1.2));
  // p-lock example: step 12 of bass opens the filter hard
  p.tracks[2].steps[12].locks = { 'filter.cutoff': 0.92, 'filter.reso': 0.6 };
  // metallic percussion on the off-steps
  [2, 6, 10, 14].forEach((s, i) => setStep(p, 3, s, 72 + i * 2, 0.55));
  p.tracks[3].steps[6].cond = 'P50';
  p.tracks[3].steps[10].cond = '2:4';
  // vocal hit
  setStep(p, 4, 0, 60, 0.8, 0.9); setStep(p, 4, 11, 63, 0.6, 0.5);
  // lead melody + motion lock
  const leadSteps = [2, 5, 8, 9, 13];
  const leadNotes = [72, 75, 79, 77, 72];
  leadSteps.forEach((s, i) => setStep(p, 5, s, leadNotes[i], 0.75, 1.0));
  // percussion
  [1, 5, 9, 13].forEach((s) => setStep(p, 6, s, 84, 0.5));
  p.tracks[6].steps[9].cond = 'FILL';
  // texture drone triggered once
  setStep(p, 7, 0, 48, 0.4, 16);
  // motion automation example: lead filter cutoff sweep over 16 steps
  const lane: (number | null)[] = [];
  for (let i = 0; i < 64; i++) lane.push(i < 16 ? 0.35 + (i / 15) * 0.4 : null);
  p.tracks[5].automation['filter.cutoff'] = lane;
  return p;
}

export function factoryPattern2(): Pattern {
  const p = emptyPattern('P02 TECH', 126);
  for (let s = 0; s < 16; s += 2) setStep(p, 0, s, 36, s % 4 === 0 ? 0.95 : 0.7, 0.4);
  [4, 12].forEach((s) => setStep(p, 1, s, 60, 0.9));
  const notes = [36, 36, 39, 34, 36, 41, 39, 34];
  notes.forEach((n, i) => setStep(p, 2, i * 2, n, 0.8, 1.0));
  for (let s = 0; s < 16; s += 1) if (s % 4 !== 2) setStep(p, 3, s, 76, 0.3);
  p.tracks[3].steps[7].cond = 'P25';
  setStep(p, 4, 6, 65, 0.7, 0.4);
  [0, 4, 8, 12].forEach((s, i) => setStep(p, 5, s, [72, 74, 76, 79][i], 0.6, 0.9));
  [3, 11].forEach((s) => setStep(p, 6, s, 84, 0.55));
  setStep(p, 7, 0, 43, 0.5, 16);
  return p;
}

/* ---------------------------------------------------------------- project -- */

export function defaultProject(): Project {
  const kit = defaultKit();
  const p1 = factoryPattern();
  const p2 = factoryPattern2();
  const p3 = emptyPattern('P03 EMPTY', 120);
  const song: Song = {
    name: 'SONG 01',
    steps: [{ pattern: 0, repeats: 2 }, { pattern: 1, repeats: 2 }, { pattern: 0, repeats: 1 }],
  };
  return {
    version: 1,
    name: 'HYBRID GROOVEBOX',
    patterns: [p1, p2, p3],
    kits: [kit],
    songs: [song],
    currentPattern: 0,
    currentKit: 0,
    currentSong: 0,
    currentTrack: 0,
    chain: [0, 1],
    chainLoop: true,
    master: kit.master,
    samples: [],
    settings: defaultSettings(),
    savedAt: Date.now(),
  };
}
