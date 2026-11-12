import { defineConfig } from "vitest/config";

// End-to-end suites that are vitest files: run with `e2e/run`, never by the default `npm test`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    exclude: ["node_modules", "receiver"],
    testTimeout: 30000,
  },
});
