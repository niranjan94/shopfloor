import type { StageContext } from "../../../_shared/context.js";
import { LensDecision } from "../../decision.js";
import { type LensRunnerArgs, renderLensUserPrompt } from "../shared.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";
import { smellsTools } from "./tools.js";

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
    effort: ctx.config.reviewEfforts.smells,
    budgetUsd: ctx.config.reviewMaxBudgetUsdPerLens,
    ...(ctx.config.reviewMaxTurnsPerLens !== undefined
      ? { maxTurns: ctx.config.reviewMaxTurnsPerLens }
      : {}),
    timeoutMs: ctx.config.reviewTimeoutMsPerLens,
  });
}
