/**
 * AudioService — bridges the UI to the audio host.
 *
 * Primary path: AudioWorklet running the same AudioEngine as the tests/exporter.
 * Fallback: a ScriptProcessorNode running an AudioEngine on the main thread (used on
 * older WebKit builds where module worklets are unavailable, and in previews that block
 * worklet module loading). Both paths call `AudioEngine.processInto`, so the sound is
 * identical.
 */
import { AudioEngine } from './engine';
import { buildFactorySamples, SampleData } from './sample';
import type { AudioHostMessage, HostReply, MeterMessage, RecordingReply } from './hostProtocol';
import type { Kit, MasterParams, Pattern, Project, SendParams } from '../state/types';

export type AudioStatus = 'idle' | 'starting' | 'running' | 'error';
export type HostMode = 'worklet' | 'scriptprocessor';

export class AudioService {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | ScriptProcessorNode | null = null;
  mode: HostMode = 'worklet';
  status: AudioStatus = 'idle';
  lastError = '';
  private meters: MeterMessage | null = null;
  private onMeters: ((m: MeterMessage) => void) | null = null;
  /** main-thread engine used by the fallback host and by offline export */
  fallbackEngine: AudioEngine | null = null;
  private project: Project | null = null;
  private queuedSamples: SampleData[] = [];
  /** pending audio-recording request (resolved by the host's reply) */
  private recResolve: ((r: { left: Float32Array; right: Float32Array; sampleRate: number } | null) => void) | null = null;

  get sampleRate() {
    return this.ctx?.sampleRate ?? 44100;
  }

  onMeter(cb: (m: MeterMessage) => void) {
    this.onMeters = cb;
  }

  get latestMeters() {
    return this.meters;
  }

