import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 40 * 60_000;

const LARGE: Scenario = {
  id: "large",
  name: "Large path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: centralized smoke banner module`,
      body: [
        "Introduce a centralized smoke-banner system. The smoke tag for this",
        `run is exactly \`${ctx.tag}\`.`,
        "",
        "Requirements:",
        "- A new `app/smoke.ts` module exporting the current smoke tag as a",
        "  `const SMOKE_TAG = \"<tag>\"` and a small `getSmokeTag()` helper",
        "  that returns it.",
        "- A new `app/components/SmokeBanner.tsx` client component that",
        "  renders the value from `getSmokeTag()` inside",
        '  `<div data-smoke className="smoke-banner">{tag}</div>`.',
        "- Integrate `<SmokeBanner />` as the first child of the top-level",
        "  container in `app/page.tsx`, `app/dashboard/page.tsx`, and",
        "  `app/layout.tsx`.",
        "- If a prior `app/smoke.ts`, `app/components/SmokeBanner.tsx`, or",
        "  `<SmokeBanner />` integration already exists, REPLACE it in place",
        "  with the new tag value rather than duplicating.",
        "",
        "Scope: multi-file, requires design choices around module location,",
        "naming, and integration points. Expect triage to classify large.",
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
