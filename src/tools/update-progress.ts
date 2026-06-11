import { z } from "zod";
import type { SdkTool } from "./types.js";

export interface UpdateProgressArgs {
  github: { updateIssueComment(id: number, body: string): Promise<void> };
  commentId: number;
  issueNumber: number;
}

const inputShape = { body: z.string().min(1).max(60_000) };

export function updateProgressTool(args: UpdateProgressArgs): SdkTool {
  // Constructed as a plain SdkTool object rather than via any provider SDK's
  // tool() helper: this is the neutral tool both the Claude and Codex adapters
  // consume, so it must not bind to a single provider's tool wrapper. The Zod
  // raw shape in `inputSchema` is what both createSdkMcpServer() (Claude) and
  // McpServer.registerTool() (Codex bridge) accept.
  return {
    name: "update_progress",
    description:
      "Replace the body of the pinned progress comment on the issue with the supplied markdown.",
    inputSchema: inputShape,
    handler: async (input) => {
      // The MCP server (Claude's createSdkMcpServer or the Codex bridge's
      // registerTool) validates `input` against `inputShape` before dispatch,
      // so `body` is guaranteed present and well-formed here.
      const { body } = input as { body: string };
      try {
        await args.github.updateIssueComment(args.commentId, body);
        return { content: [{ type: "text" as const, text: "ok" }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
          isError: true,
        };
      }
    },
  };
}
