import { renderTemplate } from "../_shared/prompts.js";
import { triageTools } from "./tools.js";
import { TriageDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";

export async function runTriage(ctx: StageContext): Promise<TriageDecision> {
  if (!ctx.issue) throw new Error("runTriage requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    repo_owner: ctx.repo.owner,
    repo_name: ctx.repo.name,
    issue_number: ctx.issue.number,
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    issue_comments: "",
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: triageTools(ctx),
    decisionSchema: TriageDecision,
    model: ctx.config.triageModel,
    budgetUsd: ctx.config.triageMaxBudgetUsd,
    timeoutMs: ctx.config.triageTimeoutMs,
  });
}
