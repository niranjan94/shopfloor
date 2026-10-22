import { build } from "esbuild";

await build({
  entryPoints: ["src/entry.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: "inline",
  legalComments: "external",
  logLevel: "info",
  loader: {
    ".md": "text",
    ".tmpl": "text",
  },
  // Some transitive dependencies (claude-agent-sdk and friends) call
  // `createRequire(import.meta.url)` at top level. esbuild's CJS output
  // otherwise rewrites `import.meta` to `{}`, so `import.meta.url` is
  // undefined and createRequire crashes at module load. Inject a banner that
  // computes a file URL for the bundle, then `define` rewrites every
  // `import.meta.url` reference to it.
  banner: {
    js: `var __SHOPFLOOR_BUNDLE_URL__ = require('node:url').pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "__SHOPFLOOR_BUNDLE_URL__",
  },
});