  /** Create the context. Must be called from a user gesture on iOS. */
  async unlock(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) {
        this.status = 'error';
        this.lastError = 'Web Audio is not available in this browser.';
        return;
      }
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        this.lastError = String(err);
      }
    }
    // iOS Safari sometimes reports 'running' one tick later
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Start audio for a project. Safe to call repeatedly (e.g. after the user taps PLAY).
   */
  async start(project: Project, samples: SampleData[]): Promise<boolean> {
    await this.unlock();
    if (!this.ctx) return false;
    this.project = project;
    this.queuedSamples = samples;
    if (this.node) {
      this.send({ type: 'kit', kit: project.kits[project.currentKit] });
      this.send({ type: 'pattern', pattern: project.patterns[project.currentPattern] });
      for (const s of samples) this.sendSample(s);
      return true;
    }
    const supportsWorklet = 'audioWorklet' in this.ctx && typeof AudioWorkletNode !== 'undefined';
    if (supportsWorklet) {
      try {
        await this.ctx.audioWorklet.addModule('./worklet-bundle.js');
        const node = new AudioWorkletNode(this.ctx, 'groovebox', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.port.onmessage = (e: MessageEvent<HostReply>) => {
          const data = e.data;
          if (data.type === 'recording') {
            const r = data as RecordingReply;
            this.recResolve?.({ left: r.left, right: r.right, sampleRate: r.sampleRate });
            this.recResolve = null;
          } else if (data.type === 'meters') {
            this.meters = data;
            this.onMeters?.(data);
          } else if (data.type === 'ready') {
            this.status = 'running';
          } else if (data.type === 'error') {
            this.lastError = data.message;
          }
        };
        node.onprocessorerror = () => {
          this.lastError = 'Audio processor crashed; falling back.';
          void this.startFallback(project, samples);
        };
        node.connect(this.ctx.destination);
        this.node = node;
        this.mode = 'worklet';
        this.status = 'running';
        const buffer = toTransfers(samples);
        this.send({
          type: 'init',
          project: structuredClone(project),
          samples: buffer.samples,
          sampleIds: buffer.samples.map((s) => s.meta.id),
        });
        return true;
      } catch (err) {
        this.lastError = String(err);
        // fall through to ScriptProcessor
      }
    }
    return this.startFallback(project, samples);
  }

  private startFallback(project: Project, samples: SampleData[]): boolean {
    if (!this.ctx) return false;
    if (this.node) {
      try {
        (this.node as AudioNode).disconnect();
      } catch { /* ignore */ }
      this.node = null;
    }
    const engine = new AudioEngine(structuredClone(project), {
      sampleRate: this.ctx.sampleRate,
    });
    const bankSamples = samples.length ? samples : buildFactorySamples(engine.sr);
    for (const s of bankSamples) engine.bank.set(s);
    this.fallbackEngine = engine;
    const bufferSize = 1024;
    const sp = this.ctx.createScriptProcessor(bufferSize, 0, 2);
    sp.onaudioprocess = (e) => {
      const out = e.outputBuffer;
      const l = out.getChannelData(0);
      const r = out.getChannelData(1);
      engine.processInto(l, r, l.length);
    };
    sp.connect(this.ctx.destination);
    this.node = sp;
    this.mode = 'scriptprocessor';
    this.status = 'running';
    // main-thread meters for the fallback
    let count = 0;
    const tick = () => {
      if (this.mode !== 'scriptprocessor' || !this.fallbackEngine) return;
      const e2 = this.fallbackEngine;
      count++;
      const m: MeterMessage = {
        type: 'meters',
        tracks: e2.meters.tracks.slice(),
        masterL: e2.meters.masterL,
        masterR: e2.meters.masterR,
        step: e2.seq.currentStep(0),
        stepAll: Array.from({ length: 8 }, (_, i) => e2.seq.currentStep(i)),
        pass: 0,
        playing: e2.seq.playing,
        frame: e2.frame,
        recFrames: e2.recordedFrames,
      };
      this.meters = m;
      this.onMeters?.(m);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  }

  /* ------------------------------------------------------------- commands --- */

  send(msg: AudioHostMessage) {
    if (this.mode === 'worklet' && this.node && 'port' in this.node) {
      (this.node as AudioWorkletNode).port.postMessage(msg);
    } else if (this.fallbackEngine) {
      applyToEngine(this.fallbackEngine, msg);
    }
  }

  sendSample(sample: SampleData) {
    if (this.mode === 'worklet' && this.node && 'port' in this.node) {
      const msg: AudioHostMessage = {
        type: 'sample',
        meta: sample.meta,
        left: sample.left,
        right: sample.right,
      };
      (this.node as AudioWorkletNode).port.postMessage(msg, [
        sample.left.buffer,
        ...(sample.right ? [sample.right.buffer] : []),
      ]);
    } else if (this.fallbackEngine) {
      this.fallbackEngine.bank.set(sample);
    }
  }

  /**
   * Send a pattern plus the chain/song configuration so the audio engine can advance
   * patterns by itself (song mode and pattern chaining run on the audio thread).
   */
  setPattern(p: Pattern, extra: { chain?: number[]; chainLoop?: boolean; songMode?: boolean } = {}) {
    this.send({ type: 'pattern', pattern: structuredClone(p) });
    if (extra.chain) this.send({ type: 'chain', chain: extra.chain, loop: extra.chainLoop ?? true });
    if (extra.songMode !== undefined) this.send({ type: 'songMode', on: extra.songMode });
  }

  setKit(k: Kit) {
    this.send({ type: 'kit', kit: structuredClone(k) });
  }

  setTempo(t: number) {
    this.send({ type: 'tempo', tempo: t });
  }

  setSwing(s: number) {
    this.send({ type: 'swing', swing: s });
  }

  play() {
    this.send({ type: 'play' });
  }

  stop() {
    this.send({ type: 'stop' });
  }

  trigger(track: number, note: number, vel: number, lengthMs?: number) {
    const len = lengthMs ? Math.round((lengthMs / 1000) * this.sampleRate) : undefined;
    this.send({ type: 'trigger', track, note, vel, lengthFrames: len });
  }

  release(track: number, note: number) {
    this.send({ type: 'release', track, note });
  }

  setParam(track: number, key: string, value: number) {
    this.send({ type: 'param', track, key, value });
  }

  setMaster(master: Partial<MasterParams>) {
    this.send({ type: 'master', master });
  }

  setSends(sends: Partial<SendParams>) {
    this.send({ type: 'sends', sends });
  }

  setClick(on: boolean) {
    this.send({ type: 'click', on });
  }

  setFill(on: boolean) {
    this.send({ type: 'fill', on });
  }

  startRecord() {
    this.send({ type: 'recStart' });
  }

  /**
   * Stop recording and return the captured master audio. Works with either host: the
   * worklet posts the PCM back as a transferable buffer, the fallback host returns its
   * own accumulated buffers directly.
   */
  async stopRecord(): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number } | null> {
    if (this.mode === 'worklet' && this.node && 'port' in this.node) {
      return new Promise((resolve) => {
        this.recResolve = resolve;
        this.send({ type: 'recStop' });
        // never leave the UI hanging if the processor died
        setTimeout(() => {
          if (this.recResolve === resolve) {
            this.recResolve = null;
            resolve(null);
          }
        }, 3000);
      });
    }
    if (this.fallbackEngine) {
      const rec = this.fallbackEngine.stopRecording();
      return { left: rec.left, right: rec.right, sampleRate: this.fallbackEngine.sr };
    }
    return null;
  }

  /** The engine that should be used for export (kept in sync with the live kit). */
  engineForExport(project: Project, samples: SampleData[]): AudioEngine {
    const engine = new AudioEngine(structuredClone(project), { sampleRate: this.sampleRate });
    for (const s of samples.length ? samples : buildFactorySamples(engine.sr)) engine.bank.set(s);
    return engine;
  }

  suspend() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }
}

