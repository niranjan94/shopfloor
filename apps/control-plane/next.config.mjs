import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(__dirname, "../..");
const shopfloorSrc = path.join(monorepoRoot, "src");

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: monorepoRoot,
  webpack: (config, { isServer }) => {
    // Root package uses TypeScript ESM imports ending in `.js` (NodeNext style).
    // Only alias those for modules under the monorepo `src/` tree so Next's own
    // compiled chunks keep resolving normal `.js` files.
    const prev = config.resolve.extensionAlias ?? {};
    config.resolve.extensionAlias = {
      ...prev,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };

    // Prompt / template assets imported as raw strings from stage runners.
    config.module.rules.push({
      test: /\.(md|tmpl)$/,
      type: "asset/source",
    });

    // Prefer monorepo src when resolving shopfloor packages.
    config.resolve.modules = [
      path.join(__dirname, "node_modules"),
      path.join(monorepoRoot, "node_modules"),
      ...(config.resolve.modules || ["node_modules"]),
    ];

    // Silence / stabilize resolution root
    config.context = __dirname;

    return config;
  },
};

export default nextConfig;
