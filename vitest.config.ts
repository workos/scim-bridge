import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    // Each file gets a fresh in-memory SQLite DB from the helpers; suites are
    // independent, so let them run in parallel workers.
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      // What the migration itself is made of. The panel is excluded because it
      // is not in the type gate yet either (ENT-6755) and a threshold that
      // averages UI in would let the proxy's coverage fall without anyone
      // noticing — which is the opposite of what a floor is for.
      include: ["workers/**/*.ts", "server/**/*.ts"],
      exclude: ["**/*.d.ts", "workers/idp/**", "workers/native/**"],
      // A floor, not a target. It is set just under today's numbers so it
      // ratchets rather than blocks: the point is that a change which deletes
      // tests, or adds a large untested path, turns the build red. Raise it when
      // the real number moves up; never lower it to make a build pass.
      // Measured 2026-08-10: statements 84.51, branches 84.97, functions 81.30,
      // lines 85.72. Each floor sits just under its number, so the build fails
      // on a regression rather than on today's shape.
      thresholds: {
        statements: 84,
        branches: 84,
        functions: 80,
        lines: 85,
      },
    },
  },
});
