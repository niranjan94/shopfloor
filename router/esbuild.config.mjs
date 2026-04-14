import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.cjs",
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
});
