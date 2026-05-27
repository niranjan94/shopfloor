import type { StageContext } from "../_shared/context.js";
import { renderTemplate } from "../_shared/prompts.js";
import { SpecDecision } from "./decision.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";
import { specTools } from "./tools.js";

export interface RunSpecArgs {
  branchName: string;
  specFilePath: string;
  revisionBlock: string;
  issueComments: string;
  triageRationale: string;
}

export async function runSpec(
  ctx: StageContext,
  args: RunSpecArgs,
): Promise<SpecDecision> {
  if (!ctx.issue) throw new Error("runSpec requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    repo_owner: ctx.repo.owner,
    repo_name: ctx.repo.name,
    issue_number: ctx.issue.number,
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    issue_comments: args.issueComments,
    branch_name: args.branchName,
    spec_file_path: args.specFilePath,
    triage_rationale: args.triageRationale,
    revision_block: args.revisionBlock,
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: specTools(ctx),
    decisionSchema: SpecDecision,
    model: ctx.config.specModel,
    effort: ctx.config.specEffort,
    budgetUsd: ctx.config.specMaxBudgetUsd,
    ...(ctx.config.specMaxTurns !== undefined
      ? { maxTurns: ctx.config.specMaxTurns }
      : {}),
    timeoutMs: ctx.config.specTimeoutMs,
  });
}
