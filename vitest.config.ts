/**
 * Vitest config for the unit tests (tests/*.test.ts).
 *
 * IMPORTANT: include is scoped to `tests/` so Vitest does NOT pick up the
 * Playwright E2E specs (e2e/*.spec.ts) — those run via `npm run test:e2e`.
 * Default environment is node; the slider-drag test opts into jsdom with a
 * per-file `@vitest-environment` docblock.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
