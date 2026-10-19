import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const BUILD = new Date().toISOString();

/** Writes /version.json so open pages (and home-screen shortcuts) can tell a newer build is live. */
const version = (): Plugin => ({
  name: 'version-file',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) }); },
});

export default defineConfig({
  plugins: [react(), version()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { chunkSizeWarningLimit: 2000 },
});
