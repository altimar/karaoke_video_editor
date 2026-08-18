import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under any sub-path, including
  // GitHub Pages (https://<user>.github.io/<repo>/) and local file:// preview.
  base: './',
  server: {
    port: 5173,
    open: true,
    // Cross-origin isolation enables SharedArrayBuffer, required by the
    // multithreaded WASM backend of onnxruntime-web (in-browser separation).
    // A production deployment must serve these same two headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Local-only bulk (KFN fixtures often locked by the KaraFun player,
    // ~1 GB of probe models) — watching these crashes the dev server (EBUSY).
    watch: {
      ignored: ['**/kfn/**', '**/public/local-models/**'],
    },
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
