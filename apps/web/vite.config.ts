import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const BUILD = new Date().toISOString();
const VERSION = /v: '([^']+)'/.exec(readFileSync(new URL('./src/lib/version.ts', import.meta.url), 'utf8'))?.[1] ?? '';

/** Writes /version.json so open pages (and home-screen shortcuts) can tell a newer build is live. */
const version = (): Plugin => ({
  name: 'version-file',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD, version: VERSION }) }); },
});

export default defineConfig({
  plugins: [react(), version()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { chunkSizeWarningLimit: 2000 },
});
