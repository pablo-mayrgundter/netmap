import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Relative base so the built viewer can be hosted from any static path
// (GitHub Pages, a bucket, a subdirectory next to the tile pyramids).
// Two pages: the app, and map.html, NetMap as a NetGL guest for a host page
// to embed (README, "map.html").
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), map: resolve(import.meta.dirname, 'map.html') },
    },
  },
  server: { host: true },
});
