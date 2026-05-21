import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 20 * 60_000;

const MEDIUM: Scenario = {
  id: "medium",
  name: "Medium path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: dual smoke banner`,
      body: [
        `Add a small \`<aside data-smoke>${ctx.tag}</aside>\` element as the`,
        "first child of the top-level container in BOTH",
        "`app/page.tsx` and `app/dashboard/page.tsx`. The text content must",
        `be exactly \`${ctx.tag}\`.`,
        "",
        "If a prior `<aside data-smoke>...</aside>` element already exists at",
        "the top of either file, replace it in place rather than appending",
        "alongside it.",
        "",
        "Scope: UI only, two files, no new components, no state. Treat as a",
        "small multi-file edit; no spec required, but a plan is.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:medium", { timeoutMs: 5 * 60_000 });
    await ctx.expectLabel(issue, "shopfloor:plan-in-review", {
      timeoutMs: 8 * 60_000,
    });
    const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.mergePr(planPr.number);

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 12 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default MEDIUM;
