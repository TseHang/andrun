import { defineConfig } from "vitest/config";

export default defineConfig({
  // The render tests (test/web/*.test.tsx) use JSX; the web build gets this from its React plugin.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 20_000,
  },
});
