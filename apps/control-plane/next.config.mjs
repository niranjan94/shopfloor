/** @type {import('next').NextConfig} */
const nextConfig = {
  // Shopfloor core lives one level up; transpile TS from the monorepo root.
  transpilePackages: [],
  experimental: {
    // Allow importing from ../../src
    externalDir: true,
  },
  // Serverless functions need the raw body for webhook HMAC.
  // Route handlers read request.text() which preserves the body.
};

export default nextConfig;
