/**
 * Verifies the real AudioWorklet bundle: loads public/worklet-bundle.js with the
 * WorkletGlobalScope globals stubbed, then drives `process()` like the browser would.
 *
 * This is the closest automated check to "does the instrument make sound in the browser",
 * because the worklet runs the identical AudioEngine.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { defaultProject } from '../src/state/presets';

interface Post {
  type: string;
  [k: string]: unknown;
}

let Processor: any;
let port: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: Post) => void };
let messages: Post[];

beforeAll(async () => {
  const path = 'public/worklet-bundle.js';
  expect(existsSync(path), 'run `npm run build:worklet` first').toBe(true);
  const code = readFileSync(path, 'utf8');
  messages = [];
  port = {
    onmessage: null,
    postMessage: (m: Post) => messages.push(m),
  };
  const g = globalThis as any;
  g.sampleRate = 44100;
  g.currentTime = 0;
  g.registerProcessor = (name: string, ctor: any) => {
    g.__registered = ctor;
    g.__registeredName = name;
  };
  g.AudioWorkletProcessor = class {
    port = port;
  };
  // eslint-disable-next-line no-new-func
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', code)(
    44100,
    g.AudioWorkletProcessor,
    g.registerProcessor,
  );
  Processor = g.__registered;
});

describe('AudioWorklet bundle', () => {
  it('registers the "groovebox" processor', () => {
    const g = globalThis as any;
    expect(g.__registeredName).toBe('groovebox');
    expect(typeof Processor).toBe('function');
  });

  it('renders silence before init and audio after', () => {
    const proc = new Processor();
    const out = [[new Float32Array(128), new Float32Array(128)]];
    proc.process([], out);
    expect(out[0][0].every((v) => v === 0)).toBe(true);

    const project = defaultProject();
    proc.port.onmessage!({ data: { type: 'init', project, samples: [], sampleIds: [] } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'play' } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'trigger', track: 0, note: 40, vel: 1 } } as MessageEvent);

    let energy = 0;
    for (let block = 0; block < 40; block++) {
      const frames = [[new Float32Array(128), new Float32Array(128)]];
      expect(proc.process([], frames)).toBe(true);
      for (let i = 0; i < 128; i++) energy += Math.abs(frames[0][0][i]);
    }
    expect(energy).toBeGreaterThan(0.5);
  });

  it('handles live parameter messages', () => {
    const proc = new Processor();
    proc.port.onmessage!({ data: { type: 'init', project: defaultProject(), samples: [], sampleIds: [] } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'param', track: 0, key: 'filter.cutoff', value: 400 } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'param', track: 0, key: 'fm.ops.0.level', value: 0.5 } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'trigger', track: 0, note: 40, vel: 1 } } as MessageEvent);
    const frames = [[new Float32Array(128), new Float32Array(128)]];
    proc.process([], frames);
    expect(Number.isFinite(frames[0][0][10])).toBe(true);
  });

  it('emits meter messages to the UI', () => {
    const proc = new Processor();
    proc.port.onmessage!({ data: { type: 'init', project: defaultProject(), samples: [], sampleIds: [] } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'play' } } as MessageEvent);
    for (let i = 0; i < 24; i++) {
      proc.process([], [[new Float32Array(128), new Float32Array(128)]]);
    }
    const meter = messages.filter((m) => m.type === 'meters');
    expect(meter.length).toBeGreaterThan(0);
    expect(Array.isArray(meter[0].tracks)).toBe(true);
    expect((meter[0].tracks as number[]).length).toBe(8);
  });

  it('stops cleanly', () => {
    const proc = new Processor();
    proc.port.onmessage!({ data: { type: 'init', project: defaultProject(), samples: [], sampleIds: [] } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'play' } } as MessageEvent);
    proc.port.onmessage!({ data: { type: 'stop' } } as MessageEvent);
    const frames = [[new Float32Array(128), new Float32Array(128)]];
    proc.process([], frames);
    expect(frames[0][0].every((v) => Number.isFinite(v))).toBe(true);
  });
});
