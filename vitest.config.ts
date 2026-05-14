import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// Inline .md / .tmpl files as default-exported strings so stage runners can
// `import SYSTEM from "./prompt.system.md"` in the same shape esbuild's text
// loader produces for the action bundle. Without this vite would treat the
// import as a static asset URL.
function inlineTextPlugin(): Plugin {
  return {
    name: "shopfloor-inline-text",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0] ?? id;
      if (path.endsWith(".md") || path.endsWith(".tmpl")) {
        return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [inlineTextPlugin()],
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
