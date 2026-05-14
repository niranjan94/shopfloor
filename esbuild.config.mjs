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
});
