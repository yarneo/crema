import { defineConfig } from 'vite';

// Decaid serves an installed skin from its own folder under /web-ui/<id>/, so
// every asset reference has to be relative rather than root-absolute.
export default defineConfig({
  base: './',
  // Chrome 78 is what the Android 8.1 tablets Decent shipped are frozen on
  // (no Play Store to update them). esbuild lowers optional chaining and
  // nullish coalescing for that target, which is the difference between a
  // working page and a blank one.
  build: { target: 'chrome78', outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173 }
});
