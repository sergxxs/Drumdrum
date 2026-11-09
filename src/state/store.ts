/**
 * Store — the single source of truth for the UI.
 *
 * Holds the project document (patterns, kits, songs, samples, settings), the current
 * selection (track/page/step/parameter), transport state and a small undo stack.
 * Mutations go through `update()` which fires listeners and schedules an autosave, so
 * the UI never talks to persistence or the audio engine directly.
 */
import { Rng } from '../audio/dsp';
import type { Kit, KitTrack, Pattern, Project, SampleMeta, Step, TrackParams } from './types';
import type { PageId as P } from './params';
type PageId = P;
import { getNorm, setNorm, PARAM_DEFS, isLockable } from './params';
import { defaultProject, emptyPattern, defaultTrackParams, defaultSettings, defaultMasterParams } from './presets';

export type Listener = () => void;

export interface UiState {
  page: PageId;
  /** 0..3 encoder focus on the current page */
  knobFocus: number;
  /** step cursor 0..63 */
  cursor: number;
  /** transparent modifier: parameter lock edit mode */
  pLockMode: boolean;
  /** motion record */
  motionMode: boolean;
  /** live record arm */
  recArm: boolean;
  /** menu overlay (null = none) */
  overlay: OverlayState | null;
  toast: string;
  toastAt: number;
  /** pads play notes as a keyboard (vs. one-shot) */
  keyboardMode: boolean;
  /** currently displayed kit/preset list cursor */
  listCursor: number;
  fill: boolean;
  /** transport running (mirrored from the audio engine) */
  playing: boolean;
  /** selected row in the master FX insert chain */
  fxRow: number;
  /** metronome */
  click: boolean;
  tempoDrag: boolean;
  /** export progress */
  exporting: { active: boolean; label: string; progress: number } | null;
}

export type OverlayState =
  | { kind: 'kit'; cursor: number }
  | { kind: 'engine'; track: number; cursor: number }
  | { kind: 'preset'; cursor: number; scope: 'fm' | 'mono' | 'sample' }
  | { kind: 'sample'; cursor: number }
  | { kind: 'project'; cursor: number; items: { slot: string; name: string; savedAt: number }[] }
  | { kind: 'song'; cursor: number }
  | { kind: 'confirm'; message: string; action: () => void }
  | { kind: 'help'; cursor: number }
  | { kind: 'export'; cursor: number };

export class Store {
  project: Project;
  ui: UiState;
  samples: Map<string, SampleMeta> = new Map();
  private listeners = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private autosaveTimer: number | null = null;
  onAutosave: (() => void) | null = null;
  readonly rng = new Rng(Date.now() & 0xffffff);

  constructor(project?: Project) {
    this.project = project ?? defaultProject();
    this.ui = {
      page: 'sound',
      knobFocus: 0,
      cursor: 0,
      pLockMode: false,
      motionMode: false,
      recArm: false,
      overlay: null,
      toast: '',
      toastAt: 0,
      keyboardMode: false,
      listCursor: 0,
      fill: false,
      playing: false,
      fxRow: 0,
      click: this.project.settings?.click ?? false,
      tempoDrag: false,
      exporting: null,
    };
    for (const s of this.project.samples) this.samples.set(s.id, s);
  }

  /* ------------------------------------------------------------- observers --- */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Run a mutation, notify and schedule autosave. */
  update(fn: () => void, opts: { silent?: boolean; undo?: boolean } = {}) {
    if (opts.undo !== false) this.pushUndo();
    fn();
    if (!opts.silent) this.emit();
    this.scheduleAutosave();
  }

