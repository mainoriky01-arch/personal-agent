import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@pa/shared-types": new URL("../shared-types/src/index.ts", import.meta.url).pathname,
    },
  },
});
