/**
 * MP3 encoding via the vendored LAME port (public-domain LAME algorithm, JS port by
 * Alex Zhukov, LGPL). Loaded lazily so it never costs anything until you actually
 * export an MP3.
 *
 * Limitation (documented in the UI): encoding runs on the main thread and is roughly
 * 5-10x faster than realtime, so a 30 s export takes a few seconds with a progress UI.
 */
declare global {
  interface Window {
    lamejs?: {
      Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
        encodeBuffer: (l: Int16Array, r?: Int16Array) => Int8Array;
        flush: () => Int8Array;
      };
    };
  }
}

let loading: Promise<void> | null = null;

/** The encoder is pulled in from a classic script tag, so it lives on the global. */
function lameGlobal(): Window['lamejs'] | undefined {
  if (typeof window !== 'undefined' && window.lamejs) return window.lamejs;
  const g = globalThis as unknown as { lamejs?: Window['lamejs'] };
  return g.lamejs;
}

export function loadLame(): Promise<void> {
  if (lameGlobal()) return Promise.resolve();
  if (loading) return loading;
  // No DOM (tests, offline tooling): fail with a clear message instead of throwing on
  // `window`, and let callers fall back to WAV.
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('MP3 encoding needs a browser environment'));
  }
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './vendor/lame.all.js';
    s.async = true;
    s.onload = () => (lameGlobal() ? resolve() : reject(new Error('LAME failed to initialise')));
    s.onerror = () => reject(new Error('Could not load the MP3 encoder'));
    document.head.appendChild(s);
  });
  return loading;
}

function toInt16(buf: Float32Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] > 1 ? 1 : buf[i] < -1 ? -1 : buf[i];
    out[i] = Math.round(v * 32767);
  }
  return out;
}

/**
 * Encode interleaved stereo MP3. `onProgress` receives 0..1 so the UI can show a bar.
 */
export async function encodeMp3(
  left: Float32Array,
  right: Float32Array,
  sampleRate = 44100,
  kbps = 192,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  await loadLame();
  const lame = lameGlobal();
  if (!lame) throw new Error('MP3 encoder unavailable');
  const enc = new lame.Mp3Encoder(2, sampleRate, kbps);
  const frames = Math.min(left.length, right.length);
  const chunkFrames = 1152 * 16;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < frames; i += chunkFrames) {
    const n = Math.min(chunkFrames, frames - i);
    const l = toInt16(left.subarray(i, i + n));
    const r = toInt16(right.subarray(i, i + n));
    const buf = enc.encodeBuffer(l, r);
    if (buf.length > 0) chunks.push(new Uint8Array(buf.buffer ? buf.slice() : buf));
    onProgress?.(Math.min(1, (i + n) / frames));
    // yield so the UI stays responsive
    if ((i / chunkFrames) % 8 === 7) await new Promise((res) => setTimeout(res, 0));
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail.slice()));
  // Blob parts must be BlobPart; Int8Array views are fine but be explicit about copies
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

/** Estimate the encoded size for the UI (bytes). */
export function estimateMp3Size(frames: number, sampleRate: number, kbps: number): number {
  return Math.round((frames / sampleRate) * ((kbps * 1000) / 8));
}
