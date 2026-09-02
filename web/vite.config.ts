import { defineConfig } from 'vite';

// Decaid serves an installed skin from its own folder under /web-ui/<id>/, so
// every asset reference has to be relative rather than root-absolute.
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173 }
});
