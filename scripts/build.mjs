#!/usr/bin/env node
/**
 * Build pipeline:
 *   1. bundle src/audio/worklet.entry.ts into public/worklet-bundle.js as an IIFE
 *   2. build the app with Vite
 * The worklet bundle must exist in `public/` before Vite copies it, and must be a
 * classic script (no import/export) for Safari's addModule().
 */
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const workletOnly = process.argv.includes('--worklet-only');

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
      rollupOptions: { output: { extend: false } },
    },
  });
  console.log('✓ worklet bundle -> public/worklet-bundle.js');
}

async function buildApp() {
  execFileSync('npx', ['tsc', '--noEmit'], { stdio: 'inherit' });
  await build({ logLevel: 'info' });
  console.log('✓ app built -> dist/');
}

await buildWorklet();
if (!workletOnly) {
  if (!existsSync('public/worklet-bundle.js')) throw new Error('worklet bundle missing');
  await buildApp();
}
