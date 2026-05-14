import { renderTemplate } from "../_shared/prompts.js";
import { planTools } from "./tools.js";
import { PlanDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";

export interface RunPlanArgs {
  branchName: string;
  planFilePath: string;
  specFilePath: string;
  revisionBlock: string;
  issueComments: string;
}

export async function runPlan(
  ctx: StageContext,
  args: RunPlanArgs,
): Promise<PlanDecision> {
  if (!ctx.issue) throw new Error("runPlan requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    repo_owner: ctx.repo.owner,
    repo_name: ctx.repo.name,
    issue_number: ctx.issue.number,
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    issue_comments: args.issueComments,
    branch_name: args.branchName,
    plan_file_path: args.planFilePath,
    spec_file_path: args.specFilePath,
    revision_block: args.revisionBlock,
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: planTools(ctx),
    decisionSchema: PlanDecision,
    model: ctx.config.planModel,
    effort: ctx.config.planEffort,
    budgetUsd: ctx.config.planMaxBudgetUsd,
    timeoutMs: ctx.config.planTimeoutMs,
  });
}
