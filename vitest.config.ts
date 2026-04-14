import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['router/test/**/*.test.ts', 'mcp-servers/**/test/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['router/src/**', 'mcp-servers/shopfloor-mcp/index.ts'],
      exclude: ['**/test/**']
    }
  }
});
