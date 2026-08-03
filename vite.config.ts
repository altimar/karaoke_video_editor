import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under any sub-path, including
  // GitHub Pages (https://<user>.github.io/<repo>/) and local file:// preview.
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  // mediabunny ships ESM with browser field; Vite resolves it natively.
  optimizeDeps: {
    include: ['mediabunny'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
