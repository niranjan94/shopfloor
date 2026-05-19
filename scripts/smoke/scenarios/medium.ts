import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 20 * 60_000;

const MEDIUM: Scenario = {
  id: "medium",
  name: "Medium path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: status filter on tasks list`,
      body: [
        "Add a status filter to the tasks list in `app/page.tsx`. The filter",
        "lets the user select one of: All, To Do, In Progress, Done, and",
        "filters the visible tasks accordingly.",
        "",
        "Scope: UI + client-side filter state only. No persistence changes",
        "and no schema changes. Touch only `app/page.tsx` and create one new",
        "component file under `app/components/` if needed.",
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
