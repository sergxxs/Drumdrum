/**
 * App — wires the physical panel to the store, the LCD and the audio service.
 *
 * Design rules followed here:
 *  • every physical-looking control is a real control (no decorative buttons)
 *  • the LCD is the only display; all feedback goes through it plus the LEDs
 *  • UI updates are driven by the store subscription + one animation frame loop
 *  • nothing in the audio path depends on animation frame timing
 */
import { Lcd } from './lcd';
import { Dialogs } from './dialogs';
import type { DialogModel } from './dialogs';
import { drawScreen } from './pages';
import type { Screen, Status } from './pages';
import {
  bindKnob, fitDevice, installTouchGuards, onLongPress, padVelocity, setKnobAngle, TapTempo,
} from './hardware';
import { Store } from '../state/store';
import {
  PAGE_ORDER, PARAM_DEFS, formatValue, getNorm, isLockable, normToValue, pageKnobs,
  pageTitle, setNorm,
} from '../state/params';
import { FM_PRESETS, MONO_PRESETS, applyFMPreset, noteName } from './appHelpers';
import { condLabel } from '../seq/trig';
import { engineLabel } from './pages';
import { audioService } from '../audio/service';
import { AudioEngine } from '../audio/engine';
import type { MeterMessage } from '../audio/hostProtocol';
import {
  buildFactorySamples, decodeWav, makeSample, SampleData,
} from '../audio/sample';
import { encodeWav, normalizeChannels } from '../audio/wav';
import { encodeMp3 } from '../audio/mp3';
import * as storage from '../state/storage';
import { exportMix } from '../export/render';
import type { ExportOptions } from '../export/render';
import type { EngineKind, Step, TrackParams } from '../state/types';
import { TRIG_CONDS } from '../state/types';
import type { PageId } from '../state/params';

const BASE_W = 1180;
const BASE_H = 700;

export class App {
  private store: Store;
  private lcd: Lcd;
  private dialogs: Dialogs;
  private status: Status = {
    playing: false,
    steps: [0, 0, 0, 0, 0, 0, 0, 0],
    masterL: 0,
    masterR: 0,
    trackMeters: new Array(8).fill(0),
    recFrames: 0,
    recActive: false,
    audio: 'idle',
    host: '—',
    frames: 0,
  };
  private samples: SampleData[] = [];
  private screen: Screen = { kind: 'mode', name: 'PATTERN' };
  /** when true the modal pickers use the VALUE knob */
  private tapTempo = new TapTempo();
  private lastLcdHash = '';
  private heldNotes = new Map<number, number>();
  private exportFormat: 'wav' | 'mp3' = 'wav';
  private fileTarget: 'sample' | 'project' = 'sample';
  private saveTimer: number | null = null;
  private booted = false;

  constructor(private root: HTMLElement) {
    this.store = new Store();
    this.lcd = new Lcd(root.querySelector('#lcd') as HTMLCanvasElement);
    this.dialogs = new Dialogs(root.querySelector('#overlay') as HTMLElement);
  }

  /* ------------------------------------------------------------------ boot --- */

