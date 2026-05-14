import { LensDecision } from "../../decision.js";
import { renderLensUserPrompt, type LensRunnerArgs } from "../shared.js";
import { smellsTools } from "./tools.js";
import type { StageContext } from "../../../_shared/context.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";

export async function runSmellsLens(
  ctx: StageContext,
  args: LensRunnerArgs,
): Promise<LensDecision> {
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt: renderLensUserPrompt(USER_TMPL, ctx, args),
    tools: smellsTools(ctx),
    decisionSchema: LensDecision,
    model: ctx.config.reviewModels.smells,
    budgetUsd: ctx.config.reviewMaxBudgetUsdPerLens,
    timeoutMs: ctx.config.reviewTimeoutMsPerLens,
  });
}
