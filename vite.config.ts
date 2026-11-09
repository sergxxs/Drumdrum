import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: { host: '0.0.0.0', allowedHosts: true },
  build: { target: 'es2020', assetsInlineLimit: 0 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
