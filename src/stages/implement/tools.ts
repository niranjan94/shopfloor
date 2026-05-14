import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";
import { updateProgressTool } from "../../tools/update-progress.js";

export interface ImplToolsArgs {
  progressCommentId: number;
}

// SDK file tools (Read/Glob/Grep/Edit/Write) and Bash come with the Agent SDK
// by default and are restricted at the SDK options layer, not by listing
// them here. The only Shopfloor-specific tool exposed at this stage is the
// in-process update_progress wrapper.
export function implementTools(
  ctx: StageContext,
  args: ImplToolsArgs,
): SdkTool[] {
  if (!ctx.issue) throw new Error("implement tools require ctx.issue");
  return [
    updateProgressTool({
      github: {
        updateIssueComment: (id, body) => ctx.github.updateComment(id, body),
      },
      commentId: args.progressCommentId,
      issueNumber: ctx.issue.number,
    }),
  ];
}
