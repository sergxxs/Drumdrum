/**
 * Renders the factory project to a real audio file you can listen to.
 *
 *   npx vite-node scripts/demo-export.ts [out.mp3] [bars] [format]
 *
 * It goes through the exact export path the UI uses (offline render -> normalise ->
 * LAME / WAV), so this is the same audio you get from SELECT -> EXPORT.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { exportMix } from '../src/export/render';
import { buildFactorySamples } from '../src/audio/sample';
import { defaultProject } from '../src/state/presets';

const out = process.argv[2] ?? 'docs/demo/factory-pattern.mp3';
const bars = Number(process.argv[3] ?? 8);
const format = (process.argv[4] ?? 'mp3') as 'mp3' | 'wav';

// MP3 needs the vendored LAME port. In a browser it arrives via a <script> tag; here we
// evaluate the same file into a global object so the export path is identical.
const outFormat = format;
if (outFormat === 'mp3') {
  const src = readFileSync(new URL('../public/vendor/lame.all.js', import.meta.url), 'utf8');
  const sandbox: Record<string, unknown> = { globalThis: {}, window: {}, console, Math, Date };
  sandbox.self = sandbox.globalThis;
  createContext(sandbox);
  runInContext(src, sandbox);
  const lamejs = (sandbox as any).lamejs ?? (sandbox.globalThis as any)?.lamejs;
  if (!lamejs) throw new Error('could not initialise the LAME encoder');
  (globalThis as any).lamejs = lamejs;
}

const project = defaultProject();
const samples = buildFactorySamples(44100);

const files = await exportMix({
  project,
  samples,
  opts: { bars, scope: 'mix', format, includeTail: true, trackIndex: 0 },
  onProgress: (p, label) => process.stdout.write(`\r${label.padEnd(24)} ${Math.round(p * 100)}%`),
});
process.stdout.write('\n');

mkdirSync(dirname(out), { recursive: true });
const buf = Buffer.from(await files[0].blob.arrayBuffer());
writeFileSync(out, buf);
console.log(`${files[0].name} -> ${out} (${(buf.length / 1024).toFixed(0)} KB, ${bars} bars, ${format})`);
