import { defineConfig } from 'vite';

// Relative base so the built viewer can be hosted from any static path
// (GitHub Pages, a bucket, a subdirectory next to the tile pyramids).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 3000 },
  server: { host: true },
});
