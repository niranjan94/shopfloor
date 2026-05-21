import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 10 * 60_000;

const QUICK: Scenario = {
  id: "quick",
  name: "Quick path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: tag dashboard heading`,
      body: [
        "Append a smoke-tag suffix to the visible `<h1>` heading on the",
        `dashboard page so it reads exactly: \`Dashboard Overview (${ctx.tag})\`.`,
        "",
        "Touch only `app/dashboard/page.tsx`. No new components, no state",
        "changes, no styling beyond the heading text. Replace any prior smoke",
        "tag in the heading rather than appending alongside it.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:quick", { timeoutMs: 5 * 60_000 });
    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:needs-review", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 6 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default QUICK;
