import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 40 * 60_000;

const LARGE: Scenario = {
  id: "large",
  name: "Large path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: per-task subtasks with rollup`,
      body: [
        "Add support for subtasks under each task on the tasks list",
        "(`app/page.tsx`).",
        "",
        "Requirements:",
        "- New `subtasks` array on the Task type in `app/types.ts`.",
        "- IndexedDB migration to v2 in `app/db.ts` that backfills empty",
        "  arrays on existing rows.",
        "- A nested subtask tree under each task card with add / toggle /",
        "  delete.",
        "- A completion rollup: when all subtasks are done, the parent task",
        "  may be marked done; otherwise the parent is at most in-progress.",
        "",
        "Scope: multi-file, multi-component. Expect triage to classify large.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:large", { timeoutMs: 5 * 60_000 });

    const specPr = await ctx.expectPrOpenedFor(issue, "spec", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.mergePr(specPr.number);

    const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.mergePr(planPr.number);

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 12 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 15 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default LARGE;
