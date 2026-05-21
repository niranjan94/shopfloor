import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 20 * 60_000;

const REVISION_LOOP: Scenario = {
  id: "revision-loop",
  name: "Implement -> review request-changes -> revise -> approve",
  flaky: true,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: clear-completed button`,
      body: [
        "Add a 'Clear completed' button to the tasks list. The button removes",
        "every task with `status === 'done'` by calling `db.deleteTask` for",
        "each and updating React state.",
        "",
        "Scope: UI + client-side state only. No schema changes. Touch",
        "`app/page.tsx` and at most one new helper file under",
        "`app/components/` if it helps readability.",
        "",
        "The button must be hidden when no completed tasks exist and must",
        "show a confirmation prompt (window.confirm is fine) before deleting.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, /^shopfloor:(quick|medium)$/, {
      timeoutMs: 5 * 60_000,
    });

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 10 * 60_000,
    });
    const firstSha = implPr.headSha;

    const requestChanges = ctx
      .expectLabel(issue, "shopfloor:review-requested-changes", {
        timeoutMs: 10 * 60_000,
      })
      .then(() => "request_changes" as const);
    const approved = ctx
      .expectLabel(issue, "shopfloor:review-approved", {
        timeoutMs: 10 * 60_000,
      })
      .then(() => "approved" as const);

    const firstVerdict = await Promise.race([requestChanges, approved]);

    if (firstVerdict === "approved") {
      return {
        kind: "soft-pass",
        reason: "Review approved on iteration 1; revision loop not exercised",
      };
    }

    await ctx.expectNewCommitOn(implPr.number, firstSha, {
      timeoutMs: 10 * 60_000,
    });

    await ctx.expectLabel(issue, /^shopfloor:(review-approved|review-stuck)$/, {
      timeoutMs: 15 * 60_000,
    });

    return { kind: "pass" };
  },
};

export default REVISION_LOOP;
