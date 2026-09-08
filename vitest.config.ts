import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/plugin/background.ts"],
      thresholds: {
        lines: 70,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
