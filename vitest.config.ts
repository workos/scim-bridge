import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    // Each file gets a fresh in-memory SQLite DB from the helpers; suites are
    // independent, so let them run in parallel workers.
    unstubGlobals: true,
  },
});
