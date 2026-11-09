/**
 * AudioWorklet entry point.
 *
 * The synth engine is large and stateful, so it runs *inside* the worklet: the same
 * `AudioEngine` class that Node tests and the offline exporter use. The worklet receives
 * messages that only carry plain data (project/kit/pattern snapshots and parameter
 * paths), which keeps the audio thread free of DOM objects and structured-clone heavy
 * per-sample traffic.
 */
import { AudioEngine } from './engine';
import { buildFactorySamples } from './sample';
import { SR } from './dsp';
import type { Project } from '../state/types';
import type { AudioHostMessage, HostReply } from './hostProtocol';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: unknown): void;

class GrooveboxProcessor extends AudioWorkletProcessor {
  private engine: AudioEngine | null = null;
  private bl = new Float32Array(0);
  private br = new Float32Array(0);
  private blockCount = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<AudioHostMessage>) => this.handle(e.data);
    this.port.postMessage({ type: 'ready' } satisfies HostReply);
  }

  private reply(msg: HostReply) {
    this.port.postMessage(msg);
  }

  private handle(msg: AudioHostMessage) {
    switch (msg.type) {
      case 'init': {
        const project = msg.project as Project;
        this.engine = new AudioEngine(project, {
          sampleRate: typeof sampleRate === 'number' ? sampleRate : SR,
          blockSize: 256,
        });
        for (const s of buildFactorySamples(this.engine.sr)) this.engine.bank.set(s);
        // sample buffers arrive as transferable Float32Arrays
        for (const s of msg.samples) {
          this.engine.bank.set({ meta: s.meta, left: s.left, right: s.right ?? null });
        }
        this.engine.patternProvider = (i: number) => this.engine!.project!.patterns[i];
        this.engine.chain = project.chain.slice();
        this.engine.chainLoop = project.chainLoop;
        this.reply({ type: 'ready' });
        break;
      }
      case 'pattern': {
        this.engine?.setPattern(msg.pattern);
        break;
      }
      case 'kit': {
        this.engine?.setKit(msg.kit);
        break;
      }
      case 'tempo':
        this.engine?.setTempo(msg.tempo);
        break;
      case 'swing':
        this.engine?.setSwing(msg.swing);
        break;
      case 'play':
        this.engine?.play();
        break;
      case 'stop':
        this.engine?.stop();
        break;
      case 'trigger':
        this.engine?.trigger(msg.track, msg.note, msg.vel, msg.lengthFrames);
        break;
      case 'release':
        this.engine?.release(msg.track, msg.note);
        break;
      case 'param': {
        if (!this.engine) break;
        // live parameter edit: mutate the kit object the engine holds
        const track = this.engine.kit.tracks[msg.track];
        if (!track) break;
        setPath(track.params, msg.key, msg.value);
        break;
      }
      case 'master':
        if (this.engine) {
          Object.assign(this.engine.kit.master, msg.master);
          this.engine.configureMaster();
        }
        break;
      case 'sends':
        if (this.engine) {
          Object.assign(this.engine.kit.sends, msg.sends);
          this.engine.configureSends();
        }
        break;
      case 'fill':
        this.engine?.seq.setFill(msg.on);
        break;
      case 'click':
        if (this.engine) {
          this.engine.seq.clickEnabled = msg.on;
          this.engine.setClick(msg.on);
        }
        break;
      case 'recStart':
        this.engine?.startRecording();
        break;
      case 'recStop': {
        if (!this.engine) break;
        const rec = this.engine.stopRecording();
        this.port.postMessage(
          { type: 'recording', left: rec.left, right: rec.right, sampleRate: this.engine.sr },
          [rec.left.buffer, rec.right.buffer],
        );
        break;
      }
      case 'sample': {
        this.engine?.bank.set({ meta: msg.meta, left: msg.left, right: msg.right ?? null });
        break;
      }
      case 'sampleRemove':
        this.engine?.bank.delete(msg.id);
        break;
      case 'songMode':
        this.engine?.setSongMode(msg.on);
        break;
      case 'chain':
        if (this.engine) {
          this.engine.chain = msg.chain.slice();
          this.engine.chainLoop = msg.loop;
        }
        break;
      case 'patterns':
        if (this.engine) {
          const bank = msg.patterns;
          this.engine.patternProvider = (i: number) => bank[i] ?? bank[0];
        }
        break;
      default:
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    if (this.bl.length < n) {
      this.bl = new Float32Array(n);
      this.br = new Float32Array(n);
    }
    const l = this.bl.subarray(0, n);
    const r = this.br.subarray(0, n);
    if (this.engine) {
      this.engine.processInto(l, r, n);
    } else {
      l.fill(0);
      r.fill(0);
    }
    out[0].set(l);
    if (out.length > 1) out[1].set(r);
    // meters / playhead to UI at ~15 Hz
    if (++this.blockCount % 12 === 0 && this.engine) {
      const e = this.engine;
      this.reply({
        type: 'meters',
        tracks: e.meters.tracks.slice(),
        masterL: e.meters.masterL,
        masterR: e.meters.masterR,
        step: e.seq.currentStep(0),
        stepAll: Array.from({ length: 8 }, (_, i) => e.seq.currentStep(i)),
        playing: e.seq.playing,
        frame: e.frame,
        recFrames: e.recordedFrames,
      } as HostReply);
    }
    return true;
  }
}

function setPath(obj: any, key: string, value: unknown) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (!cur) return;
  }
  cur[parts[parts.length - 1]] = value;
}

registerProcessor('groovebox', GrooveboxProcessor);
