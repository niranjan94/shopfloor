import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("medium happy path", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "Add foo",
      body: "Need foo with multi-step plan.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage(medium) -> plan -> human merge -> implement -> review approved -> merge -> done", async () => {
    // 1. Trigger triage. The stub classifies the issue as 'medium', which
    //    sends it to needs-plan (skipping the spec stage by design).
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "medium",
        rationale: "needs a plan",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-plan");

    // 2. Plan stage. Seed the plan branch after the route emits its name
    //    so open-stage-pr can resolve it, then queue the plan agent.
    const planRouteOutputs = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-plan-no-title.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const planBranch = planRouteOutputs.branch_name;
    if (!planBranch) {
      throw new Error("expected route to emit branch_name for plan stage");
    }
    fake.seedBranch(planBranch, "sha-plan-0");
    harness.queueAgent("plan", {
      pr_title: "plan: add foo",
      pr_body: "Plan for adding foo.",
      summary_for_issue_comment: "Plan ready.",
      changed_files: JSON.stringify([
        "docs/superpowers/plans/issue-42-plan.md",
      ]),
    });
    await harness.runStage("plan");
    const planPr = fake.openPrs().find((p) => p.head.ref === planBranch);
    expect(planPr).toBeDefined();
    expect(planPr!.body ?? "").toMatch(/Shopfloor-Stage: plan/);
    expect(fake.labelsOn(42)).toContain("shopfloor:plan-in-review");

    // 3. Human merges the plan PR. Plan PRs go through human review in
    //    production, not the automated four-way review fan-out, so we
    //    just merge the PR and deliver the closed event. handle-merge
    //    should flip the issue to shopfloor:needs-impl.
    fake.mergePr(planPr!.number, planPr!.head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-plan.json", {
        issueNumber: 42,
        prNumber: planPr!.number,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:plan-in-review");

    // 4. Implement stage.
    const implRouteOutputs = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-impl.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const implBranch = implRouteOutputs.branch_name;
    if (!implBranch) {
      throw new Error("expected route to emit branch_name for implement stage");
    }
    fake.seedBranch(implBranch, "sha-impl-0");
    harness.queueAgent("implement", {
      pr_title: "feat: add foo",
      pr_body: "Implements foo per plan.",
      summary_for_issue_comment: "Done.",
      changed_files: JSON.stringify(["src/foo.ts"]),
    });
    await harness.runStage("implement");
    const implPr = fake.openPrs().find((p) => p.head.ref === implBranch);
    expect(implPr).toBeDefined();
    const implPrAfter = fake.pr(implPr!.number);
    expect(implPrAfter.body).toContain("Shopfloor-Issue: #42");
    expect(implPrAfter.body).toContain("Shopfloor-Stage: implement");
    expect(implPrAfter.body).toContain("Shopfloor-Review-Iteration: 0");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");

    // 5. Automated review fan-out unanimously approves.
    await harness.deliverEvent(
      loadEvent("pr-ready-for-review-impl.json", {
        issueNumber: 42,
        prNumber: implPr!.number,
        sha: implPrAfter.head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueReviewAgents({
      compliance: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      bugs: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      security: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      smells: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
    });
    await harness.runStage("review");
    expect(fake.labelsOn(42)).toContain("shopfloor:review-approved");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-review");

    // 6. Merge impl PR. handle-merge closes the issue with shopfloor:done.
    fake.mergePr(implPr!.number, implPrAfter.head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-impl.json", {
        issueNumber: 42,
        prNumber: implPr!.number,
        sha: implPrAfter.head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.issue(42).state).toBe("closed");
    expect(fake.labelsOn(42)).toContain("shopfloor:done");

    // 7. Persistent complexity label survives every stage.
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");
    // Spec stage was skipped entirely.
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-spec");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:spec-in-review");

    // Final snapshot
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
