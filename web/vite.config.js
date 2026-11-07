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
  // satellite.js's WASM builds (never used: the link model runs its JS
  // SGP4) would add megabytes and top-level await to the worker's bundle.
  resolve: {
    alias: {
      '#wasm-single-thread': resolve(import.meta.dirname, 'src/apps/starlink/links/noWasm.js'),
      '#wasm-multi-thread': resolve(import.meta.dirname, 'src/apps/starlink/links/noWasm.js'),
    },
  },
  // ...and the dev server's pre-bundling would pull them in without the alias.
  optimizeDeps: { exclude: ['satellite.js'] },
  server: { host: true },
});