/* ------------------------------------------------------------------ helpers --- */

function toTransfers(samples: SampleData[]) {
  // Copy so we never detach the UI's copies (the store still needs them for display).
  const copies = samples.map((s) => ({
    meta: s.meta,
    left: s.left.slice(),
    right: s.right ? s.right.slice() : null,
  }));
  return { samples: copies };
}

/** Apply a host message directly to a main-thread engine (fallback host). */
function applyToEngine(engine: AudioEngine, msg: AudioHostMessage) {
  switch (msg.type) {
    case 'pattern': engine.setPattern(msg.pattern); break;
    case 'kit': engine.setKit(msg.kit); break;
    case 'tempo': engine.setTempo(msg.tempo); break;
    case 'swing': engine.setSwing(msg.swing); break;
    case 'play': engine.play(); break;
    case 'stop': engine.stop(); break;
    case 'trigger': engine.trigger(msg.track, msg.note, msg.vel, msg.lengthFrames); break;
    case 'release': engine.release(msg.track, msg.note); break;
    case 'param': {
      const t = engine.kit.tracks[msg.track];
      if (t) {
        const parts = msg.key.split('.');
        let cur: any = t.params;
        for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
        cur[parts[parts.length - 1]] = msg.value;
      }
      break;
    }
    case 'master':
      Object.assign(engine.kit.master, msg.master);
      engine.configureMaster();
      break;
    case 'sends':
      Object.assign(engine.kit.sends, msg.sends);
      engine.configureSends();
      break;
    case 'fill': engine.seq.setFill(msg.on); break;
    case 'click': engine.setClick(msg.on); break;
    case 'songMode': engine.setSongMode(msg.on); break;
    case 'chain':
      engine.chain = msg.chain.slice();
      engine.chainLoop = msg.loop;
      break;
    case 'patterns':
      // full pattern bank for chaining / song mode
      engine.patternProvider = (i: number) => msg.patterns[i] ?? msg.patterns[0];
      break;
    case 'recStart': engine.startRecording(); break;
    case 'sample': engine.bank.set({ meta: msg.meta, left: msg.left, right: msg.right }); break;
    case 'sampleRemove': engine.bank.delete(msg.id); break;
    default: break;
  }
}

export const audioService = new AudioService();
