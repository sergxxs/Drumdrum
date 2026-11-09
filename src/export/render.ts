/**
 * Export engine.
 *
 * Renders the project offline through the *same* AudioEngine used live, so the file is
 * what you hear. Produces WAV (16-bit) or MP3 (LAME) and supports master mix, whole
 * song, individual tracks, or a single track.
 */
import { AudioEngine } from '../audio/engine';
import type { SampleData } from '../audio/sample';
import { buildFactorySamples } from '../audio/sample';
import { encodeWav, normalizeChannels } from '../audio/wav';
import { encodeMp3 } from '../audio/mp3';
import type { Project } from '../state/types';

export interface ExportOptions {
  /** bars to render (0 = whole song) */
  bars: number;
  scope: 'mix' | 'tracks' | 'current' | 'song';
  format: 'wav' | 'mp3';
  includeTail: boolean;
  trackIndex: number;
}

export interface ExportFile {
  name: string;
  blob: Blob;
}

export interface ExportRequest {
  project: Project;
  samples: SampleData[];
  opts: ExportOptions;
  onProgress?: (progress: number, label: string) => void;
}

/** Seconds per bar for the current pattern. */
export function barSeconds(project: Project): number {
  const pat = project.patterns[project.currentPattern];
  return (60 / pat.tempo) * 4;
}

export async function exportMix(req: ExportRequest): Promise<ExportFile[]> {
  const { project, samples, opts, onProgress } = req;
  const bar = barSeconds(project);
  const tail = opts.includeTail ? 2.5 : 0.2;
  let seconds = opts.bars > 0 ? bar * opts.bars + tail : 0;
  if (opts.scope === 'song') {
    const song = project.songs[project.currentSong];
    const steps = song?.steps?.length ? song.steps : project.chain.map((p) => ({ pattern: p, repeats: 1 }));
    const total = steps.reduce((a, s) => a + s.repeats, 0);
    seconds = bar * total + tail;
  }
  const files: ExportFile[] = [];
  const stamp = Date.now().toString(36);

  if (opts.scope === 'mix' || opts.scope === 'song') {
    onProgress?.(0.05, 'RENDERING MIX');
    const engine = makeEngine(project, samples);
    if (opts.scope === 'song') applySong(engine, project);
    engine.play();
    const rendered = renderInChunks(engine, seconds, (p) => onProgress?.(0.05 + p * 0.6, 'RENDERING MIX'));
    onProgress?.(0.7, opts.format === 'mp3' ? 'ENCODING MP3' : 'WRITING WAV');
    const blob = await encode(rendered.left, rendered.right, opts.format, (p) =>
      onProgress?.(0.7 + p * 0.28, opts.format === 'mp3' ? 'ENCODING MP3' : 'WRITING WAV'));
    files.push({ name: `groovebox-mix-${stamp}.${opts.format}`, blob });
    onProgress?.(1, 'DONE');
    return files;
  }

  if (opts.scope === 'current') {
    const engine = makeEngine(project, samples);
    muteAllBut(engine, opts.trackIndex);
    engine.play();
    const rendered = renderInChunks(engine, seconds, (p) => onProgress?.(p * 0.6, 'RENDERING TRACK'));
    const blob = await encode(rendered.left, rendered.right, opts.format,
      (p) => onProgress?.(0.6 + p * 0.38, 'ENCODING'));
    files.push({
      name: `groovebox-track${opts.trackIndex + 1}-${stamp}.${opts.format}`,
      blob,
    });
    onProgress?.(1, 'DONE');
    return files;
  }

  // individual tracks: one file per track, muted afterwards, no master FX tail overlap
  for (let t = 0; t < 8; t++) {
    const label = `TRACK ${t + 1}/${8}`;
    onProgress?.(t / 8, `RENDERING ${label}`);
    const engine = makeEngine(project, samples);
    muteAllBut(engine, t);
    engine.play();
    const rendered = renderInChunks(engine, seconds, (p) => onProgress?.((t + p * 0.8) / 8, `RENDERING ${label}`));
    const blob = await encode(rendered.left, rendered.right, opts.format,
      (p) => onProgress?.((t + 0.8 + p * 0.2) / 8, `ENCODING ${label}`));
    files.push({ name: `groovebox-track${t + 1}-${stamp}.${opts.format}`, blob });
  }
  onProgress?.(1, 'DONE');
  return files;
}

function makeEngine(project: Project, samples: SampleData[]): AudioEngine {
  const engine = new AudioEngine(structuredClone(project), { sampleRate: 44100, blockSize: 256 });
  const pool = samples.length ? samples : buildFactorySamples(44100);
  for (const s of pool) engine.bank.set(s);
  return engine;
}

function muteAllBut(engine: AudioEngine, keep: number) {
  for (let t = 0; t < 8; t++) {
    engine.kit.tracks[t].params.mute = t !== keep;
    engine.tracks[t].params = engine.kit.tracks[t].params;
  }
  engine.setKit(engine.kit);
}

function applySong(engine: AudioEngine, project: Project) {
  // Song playback: chain patterns sequentially by swapping patterns at the transport
  // level. The renderer calls `engine.seq.onPatternEnd` to advance.
  const song = project.songs[project.currentSong];
  const steps = song?.steps?.length ? song.steps : project.chain.map((p) => ({ pattern: p, repeats: 1 }));
  let stepIndex = 0;
  let repeat = 0;
  engine.seq.onPatternEnd = () => {
    const step = steps[stepIndex % steps.length];
    repeat++;
    if (repeat >= step.repeats) {
      repeat = 0;
      stepIndex++;
      const next = steps[stepIndex % steps.length];
      engine.setPattern(project.patterns[next.pattern]);
    }
  };
}

function renderInChunks(
  engine: AudioEngine,
  seconds: number,
  onProgress?: (p: number) => void,
): { left: Float32Array; right: Float32Array } {
  const sr = engine.sr;
  const total = Math.max(16, Math.round(seconds * sr));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const block = 512;
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let written = 0;
  let lastReport = -1;
  while (written < total) {
    const n = Math.min(block, total - written);
    bl.fill(0);
    br.fill(0);
    engine.processInto(bl, br, n);
    left.set(n === block ? bl : bl.subarray(0, n), written);
    right.set(n === block ? br : br.subarray(0, n), written);
    written += n;
    const p = written / total;
    if (onProgress && Math.floor(p * 20) !== lastReport) {
      lastReport = Math.floor(p * 20);
      onProgress(p);
    }
  }
  return { left, right };
}

async function encode(
  left: Float32Array,
  right: Float32Array,
  format: 'wav' | 'mp3',
  onProgress?: (p: number) => void,
): Promise<Blob> {
  const norm = normalizeChannels(left, right, -0.4);
  if (format === 'wav') {
    const buf = encodeWav(norm.left, norm.right, 44100, 16);
    onProgress?.(1);
    return new Blob([buf], { type: 'audio/wav' });
  }
  return encodeMp3(norm.left, norm.right, 44100, 192, onProgress);
}
