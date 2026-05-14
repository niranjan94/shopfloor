import { readPrompt } from "../../../_shared/prompts.js";
import { LensDecision } from "../../decision.js";
import { renderLensUserPrompt, type LensRunnerArgs } from "../shared.js";
import { complianceTools } from "./tools.js";
import type { StageContext } from "../../../_shared/context.js";

const SYSTEM = readPrompt(import.meta.url, "prompt.system.md");
const USER_TMPL = readPrompt(import.meta.url, "prompt.user.md.tmpl");

export async function runComplianceLens(
  ctx: StageContext,
  args: LensRunnerArgs,
): Promise<LensDecision> {
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt: renderLensUserPrompt(USER_TMPL, ctx, args),
    tools: complianceTools(ctx),
    decisionSchema: LensDecision,
    model: ctx.config.reviewModels.compliance,
    budgetUsd: ctx.config.reviewMaxBudgetUsdPerLens,
    timeoutMs: ctx.config.reviewTimeoutMsPerLens,
  });
}
