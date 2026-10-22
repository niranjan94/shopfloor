import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 30 * 60_000;

const MEDIUM: Scenario = {
  id: "medium",
  name: "Medium path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: bulk-select and delete tasks`,
      body: [
        "Add a bulk-select mode to the tasks list. When enabled, each task",
        "card shows a checkbox; a 'Delete selected' button at the top of the",
        "list removes every checked task via `db.deleteTask` and updates the",
        "React `tasks` state.",
        "",
        "Scope: UI + client-side selection state only. No schema changes,",
        "no new persistence fields. Touch `app/page.tsx` and at most one new",
        "component file under `app/components/`. Selection state is local",
        "React state and resets when bulk-select is toggled off.",
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
