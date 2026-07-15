import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@pa/shared-types": new URL("../../packages/shared-types/src/index.ts", import.meta.url).pathname,
      "@pa/rule-engine": new URL("../../packages/rule-engine/src/index.ts", import.meta.url).pathname,
      "@pa/rule-drafting": new URL("../../packages/rule-drafting/src/index.ts", import.meta.url).pathname,
      "@pa/intervention-writer": new URL("../../packages/intervention-writer/src/index.ts", import.meta.url).pathname,
      "@pa/intervention-service": new URL("../../packages/intervention-service/src/index.ts", import.meta.url).pathname,
    },
  },
});