  async boot() {
    installTouchGuards(this.root);
    fitDevice(this.root.querySelector('#device') as HTMLElement, BASE_W, BASE_H);
    this.wirePanel();
    this.wireOverlay();
    this.store.subscribe(() => this.invalidate());
    this.store.onAutosave = () => void this.autosave();
    audioService.onMeter((m) => this.onMeters(m));
    this.samples = buildFactorySamples(44100);
    for (const s of this.samples) this.store.addSampleMeta(s.meta);

    // restore the autosaved project, falling back to the factory project
    const saved = await storage.loadProject('autosave');
    if (saved) {
      this.store.project = saved;
      for (const m of saved.samples) this.store.samples.set(m.id, m);
      // restore user samples from IndexedDB
      const stored = await storage.loadAllSamples();
      for (const rec of stored) {
        const data = makeSample(rec.meta.id, rec.meta.name, rec.left, rec.right, rec.meta.sampleRate,
          rec.meta.transients, rec.meta.peaks);
        this.samples.push(data);
        this.store.addSampleMeta(data.meta);
      }
      this.store.emit();
      this.toast('PROJECT RESTORED');
    }

    this.selectMode('PATTERN');
    this.booted = true;
    this.render();
    this.loop();
    // resume audio on the first gesture (iOS requirement)
    const unlock = () => {
      void this.ensureAudio();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    // autosave when the tab is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.autosave();
    });
  }

  private async ensureAudio() {
    if (this.status.audio === 'running') return true;
    this.status.audio = 'starting';
    this.invalidate();
    const ok = await audioService.start(this.store.project, this.samples);
    this.status.audio = ok ? 'running' : 'error';
    this.status.host = audioService.mode === 'worklet' ? 'WORKLET' : 'MAIN THREAD';
    if (!ok) this.toast('AUDIO FAILED — TAP PLAY AGAIN');
    this.invalidate();
    return ok;
  }

  /* --------------------------------------------------------------- persistence --- */

  private async autosave() {
    if (!this.store.project.settings.autosave) return;
    const project = this.store.project;
    project.samples = [...this.store.samples.values()];
    await storage.saveProject(project, 'autosave');
  }

  private scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.autosave(), 900);
  }

  /* ------------------------------------------------------------------- panel --- */

  private q<T extends HTMLElement>(sel: string): T {
    const el = this.root.querySelector(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el as T;
  }

  private wirePanel() {
    /* ---- mode buttons ---- */
    this.root.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) => {
      btn.addEventListener('click', () => this.selectMode(btn.dataset.mode as string));
    });

    /* ---- navigation ---- */
    this.root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => this.onNav(btn.dataset.nav as string));
    });

    /* ---- parameter encoders A-D ---- */
    ['a', 'b', 'c', 'd'].forEach((id, index) => {
      const wrap = this.q(`.pknob[data-knob="${id}"]`);
      const knob = wrap.querySelector('.knob') as HTMLElement;
      const label = wrap.querySelector('.pknob-label') as HTMLElement;
      const keys = () => this.currentKnobs();
      const apply = (delta: number, fine: boolean) => {
        const key = keys()[index];
        this.store.ui.knobFocus = index;
        if (!key) {
          this.toast('NO PARAM ON THIS PAGE');
          this.invalidate();
          return;
        }
        const cur = getNorm(this.store.track, key);
        const sens = fine ? 0.004 : 0.02;
        this.peek();
        this.editParam(key, cur + delta * sens);
      };
      bindKnob(knob, {
        onDelta: apply,
        onFocus: () => {
          this.store.ui.knobFocus = index;
          this.invalidate();
        },
      });
      // tap the encoder label to cycle pages (hardware "page" gesture)
      label.addEventListener('click', () => {
        this.cyclePage(1);
      });
      // show which param the knob points at
      const sync = () => {
        const key = keys()[index];
        label.textContent = key ? (VIRTUAL_LABELS[key] ?? PARAM_DEFS[key]?.label ?? key) : '—';
      };
      this.knobLabelSync.push(sync);
      sync();
    });

    /* ---- value encoder ---- */
    const valueKnob = this.q('#value-knob');
    bindKnob(valueKnob, {
      travel: 200,
      onDelta: (delta, fine) => this.onValueKnob(delta, fine),
    });
    valueKnob.addEventListener('dblclick', () => this.dialogs.close());

    /* ---- FX send + master encoders ---- */
    bindKnob(this.q('[data-knob="send"]'), {
      onDelta: (d) => {
        const key = 'sendA';
        this.editParam(key, getNorm(this.store.track, key) + d * 0.02);
      },
    });
    bindKnob(this.q('[data-knob="master"]'), {
      onDelta: (d) => {
        const v = Math.max(0, Math.min(1, this.store.project.master.volume + d * 0.02));
        this.store.update(() => {
          this.store.project.master.volume = v;
        }, { undo: false });
        audioService.setMaster({ volume: v });
      },
    });

    /* ---- pads ---- */
    this.root.querySelectorAll<HTMLButtonElement>('.pad').forEach((pad) => {
      const track = Number(pad.dataset.track);
      const col = pad.closest('.pad-col') as HTMLElement;
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pad.setPointerCapture?.(e.pointerId);
        const rect = pad.getBoundingClientRect();
        const vel = padVelocity(rect, e.clientY, e.clientX);
        this.onPadDown(track, vel, col);
      });
      pad.addEventListener('pointerup', (e) => {
        e.preventDefault();
        this.onPadUp(track);
      });
      pad.addEventListener('pointercancel', () => this.onPadUp(track));
      pad.addEventListener('pointerleave', () => this.onPadUp(track));
    });

    /* ---- mute / solo ---- */
    this.q('#btn-mute').addEventListener('click', () => {
      const t = this.store.trackIndex;
      this.store.update(() => {
        const p = this.store.trackParams(t);
        p.mute = !p.mute;
      });
      this.pushTrackParams(t);
      this.toast(`TRK ${t + 1} ${this.store.trackParams(t).mute ? 'MUTED' : 'UNMUTED'}`);
    });
    this.q('#btn-solo').addEventListener('click', () => {
      const t = this.store.trackIndex;
      this.store.update(() => {
        const p = this.store.trackParams(t);
        p.solo = !p.solo;
      });
      this.applySolo();
    });

    /* ---- track speed / length / swing ---- */
    this.root.querySelectorAll<HTMLButtonElement>('[data-step-adj]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const what = btn.dataset.stepAdj!;
        const dir = Number(btn.dataset.dir);
        if (what === 'speed') {
          const tp = this.store.trackPattern;
          const order: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
          const i = order.indexOf(tp.speed);
          this.store.setTrackSpeed(this.store.trackIndex, order[(i + dir + 4) % 4]);
          this.syncAudioPattern();
        } else if (what === 'length') {
          this.store.setLength(this.store.pattern.length + dir * (this.store.pattern.length >= 64 ? 0 : 4));
          this.syncAudioPattern();
        } else {
          const s = this.store.pattern.swing + dir * 0.03;
          this.store.setSwing(s);
          audioService.setSwing(this.store.pattern.swing);
        }
      });
    });

    /* ---- transport ---- */
    this.q('#btn-play').addEventListener('click', () => void this.togglePlay());
    this.q('#btn-stop').addEventListener('click', () => this.stop());
    this.q('#btn-live-rec').addEventListener('click', () => this.toggleLiveRec());
    this.q('#btn-rec').addEventListener('click', () => this.toggleAudioRec());
    this.q('#btn-select').addEventListener('click', () => this.openExportDialog());
    this.q('#btn-format').addEventListener('click', () => {
      this.exportFormat = this.exportFormat === 'wav' ? 'mp3' : 'wav';
      this.q('#format-label').textContent = this.exportFormat.toUpperCase();
      this.toast(`EXPORT FORMAT ${this.exportFormat.toUpperCase()}`);
    });

    /* ---- function row ---- */
    this.root.querySelectorAll<HTMLButtonElement>('[data-fn]').forEach((btn) => {
      const fn = btn.dataset.fn!;
      if (fn === 'tap') {
        btn.addEventListener('click', () => {
          const bpm = this.tapTempo.tap();
          if (bpm) {
            this.store.setTempo(bpm);
            audioService.setTempo(this.store.pattern.tempo);
            this.toast(`TEMPO ${bpm.toFixed(1)}`);
          } else {
            this.toast('TAP...');
          }
        });
        return;
      }
      btn.addEventListener('click', () => this.onFunction(fn, btn));
    });

    // long-press on the pattern button toggles fill
    onLongPress(this.q('.mode[data-mode="pattern"]'), () => {
      this.store.ui.fill = !this.store.ui.fill;
      audioService.setFill(this.store.ui.fill);
      this.toast(this.store.ui.fill ? 'FILL ON' : 'FILL OFF');
    });

    // file input
    const input = this.q<HTMLInputElement>('#file-input');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.importFile(file);
      input.value = '';
    });
  }

  /** Overlay taps: clicking the backdrop closes the dialog. */
  private wireOverlay() {
    const overlay = this.q('#overlay');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.dialogs.close();
        this.stepEditTarget = null;
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.dialogs.close();
      if (e.key === ' ') {
        e.preventDefault();
        void this.togglePlay();
      }
      if (e.key === 'Enter' && this.dialogs.open) this.dialogs.select();
      if (e.key === 'ArrowUp' && this.dialogs.open) this.dialogs.move(-1);
      if (e.key === 'ArrowDown' && this.dialogs.open) this.dialogs.move(1);
    });
  }

  /** Timestamp until which the parameter page is shown over the current mode. */
  private peekUntil = 0;

  private peek(ms = 2200) {
    this.peekUntil = performance.now() + ms;
  }

  private cyclePage(dir: number) {
    const order: PageId[] = ['sound', 'filter', 'amp', 'lfo', 'fx', 'mod'];
    const cur = this.store.ui.page === 'sample' ? 'sound' : this.store.ui.page;
    const i = order.indexOf(cur);
    this.store.setPage(order[(i + dir + order.length) % order.length]);
    this.peek();
    this.invalidate();
  }

  /** The screen actually drawn: a peeking parameter page wins over the mode screen. */
  private effectiveScreen(): Screen {
    if (this.screen.kind === 'page') return this.screen;
    if (performance.now() < this.peekUntil) {
      return { kind: 'page', page: this.store.ui.page };
    }
    return this.screen;
  }

  /**
   * Trig editor — everything a step carries: on/off, note, velocity, length, micro timing,
   * trig condition, and a list of its parameter locks (with the ability to clear them).
   * All of it is real sequencer data, not a UI-only flag.
   */
  private openStepEditor() {
    const store = this.store;
    const track = store.trackIndex;
    const stepIndex = store.ui.cursor;
    const params = store.trackParams(track);
    const build = (): DialogModel => {
      const s = store.pattern.tracks[track].steps[stepIndex];
      const lockKeys = Object.keys(s.locks);
      const items: { label: string; meta?: string; action?: () => void }[] = [
        {
          label: `TRIG ${s.on ? 'ON' : 'OFF'}`,
          meta: 'STEP ' + (stepIndex + 1),
          action: () => {
            store.update(() => { s.on = !s.on; });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        },
        {
          label: `NOTE ${noteName(s.note)}`,
          meta: `${s.note} · ◀▶ PAD`,
          action: () => {
            /* the pads transpose while this dialog is open (see pad handler) */
            this.toast('TAP A PAD TO SET THE NOTE');
          },
        },
        {
          label: `VELOCITY ${Math.round(s.vel * 100)}`,
          meta: 'TAP TO +10',
          action: () => {
            store.update(() => { s.vel = s.vel >= 1 ? 0.2 : Math.min(1, s.vel + 0.1); });
            this.dialogs.update(build());
          },
        },
        {
          label: `LENGTH ${s.len.toFixed(2)}`,
          meta: 'STEPS',
          action: () => {
            store.update(() => { s.len = s.len >= 4 ? 0.25 : Math.min(4, s.len + 0.25); });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        },
        {
          label: `MICRO ${s.micro >= 0 ? '+' : ''}${Math.round(s.micro * 100)}`,
          meta: 'TAP TO +10%',
          action: () => {
            store.update(() => { s.micro = (s.micro + 0.1 > 0.5) ? -0.5 : s.micro + 0.1; });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        },
        {
          label: `CONDITION ${condLabel(s.cond) || 'ALWAYS'}`,
          meta: 'TAP TO CYCLE',
          action: () => {
            const i = TRIG_CONDS.indexOf(s.cond);
            store.update(() => { s.cond = TRIG_CONDS[(i + 1) % TRIG_CONDS.length]; });
            this.dialogs.update(build());
          },
        },
        {
          label: `PARAM LOCKS (${lockKeys.length})`,
          meta: lockKeys.length ? 'TAP TO CLEAR' : 'NONE',
          action: () => {
            store.update(() => { s.locks = {}; });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        },
        {
          label: 'COPY STEP TO CURSOR+1',
          meta: 'CLONE',
          action: () => {
            store.update(() => {
              const len = store.trackLength;
              const next = (stepIndex + 1) % len;
              const target = store.pattern.tracks[track].steps[next];
              target.on = s.on;
              target.note = s.note;
              target.vel = s.vel;
              target.len = s.len;
              target.micro = s.micro;
              target.cond = s.cond;
              target.locks = JSON.parse(JSON.stringify(s.locks));
            });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        },
      ];
      for (const k of lockKeys) {
        items.push({
          label: `LOCK ${k}`,
          meta: formatValue(k, s.locks[k]),
          action: () => {
            store.update(() => { delete s.locks[k]; });
            this.syncAudioPattern();
            this.dialogs.update(build());
          },
        });
      }
      items.push({
        label: 'ENGINE: ' + engineLabel(params.engine),
        meta: 'SWITCH',
        action: () => {
          this.dialogs.close();
          this.openEnginePicker(track);
        },
      });
      return { title: `TRIG EDITOR — TRK ${track + 1} STEP ${stepIndex + 1}`, items };
    };
    this.stepEditTarget = { track, step: stepIndex };
    this.dialogs.show(build());
  }

  /** While the trig editor is open, a pad writes its note into the edited step. */
  private stepEditTarget: { track: number; step: number } | null = null;

  private knobLabelSync: (() => void)[] = [];

  /**
   * The four parameters the A-D encoders drive. This follows the *visible* screen: the
   * MIX page maps them to volume/pan/mute/solo of the selected track, the remaining
   * modes fall through to the parameter page they peek from.
   */
  private currentKnobs(): string[] {
    const screen = this.effectiveScreen();
    if (screen.kind === 'mode') {
      switch (screen.name) {
        case 'MIX': return ['volume', 'pan', 'mute', 'solo'];
        case 'SETUP': return ['masterVol', 'lcdTheme', 'clockTempo', 'click'];
        case 'FX': return ['fxChainToggle', 'fxChainMix', 'masterWidth', 'masterDrive'];
        case 'SONG': return ['songAdd', 'songDelete', 'songRepeats', 'songPattern'];
        case 'KIT':
        case 'PATTERN':
        default: break;
      }
    }
    const page = this.store.ui.page;
    const engine = this.store.track.engine;
    if (page === 'sample' && engine !== 'sample') return [];
    return pageKnobs(page, engine);
  }

  /* --------------------------------------------------------------- parameter edit --- */

  /**
   * Central parameter edit. Handles p-lock and motion modes, raises undo grouping, and
   * pushes the new value to the audio engine.
   */
  private editParam(key: string, norm: number, opts: { fine?: boolean } = {}) {
    if (VIRTUAL_KEYS.has(key)) {
      this.editVirtual(key, norm);
      return;
    }
    // P-LOCK / MOTION edits happen while the pattern page is visible, so don't peek then.
    if (!this.store.ui.pLockMode && !this.store.ui.motionMode) this.peek();
    const clamped = Math.max(0, Math.min(1, norm));
    const store = this.store;
    const track = store.trackIndex;
    // Coalesce rapid edits into one undo entry per gesture.
    const now = performance.now();
    const isNewGesture = now - this.lastEditAt > 400 || this.lastEditKey !== key;
    this.lastEditKey = key;
    this.lastEditAt = now;
    store.update(() => {
      if (store.ui.motionMode && store.ui.playing) {
        const tp = store.trackPattern;
        const lane = tp.automation[key] ?? (tp.automation[key] = new Array(64).fill(null));
        lane[store.ui.cursor] = clamped;
        setNorm(store.track, key, clamped);
      } else if (store.ui.pLockMode && isLockable(key)) {
        store.currentStep().locks[key] = clamped;
        setNorm(store.track, key, clamped);
      } else {
        setNorm(store.track, key, clamped);
      }
    }, { undo: isNewGesture });
    this.pushParam(track, key);
    // motion automation changes are structural for the sequencer (lanes), refresh pattern
    if (store.ui.motionMode) this.syncAudioPattern();
    this.invalidate();
    void opts.fine;
  }

  private lastEditAt = 0;
  private lastEditKey = '';

  /** Keys that are not track parameters: transport, mixer switches, master settings. */
  private editVirtual(key: string, norm: number) {
    const store = this.store;
    const p = store.track;
    const t = store.trackIndex;
    switch (key) {
      case 'mute':
        store.update(() => { p.mute = norm > 0.5; });
        audioService.setParam(t, 'mute', p.mute ? 1 : 0);
        break;
      case 'solo':
        store.update(() => { p.solo = norm > 0.5; });
        this.applySolo();
        break;
      case 'masterVol':
        store.update(() => { store.project.master.volume = norm; }, { undo: false });
        audioService.setMaster({ volume: norm });
        break;
      case 'lcdTheme':
        this.lcd.setTheme(norm > 0.5 ? 'dark' : 'light');
        break;
      case 'click':
        this.store.project.settings.click = norm > 0.5;
        audioService.setClick(this.store.project.settings.click);
        this.toast(`METRONOME ${this.store.project.settings.click ? 'ON' : 'OFF'}`);
        break;
      case 'clockTempo':
        store.setTempo(30 + norm * 270);
        audioService.setTempo(store.pattern.tempo);
        break;
      case 'fxChainToggle': {
        const idx = store.ui.fxRow;
        store.update(() => {
          const fx = store.project.master.chain[idx];
          if (fx) fx.on = !fx.on;
        });
        audioService.setMaster({ chain: store.project.master.chain });
        break;
      }
      case 'fxChainMix': {
        const idx = store.ui.fxRow;
        store.update(() => {
          const fx = store.project.master.chain[idx];
          if (fx) fx.mix = Math.max(0, Math.min(1, norm));
        }, { undo: false });
        audioService.setMaster({ chain: store.project.master.chain });
        break;
      }
      /* ---- SONG page: the encoders edit the arrangement, not the sound ---- */
      case 'songAdd':
        if (norm > 0.5) {
          store.addSongStep(store.project.currentPattern);
          store.setSongCursor(store.song.steps.length - 1);
          this.toast(`ADDED P${store.project.currentPattern + 1}`);
        }
        break;
      case 'songDelete':
        if (norm > 0.5) {
          store.removeSongStep(store.ui.songCursor);
          this.toast('STEP DELETED');
        }
        break;
      case 'songRepeats': {
        const step = store.song.steps[store.ui.songCursor];
        if (step) {
          store.setSongStepRepeats(store.ui.songCursor, 1 + Math.round(norm * 16));
          this.toast(`REPEATS ${store.song.steps[store.ui.songCursor].repeats}`);
        }
        break;
      }
      case 'songPattern': {
        const step = store.song.steps[store.ui.songCursor];
        if (step) {
          store.setSongStepPattern(store.ui.songCursor, Math.round(norm * 16));
          this.toast(`PATTERN ${store.song.steps[store.ui.songCursor].pattern + 1}`);
        }
        break;
      }
      case 'masterWidth':
        store.update(() => { store.project.master.width = norm * 2; }, { undo: false });
        audioService.setMaster({ width: norm * 2 });
        break;
      case 'masterDrive':
        store.update(() => { store.project.master.drive = norm; }, { undo: false });
        audioService.setMaster({ drive: norm });
        break;
      default:
        break;
    }
    this.invalidate();
  }

  private editFocused(delta: number, fine: boolean) {
    const key = this.currentKnobs()[this.store.ui.knobFocus];
    if (!key) return;
    const sens = fine ? 0.005 : 0.02;
    this.editParam(key, getNorm(this.store.track, key) + delta * sens);
  }

  /** Send a single parameter to the live engine (real value). */
  private pushParam(track: number, key: string) {
    audioService.setParam(track, key, readPath(this.store.trackParams(track), key));
  }

  private pushTrackParams(track: number) {
    const p = this.store.trackParams(track);
    for (const key in PARAM_DEFS) {
      if (key.split('.').length > 3) continue;
      audioService.setParam(track, key, readPath(p, key));
    }
    audioService.setParam(track, 'volume', p.volume);
    audioService.setParam(track, 'pan', p.pan);
    audioService.setParam(track, 'mute', p.mute ? 1 : 0);
  }

  private applySolo() {
    // solo is resolved in the engine by muting non-soloed tracks' volume
    const anySolo = this.store.kit.tracks.some((t) => t.params.solo);
    for (let i = 0; i < 8; i++) {
      const p = this.store.trackParams(i);
      audioService.setParam(i, 'mute', (p.mute || (anySolo && !p.solo)) ? 1 : 0);
    }
  }

  /* ------------------------------------------------------------------ transport --- */

  private async togglePlay() {
    const ok = await this.ensureAudio();
    if (!ok) return;
    if (this.store.ui.recArm && !this.store.ui.playing) {
      // start live recording with the transport
    }
    this.store.ui.playing = !this.store.ui.playing;
    if (this.store.ui.playing) {
      this.syncAudioPattern();
      audioService.setTempo(this.store.pattern.tempo);
      audioService.setSwing(this.store.pattern.swing);
      audioService.play();
    } else {
      audioService.stop();
    }
    this.invalidate();
  }

  private stop() {
    this.store.ui.playing = false;
    audioService.stop();
    if (this.status.recActive) void this.finishAudioRec();
    this.invalidate();
  }

  private toggleLiveRec() {
    this.store.ui.recArm = !this.store.ui.recArm;
    this.q('#btn-live-rec').classList.toggle('active', this.store.ui.recArm);
    this.toast(this.store.ui.recArm ? 'LIVE REC ARMED' : 'LIVE REC OFF');
  }

  private async toggleAudioRec() {
    if (this.status.recActive) {
      await this.finishAudioRec();
      return;
    }
    const ok = await this.ensureAudio();
    if (!ok) return;
    audioService.startRecord();
    this.status.recActive = true;
    this.status.recFrames = 0;
    this.toast('RECORDING MASTER');
    this.invalidate();
  }

  private async finishAudioRec() {
    if (!this.status.recActive) return;
    this.status.recActive = false;
    this.invalidate();
    const rec = await audioService.stopRecord();
    if (!rec || rec.left.length === 0) {
      this.toast('NOTHING RECORDED');
      return;
    }
    if (this.exportFormat === 'mp3') {
      this.toast('ENCODING MP3...');
      const norm = normalizeChannels(rec.left, rec.right);
      const blob = await encodeMp3(norm.left, norm.right, rec.sampleRate, 192);
      storage.downloadBlob(blob, `groovebox-rec-${Date.now()}.mp3`);
    } else {
      this.download(rec.left, rec.right, 'rec');
    }
    this.toast('RECORDING SAVED');
  }

  private onPadDown(track: number, vel: number, col: HTMLElement) {
    void this.ensureAudio();
    const store = this.store;
    const wasSelected = store.trackIndex === track;
    store.setTrack(track);
    if (!wasSelected) {
      // selecting a track also makes it the active LCD page target
      this.invalidate();
    }
    if (this.dialogs.open && this.stepEditTarget) {
      // assign this pad's note to the step being edited
      const note = this.stepEditTarget.track * 0 + 48 + track * 2;
      store.update(() => {
        const st = store.pattern.tracks[this.stepEditTarget!.track].steps[this.stepEditTarget!.step];
        st.note = note;
        st.on = true;
      });
      audioService.trigger(this.stepEditTarget.track, note, vel);
      this.heldNotes.set(track, note);
      this.syncAudioPattern();
      this.dialogs.close();
      this.stepEditTarget = null;
      this.toast(`NOTE ${noteName(note)}`);
      return;
    }
    if (store.ui.keyboardMode) {
      // keyboard mode: the pads are 8 notes of a scale
      const note = 48 + track * 2;
      audioService.trigger(track, note, vel);
      this.heldNotes.set(track, note);
    } else {
      const note = this.defaultNoteFor(track);
      audioService.trigger(track, note, vel);
      this.heldNotes.set(track, note);
      if (this.status.playing || store.ui.recArm) this.recordLiveTrigger(track, note, vel);
    }
    col.classList.add('hit');
    setTimeout(() => col.classList.remove('hit'), 90);
    this.flashLed(track, true);
    // live recording: write the note into the pattern at the playhead
    this.invalidate();
  }

  private onPadUp(track: number) {
    this.flashLed(track, false);
    const note = this.heldNotes.get(track);
    if (note !== undefined) {
      audioService.release(track, note);
      this.heldNotes.delete(track);
    }
  }

  private lastFlash = new Map<number, number>();

  private flashLed(track: number, on: boolean) {
    const col = this.root.querySelector(`.pad-col[data-track="${track}"]`) as HTMLElement;
    if (!col) return;
    col.classList.toggle('playing', on);
    if (on) this.lastFlash.set(track, performance.now());
  }

  private defaultNoteFor(track: number): number {
    // percussion tracks sit low, melodic tracks in the middle octave
    const p = this.store.trackParams(track);
    if (p.engine === 'sample') return 60;
    return p.engine === 'fm' ? 48 : 48;
  }

  private recordLiveTrigger(track: number, note: number, vel: number) {
    const store = this.store;
    if (!store.ui.recArm) return;
    const step = this.status.steps[track] ?? store.ui.cursor;
    store.update(() => {
      const s = store.pattern.tracks[track].steps[step];
      s.on = true;
      s.note = note;
      s.vel = vel;
      s.len = 0.6;
    });
    this.syncAudioPattern();
  }

  /* ------------------------------------------------------------------- nav --- */

  private onNav(dir: string) {
    const store = this.store;
    switch (dir) {
      case 'left':
        if (this.dialogs.open) {
          this.dialogs.close();
          this.invalidate();
          return;
        }
        this.cyclePage(-1);
        break;
      case 'right':
        this.cyclePage(1);
        break;
      case 'up':
        if (this.dialogs.open) {
          this.dialogs.move(-1);
        } else if (this.screen.kind === 'mode' && this.screen.name === 'FX') {
          const n = store.project.master.chain.length;
          store.ui.fxRow = ((store.ui.fxRow - 1) % n + n) % n;
        } else if (this.screen.kind === 'mode' && this.screen.name === 'SONG') {
          store.setSongCursor(store.ui.songCursor - 1);
        } else {
          store.setCursor(store.ui.cursor - 1);
        }
        break;
      case 'down':
        if (this.dialogs.open) {
          this.dialogs.move(1);
        } else if (this.screen.kind === 'mode' && this.screen.name === 'FX') {
          store.ui.fxRow = (store.ui.fxRow + 1) % store.project.master.chain.length;
        } else if (this.screen.kind === 'mode' && this.screen.name === 'SONG') {
          store.setSongCursor(store.ui.songCursor + 1);
        } else {
          store.setCursor(store.ui.cursor + 1);
        }
        break;
      case 'center':
        if (this.dialogs.open) {
          this.dialogs.select();
        } else {
          this.onCenter();
        }
        break;
    }
    this.invalidate();
  }

  private onCenter() {
    const store = this.store;
    if (this.screen.kind === 'mode') {
      switch (this.screen.name) {
        case 'PATTERN':
          // hardware behaviour: the center button opens the trig editor for the cursor
          this.openStepEditor();
          break;
        case 'KIT':
          this.openEnginePicker(store.trackIndex);
          break;
        case 'SONG':
          this.openSongDialog();
          break;
        case 'MIX':
          store.update(() => {
            const p = store.track;
            p.mute = !p.mute;
          });
          this.pushTrackParams(store.trackIndex);
          break;
        default:
          break;
      }
      return;
    }
    const page = this.screen.page;
    if (page === 'sample') {
      this.openSamplePicker();
    } else if (page === 'sound') {
      this.openPresetPicker();
    }
  }

  private onValueKnob(delta: number, fine: boolean) {
    if (this.dialogs.open) {
      if (Math.abs(delta) >= 0.5) this.dialogs.move(delta > 0 ? 1 : -1);
      return;
    }
    const store = this.store;
    const mode = this.screen.kind === 'mode' ? this.screen.name : null;
    if (mode === 'PATTERN' || mode === 'KIT') {
      // value knob = fine edit of the currently focused encoder parameter
      this.editFocused(delta, fine);
      return;
    }
    if (mode === 'MIX') {
      const key = (['volume', 'pan', 'mute', 'solo'] as const)[store.ui.knobFocus % 4];
      const target = store.track;
      const cur = key === 'mute' ? (target.mute ? 1 : 0) : key === 'solo' ? (target.solo ? 1 : 0) : getNorm(target, key);
      const next = cur + delta * (fine ? 0.005 : 0.03);
      store.update(() => {
        if (key === 'mute') target.mute = next > 0.5;
        else if (key === 'solo') target.solo = next > 0.5;
        else setNorm(target, key, next);
      }, { undo: false });
      this.pushPushMix();
      this.invalidate();
      return;
    }
    // SONG page: the value encoder scrubs the arrangement like a hardware track list
    if (mode === 'SONG') {
      if (Math.abs(delta) >= 0.5) {
        store.setSongCursor(store.ui.songCursor + (delta > 0 ? 1 : -1));
      }
      return;
    }
    // parameter pages: value knob also edits the focused param (hardware behaviour)
    this.editFocused(delta, fine);
  }

  private pushPushMix() {
    const t = this.store.trackIndex;
    const p = this.store.trackParams(t);
    audioService.setParam(t, 'volume', p.volume);
    audioService.setParam(t, 'pan', p.pan);
    audioService.setParam(t, 'mute', p.mute ? 1 : 0);
  }

  private selectMode(mode: string) {
    this.screen = { kind: 'mode', name: mode as 'PATTERN' };
    this.root.querySelectorAll('.mode').forEach((b) => {
      const isOn = (b as HTMLElement).dataset.mode === mode;
      b.classList.toggle('active', isOn);
      (b.querySelector('.led') as HTMLElement)?.classList.toggle('on', isOn);
    });
    this.store.ui.page = 'sound';
    this.invalidate();
  }

  private setParamPage(page: PageId) {
    this.screen = { kind: 'page', page };
    this.root.querySelectorAll('.mode').forEach((b) => {
      b.classList.remove('active');
      (b.querySelector('.led') as HTMLElement)?.classList.remove('on');
    });
    this.invalidate();
  }

  /* ---------------------------------------------------------------- dialogs --- */

  private openEnginePicker(track: number) {
    const p = this.store.trackParams(track);
    const pick = (engine: EngineKind) => {
      this.store.setEngine(track, engine);
      this.pushTrackParams(track);
      this.dialogs.close();
      this.toast(`TRK ${track + 1} = ${engine.toUpperCase()}`);
    };
    this.dialogs.show({
      title: `TRACK ${track + 1} ENGINE`,
      items: [
        { label: 'FM ENGINE', meta: '4-OP · 8 ALGOS', selected: p.engine === 'fm', action: () => pick('fm') },
        { label: 'MONO ENGINE', meta: '8 DIGITAL MODELS', selected: p.engine === 'mono', action: () => pick('mono') },
        { label: 'SAMPLE ENGINE', meta: 'WAV / MP3', selected: p.engine === 'sample', action: () => pick('sample') },
      ],
    }, p.engine === 'fm' ? 0 : p.engine === 'mono' ? 1 : 2);
  }

  private openPresetPicker() {
    const p = this.store.track;
    const isFM = p.engine === 'fm';
    const isSample = p.engine === 'sample';
    if (isSample) {
      this.openSamplePicker();
      return;
    }
    const items = isFM
      ? FM_PRESETS.map((pr) => ({
        label: pr.name,
        meta: 'FM',
        action: () => {
          this.store.update(() => applyFMPreset(this.store.track, pr.name));
          this.pushTrackParams(this.store.trackIndex);
          this.dialogs.close();
          this.toast(`PRESET ${pr.name}`);
        },
      }))
      : MONO_PRESETS.map((pr) => ({
        label: pr.name,
        meta: pr.params.engine?.toUpperCase() ?? 'MONO',
        action: () => {
          this.store.update(() => {
            const t = this.store.track;
            Object.assign(t.mono, pr.params);
            if (pr.amp) Object.assign(t.amp, pr.amp);
            if (pr.filter) Object.assign(t.filter, pr.filter);
            t.engine = 'mono';
          });
          this.pushTrackParams(this.store.trackIndex);
          this.dialogs.close();
          this.toast(`PRESET ${pr.name}`);
        },
      }));
    this.dialogs.show({ title: isFM ? 'FM PRESETS' : 'MONO PRESETS', items });
  }

  private openSamplePicker() {
    const items: { label: string; meta?: string; selected?: boolean; action: () => void }[] = [
      {
        label: 'IMPORT AUDIO FROM FILES',
        meta: 'WAV / MP3',
        action: () => {
          this.dialogs.close();
          this.fileTarget = 'sample';
          this.q<HTMLInputElement>('#file-input').click();
        },
      },
    ];
    for (const s of this.samples) {
      const isFactory = s.meta.id.startsWith('factory-');
      items.push({
        label: s.meta.name,
        meta: `${(s.meta.frames / s.meta.sampleRate).toFixed(2)}S ${isFactory ? 'FACTORY' : 'USER'}`,
        selected: this.store.track.sample.sampleId === s.meta.id,
        action: () => {
          this.store.update(() => {
            this.store.track.sample.sampleId = s.meta.id;
            this.store.track.engine = 'sample';
          });
          audioService.sendSample(s);
          this.pushTrackParams(this.store.trackIndex);
          this.dialogs.close();
          this.toast(`SAMPLE ${s.meta.name}`);
        },
      });
    }
    this.dialogs.show({ title: 'SAMPLE BROWSER', items });
  }

  private openSongDialog() {
    const items = this.store.song.steps.map((s, i) => ({
      label: `STEP ${i + 1} — PATTERN ${s.pattern + 1}`,
      meta: `x${s.repeats}`,
      action: () => {
        this.store.update(() => {
          s.repeats = s.repeats >= 8 ? 1 : s.repeats + 1;
        });
        this.dialogs.update(this.buildSongDialog());
      },
    }));
    items.push({
      label: 'ADD ARRANGEMENT STEP',
      meta: '+',
      action: () => {
        this.store.update(() => {
          this.store.song.steps.push({ pattern: this.store.project.currentPattern, repeats: 1 });
        });
        this.dialogs.update(this.buildSongDialog());
      },
    });
    items.push({
      label: 'TOGGLE CHAIN LOOP',
      meta: this.store.project.chainLoop ? 'ON' : 'OFF',
      action: () => {
        this.store.update(() => {
          this.store.project.chainLoop = !this.store.project.chainLoop;
        });
        this.dialogs.close();
      },
    });
    this.dialogs.show(this.buildSongDialog());
  }

  private buildSongDialog(): DialogModel {
    return {
      title: 'SONG ARRANGEMENT',
      items: this.store.song.steps.map((s, i) => ({
        label: `STEP ${i + 1} — PATTERN ${s.pattern + 1}`,
        meta: `x${s.repeats} · TAP TO CHANGE`,
        action: () => {
          this.store.update(() => {
            s.repeats = s.repeats >= 8 ? 1 : s.repeats + 1;
          });
          this.dialogs.update(this.buildSongDialog());
        },
      })).concat([
        {
          label: 'ADD ARRANGEMENT STEP',
          meta: '+',
          action: () => {
            this.store.update(() => {
              this.store.song.steps.push({ pattern: this.store.project.currentPattern, repeats: 1 });
            });
            this.dialogs.update(this.buildSongDialog());
          },
        },
        {
          label: 'CHAIN LOOP',
          meta: this.store.project.chainLoop ? 'ON' : 'OFF',
          action: () => {
            this.store.update(() => {
              this.store.project.chainLoop = !this.store.project.chainLoop;
            });
            this.dialogs.update(this.buildSongDialog());
          },
        },
      ]),
    };
  }

  private openExportDialog() {
    const bars = (n: number) => this.store.pattern.tempo;
    const items = [
      { label: 'MASTER MIX — 2 BARS', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(2, 'mix') },
      { label: 'MASTER MIX — 4 BARS', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(4, 'mix') },
      { label: 'MASTER MIX — 8 BARS', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(8, 'mix') },
      { label: 'MASTER MIX — WHOLE SONG', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(0, 'song') },
      { label: 'INDIVIDUAL TRACKS — 2 BARS', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(2, 'tracks') },
      { label: 'CURRENT TRACK — 2 BARS', meta: this.exportFormat.toUpperCase(), action: () => void this.runExport(2, 'current') },
    ];
    void bars;
    this.dialogs.show({ title: `EXPORT (${this.exportFormat.toUpperCase()})`, items });
  }

  /* ----------------------------------------------------------------- export --- */

  private async runExport(bars: number, scope: 'mix' | 'tracks' | 'current' | 'song') {
    this.dialogs.close();
    const opts: ExportOptions = {
      bars,
      scope,
      format: this.exportFormat,
      includeTail: true,
      trackIndex: this.store.trackIndex,
    };
    this.store.ui.exporting = { active: true, label: 'RENDERING…', progress: 0 };
    this.invalidate();
    try {
      const files = await exportMix({
        project: this.store.project,
        samples: this.samples,
        opts,
        onProgress: (p, label) => {
          this.store.ui.exporting = { active: true, label, progress: p };
          this.invalidate();
        },
      });
      for (const f of files) {
        storage.downloadBlob(f.blob, f.name);
      }
      this.toast(`EXPORTED ${files.length} FILE${files.length > 1 ? 'S' : ''}`);
    } catch (err) {
      this.toast(`EXPORT FAILED: ${String(err).slice(0, 40)}`);
    } finally {
      this.store.ui.exporting = null;
      this.invalidate();
    }
  }

  private download(left: Float32Array, right: Float32Array, tag: string) {
    const n = normalizeChannels(left, right);
    const wav = encodeWav(n.left, n.right, 44100, 16);
    storage.downloadBlob(new Blob([wav], { type: 'audio/wav' }), `groovebox-${tag}-${Date.now()}.wav`);
  }

  /* ------------------------------------------------------------------ import --- */

  private async importFile(file: File) {
    try {
      const buf = await file.arrayBuffer();
      let left: Float32Array;
      let right: Float32Array | null = null;
      let sampleRate = 44100;
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 20).toUpperCase();
      if (/\.wav$/i.test(file.name) || file.name === '') {
        const dec = decodeWav(buf);
        left = dec.left;
        right = dec.right;
        sampleRate = dec.sampleRate;
      } else {
        // mp3 / m4a / aiff: let the browser decode it (iOS supports MP3 natively)
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        left = decoded.getChannelData(0).slice();
        right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1).slice() : null;
        sampleRate = decoded.sampleRate;
        void ctx.close();
      }
      if (sampleRate !== 44100) {
        // resample to the engine rate with a simple linear resampler
        const ratio = 44100 / sampleRate;
        left = resample(left, ratio);
        if (right) right = resample(right, ratio);
      }
      const id = `user-${Date.now().toString(36)}`;
      const data = makeSample(id, name, left, right, 44100);
      this.samples.push(data);
      this.store.addSampleMeta(data.meta);
      await storage.saveSample({ meta: data.meta, left, right });
      audioService.sendSample(data);
      this.store.update(() => {
        this.store.track.sample.sampleId = id;
        this.store.track.engine = 'sample';
      });
      this.pushTrackParams(this.store.trackIndex);
      this.toast(`IMPORTED ${name}`);
    } catch (err) {
      this.toast(`IMPORT FAILED: ${String(err).slice(0, 36)}`);
    }
  }

  /* -------------------------------------------------------------- functions --- */

  private onFunction(fn: string, btn: HTMLElement) {
    const store = this.store;
    switch (fn) {
      case 'undo':
        store.undo();
        this.syncAll();
        break;
      case 'redo':
        store.redo();
        this.syncAll();
        break;
      case 'clear-step':
        store.update(() => {
          const s = store.currentStep();
          s.on = false;
          s.locks = {};
          s.cond = 'ALWAYS';
        });
        this.syncAudioPattern();
        this.toast('STEP CLEARED');
        break;
      case 'copy':
        store.copyPattern();
        this.syncAudioPattern();
        break;
      case 'random':
        store.randomize('steps', 0.35);
        this.syncAudioPattern();
        this.toast('RHYTHM RANDOMISED');
        break;
      case 'motion':
        store.toggleMotionMode();
        btn.classList.toggle('active', store.ui.motionMode);
        break;
      case 'locks':
        store.togglePLockMode();
        btn.classList.toggle('active', store.ui.pLockMode);
        break;
      case 'save':
        void this.saveAs();
        break;
      case 'load':
        void this.openProjects();
        break;
      case 'export':
        this.openExportDialog();
        break;
      case 'help':
        this.openHelp();
        break;
      case 'info':
        this.openInfo();
        break;
      default:
        break;
    }
    this.invalidate();
  }

  private openHelp() {
    this.dialogs.show({
      title: 'HYBRID GROOVEBOX — HELP',
      items: [
        { label: '8 TRACKS · 3 ENGINES', meta: 'FM / MONO / SAMPLER' },
        { label: 'PADS', meta: 'select track, tap to play a note' },
        { label: 'A B C D ENCODERS', meta: 'edit the 4 parameters of the page' },
        { label: 'PAGE ◀ ▶', meta: 'SOUND FILTER AMP LFO FX MOD' },
        { label: 'P/LOCK (◎)', meta: 'encoder edits lock to current step' },
        { label: 'MOTION (∿)', meta: 'encoder edits record automation' },
        { label: 'LIVE REC', meta: 'pad hits write into the pattern' },
        { label: 'PATTERN long-press', meta: 'fill switch for FILL trigs' },
        { label: 'VALUE', meta: 'fine edit · tempo · scroll lists' },
        { label: 'REC', meta: 'record the master output' },
        { label: 'SELECT', meta: 'export dialog · WAV / MP3' },
        { label: 'TAP ♩', meta: 'tap tempo' },
      ],
      hint: 'TAP TO DISMISS · ◀ TO CLOSE',
    });
  }

  private openInfo() {
    this.dialogs.show({
      title: 'SYSTEM INFO',
      items: [
        { label: 'AUDIO HOST', meta: this.status.host },
        { label: 'SAMPLE RATE', meta: `${audioService.sampleRate} HZ` },
        { label: 'ENGINE', meta: `${audioService.mode === 'worklet' ? 'WORKLET' : 'MAIN'} · 8 TRK` },
        { label: 'SAMPLES', meta: `${this.samples.length} IN POOL` },
        { label: 'PATTERNS', meta: `${this.store.project.patterns.length}` },
        { label: 'PROJECT', meta: this.store.project.name },
        { label: 'ENGINE VOICES', meta: `${AudioEngine.MAX_VOICES} / TRACK` },
        { label: 'VERSION', meta: '1.0.0' },
      ],
      hint: 'TAP TO DISMISS',
    });
  }

  private async saveAs() {
    const stamp = new Date().toLocaleTimeString().replace(/:/g, '');
    this.store.project.name = `PROJECT ${stamp}`;
    await storage.saveProject(this.store.project, `slot-${Date.now()}`);
    this.toast('PROJECT SAVED');
  }

  private async openProjects() {
    const list = await storage.listProjects();
    const items = [
      {
        label: 'SAVE CURRENT PROJECT',
        meta: 'NEW SLOT',
        action: () => void this.saveAs(),
      },
    ];
    for (const p of list) {
      items.push({
        label: p.name,
        meta: new Date(p.savedAt).toLocaleString(),
        action: () => {
          void (async () => {
            const proj = await storage.loadProject(p.slot);
            if (!proj) {
              this.toast('LOAD FAILED');
              return;
            }
            this.store.mergeProject(proj);
            this.syncAll();
            this.dialogs.close();
            this.toast('PROJECT LOADED');
          })();
        },
      });
    }
    this.dialogs.show({ title: 'PROJECTS', items });
  }

  /* ------------------------------------------------------------------- sync --- */

  private syncAudioPattern() {
    const p = this.store.project;
    audioService.setPattern(this.store.pattern, {
      chain: p.chain,
      chainLoop: p.chainLoop,
      songMode: this.screen.kind === 'mode' && this.screen.name === 'SONG' && this.store.ui.playing,
    });
    audioService.setTempo(this.store.pattern.tempo);
    audioService.setSwing(this.store.pattern.swing);
  }

  private syncAll() {
    audioService.setPattern(this.store.pattern);
    audioService.setKit(this.store.kit);
    audioService.setTempo(this.store.pattern.tempo);
    audioService.setSwing(this.store.pattern.swing);
    this.applySolo();
    this.invalidate();
  }

  /* -------------------------------------------------------------- rendering --- */

  private invalidate() {
    this.render();
  }

  private render() {
    const store = this.store;
    drawScreen(this.lcd, store, this.status, this.effectiveScreen());
    if (store.ui.exporting) this.drawExportOverlay();
    this.lcd.present();
    this.syncLeds();
    this.syncLabels();
    for (const fn of this.knobLabelSync) fn();
    this.syncToast();
  }

  private drawExportOverlay() {
    const e = this.store.ui.exporting!;
    const lcd = this.lcd;
    lcd.clear();
    lcd.fillRect(0, 0, 192, 9);
    lcd.text(2, 1, 'EXPORT', { inverse: true });
    lcd.text(2, 20, e.label.slice(0, 24));
    lcd.valueBar(2, 34, 188, e.progress, { h: 9 });
    lcd.text(2, 50, `${Math.round(e.progress * 100)}%`);
    lcd.text(2, 64, this.exportFormat === 'mp3' ? 'MP3 VIA LAME' : 'WAV 16BIT 44.1K');
    lcd.text(2, 74, 'SAVE TO FILES WHEN DONE');
  }

  private syncLeds() {
    const store = this.store;
    // pads
    for (let t = 0; t < 8; t++) {
      const col = this.root.querySelector(`.pad-col[data-track="${t}"]`) as HTMLElement;
      if (!col) continue;
      const p = store.trackParams(t);
      col.classList.toggle('active', t === store.trackIndex);
      col.classList.toggle('muted', p.mute);
      const playing = this.status.playing && this.status.steps[t] !== undefined;
      col.classList.toggle('playing', playing && (this.status.trackMeters[t] ?? 0) > 0.004);
    }
    this.q('#btn-mute').classList.toggle('active', store.track.mute);
    this.q('#btn-solo').classList.toggle('active', store.track.solo);
    (this.q('#btn-solo').querySelector('.led') as HTMLElement)?.classList.toggle('on', store.track.solo);
    (this.q('#btn-mute').querySelector('.led') as HTMLElement)?.classList.toggle('on', store.track.mute);
    this.q('#btn-play').classList.toggle('active', this.status.playing);
    (this.q('#btn-play').querySelector('.led') as HTMLElement)?.classList.toggle('on', this.status.playing);
    this.q('#btn-live-rec').classList.toggle('active', store.ui.recArm);
    (this.q('#btn-live-rec').querySelector('.led') as HTMLElement)?.classList.toggle('on', store.ui.recArm);
    this.q('#btn-rec').classList.toggle('active', this.status.recActive);
    (this.q('#btn-rec').querySelector('.led') as HTMLElement)?.classList.toggle('on', this.status.recActive);
    this.q('#btn-rec').classList.toggle('blink', this.status.recActive);
    (this.q('#btn-format').querySelector('.led') as HTMLElement)?.classList.toggle('on', this.exportFormat === 'mp3');
    // function LEDs
    this.root.querySelectorAll<HTMLElement>('[data-fn]').forEach((b) => {
      const fn = b.dataset.fn;
      if (fn === 'motion') b.classList.toggle('active', store.ui.motionMode);
      if (fn === 'locks') b.classList.toggle('active', store.ui.pLockMode);
    });
    // knob positions
    const keys = this.currentKnobs();
    ['a', 'b', 'c', 'd'].forEach((id, i) => {
      const el = this.root.querySelector(`.pknob[data-knob="${id}"] .knob`) as HTMLElement;
      const key = keys[i];
      const norm = key ? this.virtualNorm(key) : 0.5;
      if (el && key) setKnobAngle(el, norm);
      else if (el) setKnobAngle(el, 0.5);
      const wrap = this.root.querySelector(`.pknob[data-knob="${id}"]`) as HTMLElement;
      wrap?.classList.toggle('editing', i === store.ui.knobFocus);
    });
    setKnobAngle(this.q('#value-knob'), Math.min(1, Math.max(0, (store.pattern.tempo - 30) / 270)));
    setKnobAngle(this.q('[data-knob="send"]'), store.track.sendA);
    setKnobAngle(this.q('[data-knob="master"]'), store.project.master.volume);
  }

  /** Current normalised value of a knob target (track param or virtual key). */
  private virtualNorm(key: string): number {
    const store = this.store;
    const p = store.track;
    switch (key) {
      case 'mute': return p.mute ? 1 : 0;
      case 'solo': return p.solo ? 1 : 0;
      case 'masterVol': return store.project.master.volume;
      case 'lcdTheme': return this.lcd.themeName === 'dark' ? 1 : 0;
      case 'clockTempo': return (store.pattern.tempo - 30) / 270;
      case 'click': return store.project.settings.click ? 1 : 0;
      case 'fxChainToggle': return store.project.master.chain[store.ui.fxRow]?.on ? 1 : 0;
      case 'fxChainMix': return store.project.master.chain[store.ui.fxRow]?.mix ?? 0.5;
      case 'songAdd': return 0;
      case 'songDelete': return 0;
      case 'songRepeats': return (store.song.steps[store.ui.songCursor]?.repeats ?? 1) / 16;
      case 'songPattern': return (store.song.steps[store.ui.songCursor]?.pattern ?? 0) / 16;
      case 'masterWidth': return store.project.master.width / 2;
      case 'masterDrive': return store.project.master.drive;
      default: return getNorm(store.track, key);
    }
  }

  private syncLabels() {
    const store = this.store;
    this.q('#val-length').textContent = String(store.pattern.length);
    this.q('#val-swing').textContent = `${Math.round(store.pattern.swing * 100 + 50)}%`;
    const speedNames = ['1:1', '1:2', '1:3', '1:4'];
    this.q('#val-speed').textContent = speedNames[store.trackPattern.speed - 1] ?? '1:1';
  }

  private lastToastAt = 0;

  private syncToast() {
    const el = this.q('#toast');
    if (this.store.ui.toast && Date.now() - this.store.ui.toastAt < 2200) {
      el.textContent = this.store.ui.toast;
      el.classList.add('show');
      this.lastToastAt = Date.now();
    } else if (Date.now() - this.lastToastAt > 2200) {
      el.classList.remove('show');
    }
  }

  private toast(msg: string) {
    this.store.ui.toast = msg;
    this.store.ui.toastAt = Date.now();
    this.syncToast();
  }

  private onMeters(m: MeterMessage) {
    this.status.playing = m.playing;
    this.status.steps = m.stepAll;
    this.status.masterL = m.masterL;
    this.status.masterR = m.masterR;
    this.status.trackMeters = m.tracks;
    this.status.recFrames = m.recFrames;
    this.status.frames = m.frame;
    if (this.store.ui.playing !== m.playing) {
      this.store.ui.playing = m.playing;
    }
    // Song mode / pattern chaining change the pattern on the audio thread; mirror it here
    // so the LCD always shows what is actually playing. The store subscription only
    // repaints — it never pushes patterns back to the engine — so there is no feedback.
    if (typeof m.patternIndex === 'number' && m.patternIndex !== this.store.project.currentPattern) {
      this.store.project.currentPattern = m.patternIndex;
      this.toast(`PATTERN ${m.patternIndex + 1}`);
    }
    if (m.recFrames > 0) this.status.recActive = true;
  }

  private loop() {
    const tick = () => {
      if (!this.dialogs.open) {
        drawScreen(this.lcd, this.store, this.status, this.effectiveScreen());
        if (this.store.ui.exporting) this.drawExportOverlay();
        this.lcd.present();
        this.syncLeds();
      }
      this.syncToast();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/* ------------------------------------------------------------------ helpers --- */

/** Non-parameter keys used by the MIX / SETUP / FX screens. */
const VIRTUAL_KEYS = new Set([
  'mute', 'solo', 'masterVol', 'lcdTheme', 'clockTempo', 'click',
  'fxChainToggle', 'fxChainMix', 'masterWidth', 'masterDrive',
  'songAdd', 'songDelete', 'songRepeats', 'songPattern',
]);

const VIRTUAL_LABELS: Record<string, string> = {
  mute: 'MUTE', solo: 'SOLO', masterVol: 'MASTER', lcdTheme: 'LCD',
  clockTempo: 'TEMPO', click: 'CLICK', fxChainToggle: 'ON', fxChainMix: 'MIX',
  masterWidth: 'WIDTH', masterDrive: 'DRIVE',
  songAdd: 'ADD STEP', songDelete: 'DELETE', songRepeats: 'REPEATS', songPattern: 'PATTERN',
};

function readPath(obj: any, key: string): number {
  const parts = key.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return 0;
    cur = cur[p];
  }
  return typeof cur === 'number' ? cur : cur ? 1 : 0;
}

function resample(input: Float32Array, ratio: number): Float32Array {
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
