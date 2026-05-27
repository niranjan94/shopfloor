import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SdkTool } from "./types.js";

export interface UpdateProgressArgs {
  github: { updateIssueComment(id: number, body: string): Promise<void> };
  commentId: number;
  issueNumber: number;
}

const inputShape = { body: z.string().min(1).max(60_000) };

export function updateProgressTool(args: UpdateProgressArgs): SdkTool {
  return tool(
    "update_progress",
    "Replace the body of the pinned progress comment on the issue with the supplied markdown.",
    inputShape,
    async (input) => {
      try {
        await args.github.updateIssueComment(args.commentId, input.body);
        return { content: [{ type: "text" as const, text: "ok" }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
          isError: true,
        };
      }
    },
  ) as unknown as SdkTool;
}
