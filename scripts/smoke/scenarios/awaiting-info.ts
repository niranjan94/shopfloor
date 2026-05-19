import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 10 * 60_000;

const AWAITING_INFO: Scenario = {
  id: "awaiting-info",
  name: "Awaiting info round-trip",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: make the dashboard better`,
      body: "We want the dashboard to be better. Improve it.",
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:awaiting-info", {
      timeoutMs: 5 * 60_000,
    });
    await ctx.expectCommentByApp(
      issue,
      ctx.appLogins.primary,
      /clarif|please|which|what|could you|specify|unclear/i,
      { timeoutMs: 5 * 60_000 },
    );

    await ctx.commentOnIssue(
      issue,
      `${ctx.tag} clarification: add a "tasks completed today" counter on the dashboard hero. Pure UI, no persistence. Read from the existing IndexedDB tasks store and count entries with status=done updated within the last 24 hours.`,
    );

    await ctx.expectLabelMissing(issue, "shopfloor:awaiting-info", {
      timeoutMs: 5 * 60_000,
    });
    await ctx.expectLabel(issue, /^shopfloor:(quick|medium)$/, {
      timeoutMs: 5 * 60_000,
    });

    return { kind: "pass" };
  },
};

export default AWAITING_INFO;
