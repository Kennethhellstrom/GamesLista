import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["cli.ts"],
      reporter: ["text"],
      thresholds: {
        lines: 100,
      },
    },
  },
});
