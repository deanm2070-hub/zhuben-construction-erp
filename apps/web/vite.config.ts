import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const BUILD = new Date().toISOString();
const SRC = readFileSync(new URL('./src/lib/version.ts', import.meta.url), 'utf8');
const VERSION = /v: '([^']+)'/.exec(SRC)?.[1] ?? '';
// what is new in this version, shown on the update notice of pages still running the previous one
const NOTES = [...(/notes: \[(.*?)\] \}/.exec(SRC)?.[1] ?? '').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\(.)/g, '$1'));

/** Writes /version.json so open pages (and home-screen shortcuts) can tell a newer build is live. */
const version = (): Plugin => ({
  name: 'version-file',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD, version: VERSION, notes: NOTES }) }); },
});

export default defineConfig({
  plugins: [react(), version()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { chunkSizeWarningLimit: 2000 },
});