  pushUndo() {
    try {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > 24) this.undoStack.shift();
      this.redoStack.length = 0;
    } catch {
      /* ignore */
    }
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.toast('NOTHING TO UNDO');
      return;
    }
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev) as Project;
    this.emit();
    this.scheduleAutosave();
    this.toast('UNDO');
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next) as Project;
    this.emit();
    this.scheduleAutosave();
    this.toast('REDO');
  }

  private scheduleAutosave() {
    if (!this.project.settings?.autosave) return;
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      this.onAutosave?.();
    }, 1200);
  }

  /* -------------------------------------------------------------- accessors --- */

  get pattern(): Pattern {
    return this.project.patterns[this.project.currentPattern];
  }

  get kit(): Kit {
    return this.project.kits[this.project.currentKit];
  }

  get track(): TrackParams {
    return this.kit.tracks[this.project.currentTrack].params;
  }

  get trackIndex() {
    return this.project.currentTrack;
  }

  get trackPattern() {
    return this.pattern.tracks[this.project.currentTrack];
  }

  trackParams(i: number): TrackParams {
    return this.kit.tracks[i].params;
  }

  currentStep(): Step {
    return this.trackPattern.steps[this.ui.cursor];
  }

  /** Effective pattern length for the selected track. */
  get trackLength() {
    const tp = this.trackPattern;
    return tp?.length || this.pattern.length;
  }

  /* ---------------------------------------------------------------- actions --- */

  toast(msg: string) {
    this.ui.toast = msg;
    this.ui.toastAt = Date.now();
    this.emit();
  }

  setTrack(i: number) {
    this.project.currentTrack = Math.max(0, Math.min(7, i));
    this.emit();
  }

  setPage(page: PageId) {
    this.ui.page = page;
    this.emit();
  }

  nextPage(dir: number) {
    const order: PageId[] = ['sound', 'filter', 'amp', 'lfo', 'fx', 'mod'];
    const i = order.indexOf(this.ui.page === 'sample' ? 'sound' : this.ui.page);
    const next = (i + dir + order.length) % order.length;
    this.setPage(order[next]);
  }

  setPattern(index: number) {
    this.project.currentPattern = Math.max(0, Math.min(this.project.patterns.length - 1, index));
    this.emit();
  }

  setKit(index: number) {
    this.project.currentKit = Math.max(0, Math.min(this.project.kits.length - 1, index));
    this.emit();
  }

  setCursor(step: number) {
    const len = this.pattern.length;
    this.ui.cursor = ((step % len) + len) % len;
    this.emit();
  }

  toggleStep(step = this.ui.cursor, track = this.project.currentTrack) {
    const tp = this.pattern.tracks[track];
    const s = tp.steps[step];
    this.update(() => {
      s.on = !s.on;
      if (s.on) {
        s.vel = s.vel || 0.85;
        s.len = s.len || 0.6;
      }
    });
  }

  setStepNote(step: number, track: number, note: number) {
    this.update(() => {
      this.pattern.tracks[track].steps[step].note = note;
    });
  }

  setTempo(tempo: number) {
    const t = Math.max(30, Math.min(300, tempo));
    this.update(() => {
      this.pattern.tempo = t;
    }, { undo: false });
  }

  setSwing(swing: number) {
    this.update(() => {
      this.pattern.swing = Math.max(0, Math.min(0.75, swing));
    }, { undo: false });
  }

  setLength(len: number) {
    const l = Math.max(1, Math.min(64, len));
    this.update(() => {
      this.pattern.length = l;
      for (const tp of this.pattern.tracks) tp.length = l;
      if (this.ui.cursor >= l) this.ui.cursor = 0;
    });
  }

  /* ------------------------------------------------------------- parameters --- */

  /** Get the normalised value of a parameter on the current track. */
  getParamNorm(key: string): number {
    return getNorm(this.track, key);
  }

  /** Set a normalised parameter value, honouring p-lock / motion recording modes. */
  setParamNorm(key: string, norm: number, opts: { undo?: boolean } = {}) {
    const clamped = Math.max(0, Math.min(1, norm));
    this.update(() => {
      if (this.ui.pLockMode && isLockable(key)) {
        // store as a lock on the current step, and also move the live value
        const step = this.currentStep();
        step.locks[key] = clamped;
        setNorm(this.track, key, clamped);
      } else if (this.ui.motionMode) {
        const tp = this.trackPattern;
        const lane = tp.automation[key] ?? (tp.automation[key] = new Array(64).fill(null));
        lane[this.ui.cursor] = clamped;
        setNorm(this.track, key, clamped);
      } else {
        setNorm(this.track, key, clamped);
      }
    }, { undo: opts.undo ?? false });
  }

  /** Encoder-style relative edit: delta in normalised units. */
  nudgeParam(key: string, delta: number, fine = false) {
    const d = delta * (fine ? 0.002 : 0.02);
    this.setParamNorm(key, this.getParamNorm(key) + d);
  }

  clearLock(key: string) {
    this.update(() => {
      delete this.currentStep().locks[key];
    });
  }

  clearStepLocks() {
    this.update(() => {
      this.currentStep().locks = {};
    });
  }

  /* ------------------------------------------------------------- automation --- */

  get automation() {
    return this.trackPattern.automation;
  }

  hasAutomation(key: string) {
    return !!this.trackPattern.automation[key];
  }

  clearAutomation(key: string) {
    this.update(() => {
      delete this.trackPattern.automation[key];
    });
  }

  toggleMotionMode() {
    this.ui.motionMode = !this.ui.motionMode;
    this.ui.pLockMode = false;
    this.toast(this.ui.motionMode ? 'MOTION REC ON' : 'MOTION REC OFF');
  }

  togglePLockMode() {
    this.ui.pLockMode = !this.ui.pLockMode;
    this.ui.motionMode = false;
    this.toast(this.ui.pLockMode ? 'PARAM LOCK ON' : 'PARAM LOCK OFF');
  }

  /* --------------------------------------------------------------- patterns --- */

  newPattern() {
    const n = this.project.patterns.length + 1;
    this.update(() => {
      this.project.patterns.push(emptyPattern(`P${String(n).padStart(2, '0')} NEW`, this.pattern.tempo));
      this.project.currentPattern = this.project.patterns.length - 1;
    });
    this.toast('NEW PATTERN');
  }

  copyPattern() {
    this.update(() => {
      const copy = JSON.parse(JSON.stringify(this.pattern)) as Pattern;
      copy.name = `${this.pattern.name} CP`;
      this.project.patterns.push(copy);
      this.project.currentPattern = this.project.patterns.length - 1;
    });
    this.toast('PATTERN COPIED');
  }

  clearPattern() {
    this.update(() => {
      for (const tp of this.pattern.tracks) {
        for (const s of tp.steps) {
          s.on = false;
          s.locks = {};
          s.cond = 'ALWAYS';
        }
        tp.automation = {};
      }
    });
    this.toast('PATTERN CLEARED');
  }

  setTrackLength(track: number, len: number) {
    this.update(() => {
      this.pattern.tracks[track].length = Math.max(1, Math.min(64, len));
    });
  }

  setTrackSpeed(track: number, speed: 1 | 2 | 3 | 4) {
    this.update(() => {
      this.pattern.tracks[track].speed = speed;
    });
  }

  setStepCond(step: number, track: number, cond: Step['cond']) {
    this.update(() => {
      this.pattern.tracks[track].steps[step].cond = cond;
    });
  }

  /* -------------------------------------------------------------------- kit --- */

  setEngine(track: number, engine: TrackParams['engine']) {
    this.update(() => {
      const p = this.kit.tracks[track].params;
      p.engine = engine;
      if (engine === 'sample' && !p.sample.sampleId) {
        p.sample.sampleId = this.samples.size ? [...this.samples.keys()][0] : 'factory-break';
      }
    });
  }

  renameTrack(track: number, name: string) {
    this.update(() => {
      this.kit.tracks[track].name = name.slice(0, 10).toUpperCase();
    });
  }

  /* ---------------------------------------------------------------- samples --- */

  addSampleMeta(meta: SampleMeta) {
    this.samples.set(meta.id, meta);
    if (!this.project.samples.find((s) => s.id === meta.id)) this.project.samples.push(meta);
    this.emit();
    this.scheduleAutosave();
  }

  removeSample(id: string) {
    this.samples.delete(id);
    this.project.samples = this.project.samples.filter((s) => s.id !== id);
    this.emit();
  }

  /* -------------------------------------------------------------- randomise --- */

  /** Musical randomisation, scoped by `target`. */
  randomize(
    target: 'steps' | 'locks' | 'sound' | 'pattern' | 'melody' | 'sample' | 'kit',
    density = 0.4,
  ) {
    const r = this.rng;
    const track = this.project.currentTrack;
    this.update(() => {
      switch (target) {
        case 'steps': {
          const tp = this.pattern.tracks[track];
          const len = this.trackLength;
          for (let i = 0; i < len; i++) {
            tp.steps[i].on = r.chance(density);
            if (tp.steps[i].on && r.chance(0.3)) {
              tp.steps[i].vel = r.range(0.35, 1);
            }
          }
          break;
        }
        case 'locks': {
          const keys = Object.keys(PARAM_DEFS).filter((k) => isLockable(k) && k.split('.')[0] !== 'sample');
          const tp = this.trackPattern;
          const key = r.pick(keys);
          const len = this.trackLength;
          for (let i = 0; i < len; i++) {
            if (tp.steps[i].on) tp.steps[i].locks[key] = r.range(0.15, 0.95);
          }
          this.toast(`LOCKS: ${key.toUpperCase()}`);
          break;
        }
        case 'sound': {
          this.randomizeSound(track);
          break;
        }
        case 'melody': {
          const tp = this.pattern.tracks[track];
          const scale = [0, 2, 3, 5, 7, 10];
          const root = 48 + r.int(0, 1) * 12;
          for (let i = 0; i < this.trackLength; i++) {
            if (tp.steps[i].on) {
              tp.steps[i].note = root + scale[r.int(0, scale.length - 1)] + (r.chance(0.2) ? 12 : 0);
            }
          }
          break;
        }
        case 'pattern': {
          // generate a musical rhythm on four tracks: kick 4-floor, snare 2&4, hats 8ths
          const len = this.trackLength;
          for (let t = 0; t < 8; t++) {
            const tp = this.pattern.tracks[t];
            for (let i = 0; i < len; i++) tp.steps[i].on = false;
          }
          const buckets = [
            { track: 0, pattern: [0, 4, 8, 12], jitter: 0.1 },
            { track: 1, pattern: [4, 12], jitter: 0 },
            { track: 6, pattern: [2, 6, 10, 14], jitter: 0.3 },
            { track: 4, pattern: [0, 7], jitter: 0.05 },
          ];
          for (const b of buckets) {
            for (const s of b.pattern) {
              if (r.chance(1 - b.jitter)) this.pattern.tracks[b.track].steps[s % len].on = true;
            }
          }
          break;
        }
        case 'sample': {
          const p = this.track.sample;
          p.start = r.chance(0.5) ? 0 : r.range(0, 0.2);
          p.end = r.range(0.6, 1);
          p.reverse = r.chance(0.25);
          p.loopMode = r.chance(0.3) ? 'forward' : 'off';
          p.slices = r.pick([1, 2, 4, 8]);
          p.pitch = r.int(-12, 12);
          p.rate = r.pick([0.5, 0.75, 1, 1, 1.5, 2]);
          p.shaper = r.int(0, 3);
          p.shaperAmt = r.range(0, 0.6);
          break;
        }
        case 'kit':
          for (let t = 0; t < 8; t++) this.randomizeSound(t);
          this.toast('KIT RANDOMISED');
          break;
      }
    });
  }

  private randomizeSound(track: number) {
    const r = this.rng;
    const p = this.kit.tracks[track].params;
    if (p.engine === 'fm') {
      p.fm.algorithm = r.int(0, 7);
      p.fm.index = r.range(0.2, 0.85);
      p.fm.harmonic = r.chance(0.3) ? r.range(0, 1) : 0;
      for (let i = 0; i < 4; i++) {
        p.fm.ops[i].ratio = r.next();
        p.fm.ops[i].level = i === 0 ? r.range(0.6, 1) : r.range(0, 0.9);
        p.fm.ops[i].dec = r.range(0.3, 0.8);
        p.fm.ops[i].feedback = r.chance(0.25) ? r.range(0, 0.6) : 0;
      }
      p.fm.noise = r.chance(0.25) ? r.range(0, 0.5) : 0;
    } else if (p.engine === 'mono') {
      p.mono.engine = r.pick(['analog', 'wavetable', 'phasedist', 'sid', 'dnoise', 'metallic', 'ringmod', 'digital']);
      p.mono.p1 = r.next();
      p.mono.p2 = r.next();
      p.mono.p3 = r.next();
      p.mono.p4 = r.next();
      p.mono.tone = r.range(0.3, 0.9);
    } else {
      const ids = [...this.samples.keys()];
      if (ids.length) p.sample.sampleId = r.pick(ids);
      p.sample.pitch = r.int(-12, 6);
      p.sample.start = r.chance(0.5) ? 0 : r.range(0, 0.3);
      p.sample.end = r.range(0.5, 1);
    }
    p.filter.type = r.pick(['LP12', 'LP24', 'HP12', 'BP12']);
    p.filter.cutoff = r.chance(0.5) ? r.range(500, 18000) : r.range(200, 3000);
    p.filter.reso = r.range(0, 0.6);
    p.amp.dec = r.range(0.25, 0.7);
    p.amp.rel = r.range(0.2, 0.5);
    if (r.chance(0.25)) {
      p.lfo.dest = r.pick(['TUNE', 'CUTOFF', 'AMP', 'PAN', 'INDEX', 'DECAY']);
      p.lfo.depth = r.range(0.1, 0.5);
      p.lfo.speed = r.range(0.2, 0.7);
      p.lfo.shape = r.pick(['SINE', 'TRI', 'SAW', 'SQR', 'S&H']);
    } else {
      p.lfo.depth = 0;
    }
  }

  /* ------------------------------------------------------------------- song --- */

  get song() {
    return this.project.songs[this.project.currentSong];
  }

  addChainStep(patternIndex: number) {
    this.update(() => {
      this.project.chain.push(patternIndex);
    });
  }

  /* ------------------------------------------------------------------ setup --- */

  resetProject() {
    this.update(() => {
      const p = defaultProject();
      p.settings = this.project.settings ?? defaultSettings();
      this.project = p;
    });
    this.toast('PROJECT RESET');
  }

  mergeProject(p: Project) {
    this.update(() => {
      this.project = p;
      if (!this.project.master) this.project.master = defaultMasterParams();
      this.samples.clear();
      for (const s of this.project.samples) this.samples.set(s.id, s);
    });
    this.toast('PROJECT LOADED');
  }
}

export function blankTrackParams(engine: TrackParams['engine'] = 'fm'): TrackParams {
  return defaultTrackParams(engine);
}

export function kitTrackName(t: KitTrack) {
  return t.name;
}

export type { P };
