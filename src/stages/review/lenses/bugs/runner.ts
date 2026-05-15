import { LensDecision } from "../../decision.js";
import { renderLensUserPrompt, type LensRunnerArgs } from "../shared.js";
import { bugsTools } from "./tools.js";
import type { StageContext } from "../../../_shared/context.js";
import SYSTEM from "./prompt.system.md";
import USER_TMPL from "./prompt.user.md.tmpl";

export async function runBugsLens(
  ctx: StageContext,
  args: LensRunnerArgs,
): Promise<LensDecision> {
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt: renderLensUserPrompt(USER_TMPL, ctx, args),
    tools: bugsTools(ctx),
    decisionSchema: LensDecision,
    model: ctx.config.reviewModels.bugs,
    effort: ctx.config.reviewEfforts.bugs,
    budgetUsd: ctx.config.reviewMaxBudgetUsdPerLens,
    ...(ctx.config.reviewMaxTurnsPerLens !== undefined
      ? { maxTurns: ctx.config.reviewMaxTurnsPerLens }
      : {}),
    timeoutMs: ctx.config.reviewTimeoutMsPerLens,
  });
}
