import { renderTemplate } from "../_shared/prompts.js";
import { implementTools } from "./tools.js";
import { ImplementDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";

export interface RunImplementArgs {
  progressCommentId: number;
  branchName: string;
  specFilePath: string;
  planFilePath: string;
  bashAllowlist: string;
  revisionBlock: string;
}

export async function runImplement(
  ctx: StageContext,
  args: RunImplementArgs,
): Promise<ImplementDecision> {
  if (!ctx.issue) throw new Error("runImplement requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    repo_owner: ctx.repo.owner,
    repo_name: ctx.repo.name,
    issue_number: ctx.issue.number,
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    branch_name: args.branchName,
    progress_comment_id: args.progressCommentId,
    spec_file_path: args.specFilePath,
    plan_file_path: args.planFilePath,
    bash_allowlist: args.bashAllowlist,
    revision_block: args.revisionBlock,
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: implementTools(ctx, { progressCommentId: args.progressCommentId }),
    decisionSchema: ImplementDecision,
    model: ctx.config.implModel,
    effort: ctx.config.implEffort,
    budgetUsd: ctx.config.implMaxBudgetUsd,
    timeoutMs: ctx.config.implTimeoutMs,
  });
}
