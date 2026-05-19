import type { Scenario, ScenarioOutcome, SmokeCtx } from "../lib/types.js";

const TIMEOUT_MS = 15 * 60_000;

async function runSkipReview(ctx: SmokeCtx): Promise<void> {
  const { number: issue } = await ctx.createIssue({
    title: `${ctx.tag}: skip-review readme date`,
    body: [
      "Append today's date to the bottom of `README.md` in the form",
      "`<!-- last-smoke: YYYY-MM-DD -->`.",
      "",
      "Trivial single-file change.",
    ].join("\n"),
    labels: ["shopfloor:trigger", "shopfloor:skip-review"],
  });

  const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
    timeoutMs: 8 * 60_000,
  });
  await ctx.expectLabel(issue, "shopfloor:impl-in-review", {
    timeoutMs: 8 * 60_000,
  });
  await ctx.expectLabelMissing(issue, "shopfloor:needs-review", {
    timeoutMs: 2 * 60_000,
  });
  await ctx.mergePr(implPr.number);
  await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });
}

async function runRevise(ctx: SmokeCtx): Promise<void> {
  const { number: issue } = await ctx.createIssue({
    title: `${ctx.tag}: revise plan target`,
    body: [
      "Add a 'Today' quick-filter button to the tasks list that filters to",
      "tasks created in the last 24 hours. UI + client filter state, two or",
      "three files. Expect triage to classify as medium.",
    ].join("\n"),
    labels: ["shopfloor:trigger"],
  });

  await ctx.expectLabel(issue, "shopfloor:medium", { timeoutMs: 5 * 60_000 });
  await ctx.expectLabel(issue, "shopfloor:plan-in-review", {
    timeoutMs: 8 * 60_000,
  });
  const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
    timeoutMs: 2 * 60_000,
  });
  const firstSha = planPr.headSha;

  await ctx.addLabel(issue, "shopfloor:revise");

  await ctx.expectNewCommitOn(planPr.number, firstSha, {
    timeoutMs: 10 * 60_000,
  });

  await ctx.closePr(planPr.number);
}

const SKIP_REVIEW_AND_REVISE: Scenario = {
  id: "skip-review-and-revise",
  name: "skip-review + revise(plan)",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    await runSkipReview(ctx);
    await runRevise(ctx);
    return { kind: "pass" };
  },
};

export default SKIP_REVIEW_AND_REVISE;
