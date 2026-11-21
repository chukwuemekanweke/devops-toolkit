import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/validation/**/*.test.ts"],
    coverage: { enabled: false },
  },
});
