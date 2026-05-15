import { renderTemplate } from "../_shared/prompts.js";
import { implementTools } from "./tools.js";
import { ImplementDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";
import { LABELS } from "../../state/labels.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";
import SYSTEM_QUICK from "./prompt.system.quick.md";
import USER_QUICK_TMPL from "./prompt.user.quick.md.tmpl";

export interface RunImplementArgs {
  progressCommentId: number;
  branchName: string;
  specFilePath: string;
  planFilePath: string;
  bashAllowlist: string;
  revisionBlock: string;
  // Issue comments are only rendered into the quick-path user prompt; the
  // plan-driven path takes its source of truth from the plan file.
  issueComments: string;
}

export async function runImplement(
  ctx: StageContext,
  args: RunImplementArgs,
): Promise<ImplementDecision> {
  if (!ctx.issue) throw new Error("runImplement requires ctx.issue");
  const quick = ctx.issue.labels.includes(LABELS.complexityQuick);
  const systemPrompt = quick ? SYSTEM_QUICK : SYSTEM;
  const userPrompt = quick
    ? renderTemplate(USER_QUICK_TMPL, {
        repo_owner: ctx.repo.owner,
        repo_name: ctx.repo.name,
        issue_number: ctx.issue.number,
        issue_title: ctx.issue.title,
        issue_body: ctx.issue.body ?? "",
        issue_comments: args.issueComments,
        branch_name: args.branchName,
        progress_comment_id: args.progressCommentId,
        bash_allowlist: args.bashAllowlist,
        revision_block: args.revisionBlock,
      })
    : renderTemplate(USER_TMPL, {
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
    systemPrompt,
    userPrompt,
    tools: implementTools(ctx, { progressCommentId: args.progressCommentId }),
    decisionSchema: ImplementDecision,
    model: ctx.config.implModel,
    effort: ctx.config.implEffort,
    budgetUsd: ctx.config.implMaxBudgetUsd,
    ...(ctx.config.implMaxTurns !== undefined
      ? { maxTurns: ctx.config.implMaxTurns }
      : {}),
    timeoutMs: ctx.config.implTimeoutMs,
  });
}
