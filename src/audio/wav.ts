/**
 * WAV encoder — 16-bit PCM stereo (and 24/32-bit float for mastering exports).
 * Writes real RIFF headers, so files open in any DAW / on iPhone.
 */

export type WavBitDepth = 16 | 24 | 32;

export function encodeWav(
  left: Float32Array,
  right: Float32Array,
  sampleRate = 44100,
  bitDepth: WavBitDepth = 16,
): ArrayBuffer {
  const channels = 2;
  const frames = Math.min(left.length, right.length);
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);
  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  const format = bitDepth === 32 ? 3 : 1;
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = c === 0 ? left[i] : right[i];
      const x = v > 1 ? 1 : v < -1 ? -1 : v;
      if (bitDepth === 16) {
        dv.setInt16(o, Math.round(x * 32767), true);
        o += 2;
      } else if (bitDepth === 24) {
        const s = Math.round(x * 8388607);
        dv.setUint8(o, s & 0xff);
        dv.setUint8(o + 1, (s >> 8) & 0xff);
        dv.setUint8(o + 2, (s >> 16) & 0xff);
        o += 3;
      } else {
        dv.setFloat32(o, x, true);
        o += 4;
      }
    }
  }
  return buffer;
}

function writeStr(dv: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
}

/** Encode WAV from a blob-friendly Uint8Array. */
export function wavBytes(...args: Parameters<typeof encodeWav>): Uint8Array {
  return new Uint8Array(encodeWav(...args));
}

/** Simple normalisation helper for exports (peak to -0.5 dBFS by default). */
export function normalizeChannels(
  left: Float32Array,
  right: Float32Array,
  targetDb = -0.5,
): { left: Float32Array; right: Float32Array } {
  let peak = 1e-9;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]);
    if (a > peak) peak = a;
    const b = Math.abs(right[i]);
    if (b > peak) peak = b;
  }
  const target = Math.pow(10, targetDb / 20);
  const g = target / peak;
  const l = new Float32Array(left.length);
  const r = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) {
    l[i] = left[i] * g;
    r[i] = right[i] * g;
  }
  return { left: l, right: r };
}
