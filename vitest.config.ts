import { defineConfig } from "vitest/config";

// The harness suite is src/ only. fixtures/*/repo/ contains deliberately BROKEN
// repos whose tests are supposed to fail — without this filter `npm test` would
// run them and the harness could never be green.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
