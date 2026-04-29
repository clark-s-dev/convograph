import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/graph/index.ts",
    "src/core/config/index.ts",
    "src/core/router/index.ts",
    "src/core/extractor/index.ts",
    "src/core/reply/index.ts",
    "src/core/drafts/index.ts",
    "src/core/llm/index.ts",
    "src/core/persistence/index.ts",
    "src/codegen/index.ts",
    "src/cli/cli.ts",
    "src/cli/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: "node18",
  shims: true,
  esbuildOptions(options) {
    options.platform = "node";
  },
});
