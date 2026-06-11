import type { z } from "zod";

// Neutral, provider-agnostic tool shape. The Claude adapter feeds these to
// createSdkMcpServer(); the Codex adapter registers them on an in-process
// Streamable HTTP MCP server (src/agents/mcp-http-bridge.ts); the mock ignores
// them. `inputSchema` is a Zod raw shape (the `{ field: zodType }` object), the
// same value the Claude SDK's `tool()` returns and the value
// McpServer.registerTool() accepts as its inputSchema.
export type SdkTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (input: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};
