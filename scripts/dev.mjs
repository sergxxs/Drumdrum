#!/usr/bin/env node
/**
 * Dev server: rebuild the worklet bundle before starting Vite, and rebuild it whenever
 * the audio engine sources change (so the running instrument always uses fresh DSP).
 */
import { createServer } from 'vite';
import { build } from 'vite';
import { watch } from 'node:fs';

async function buildWorklet() {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      lib: {
        entry: 'src/audio/worklet.entry.ts',
        formats: ['iife'],
        name: 'GrooveboxWorklet',
        fileName: () => 'worklet-bundle.js',
      },
      outDir: 'public',
      emptyOutDir: false,
      minify: false,
      target: 'es2020',
    },
  });
  console.log('[worklet] rebuilt');
}

await buildWorklet();

let timer = null;
watch('src/audio', { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => buildWorklet().catch((e) => console.error(e)), 250);
});

const server = await createServer({
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
await server.listen();
server.printUrls();
