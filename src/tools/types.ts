// Placeholder type. Plan 1 only uses tools structurally. The Claude adapter
// translates these into createSdkMcpServer() invocations; the mock ignores them.
export type SdkTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};
