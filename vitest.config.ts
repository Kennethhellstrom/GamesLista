import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Código de produção coberto: API, banco e (a partir da #7) CLI.
      include: ["api.ts", "db.ts", "cli.ts"],
      reporter: ["text"],
      thresholds: { lines: 100 },
    },
  },
});
