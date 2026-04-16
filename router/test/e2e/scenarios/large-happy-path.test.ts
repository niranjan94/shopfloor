import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("large happy path", () => {
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
      title: "Add GitHub OAuth login",
      body: "Need OAuth login via GitHub App with a multi-step design.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage(large) -> spec -> human merge -> plan -> human merge -> implement -> review approved -> merge -> done", async () => {
    // 1. Trigger triage. The stub classifies the issue as 'large', which
    //    routes the issue into the spec stage.
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "large",
        rationale: "needs a full spec before planning",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:large");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-spec");

    // 2. Spec stage. Seed the spec branch after the route emits its name
    //    so open-stage-pr can resolve it, then queue the spec agent.
    const specRouteOutputs = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-spec.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const specBranch = specRouteOutputs.branch_name;
    if (!specBranch) {
      throw new Error("expected route to emit branch_name for spec stage");
    }
    fake.seedBranch(specBranch, "sha-spec-0");
    harness.queueAgent("spec", {
      pr_title: "spec: add github oauth login",
      pr_body: "Spec for adding GitHub OAuth login.",
      summary_for_issue_comment: "Spec ready.",
      changed_files: JSON.stringify(["docs/shopfloor/specs/issue-42-spec.md"]),
    });
    await harness.runStage("spec");
    const specPr = fake.openPrs().find((p) => p.head.ref === specBranch);
    expect(specPr).toBeDefined();
    expect(specPr!.body ?? "").toMatch(/Shopfloor-Stage: spec/);
    expect(fake.labelsOn(42)).toContain("shopfloor:spec-in-review");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-spec");

    // 3. Human merges the spec PR. Spec PRs go through human review in
    //    production, not the automated four-way review fan-out, so we
    //    just merge the PR and deliver the closed event. handle-merge
    //    should flip the issue to shopfloor:needs-plan.
    fake.mergePr(specPr!.number, specPr!.head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-spec.json", {
        issueNumber: 42,
        prNumber: specPr!.number,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-plan");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:spec-in-review");

    // 4. Plan stage. Same pattern as medium happy path.
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
      pr_title: "plan: add github oauth login",
      pr_body: "Plan for adding GitHub OAuth login.",
      summary_for_issue_comment: "Plan ready.",
      changed_files: JSON.stringify(["docs/shopfloor/plans/issue-42-plan.md"]),
    });
    await harness.runStage("plan");
    const planPr = fake.openPrs().find((p) => p.head.ref === planBranch);
    expect(planPr).toBeDefined();
    expect(planPr!.body ?? "").toMatch(/Shopfloor-Stage: plan/);
    expect(fake.labelsOn(42)).toContain("shopfloor:plan-in-review");

    // 5. Human merges the plan PR. handle-merge flips to needs-impl.
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

    // 6. Implement stage.
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
      pr_title: "feat: add github oauth login",
      pr_body: "Implements GitHub OAuth login per plan.",
      summary_for_issue_comment: "Done.",
      changed_files: JSON.stringify(["src/auth/github-oauth.ts"]),
    });
    await harness.runStage("implement");
    const implPr = fake.openPrs().find((p) => p.head.ref === implBranch);
    expect(implPr).toBeDefined();
    const implPrAfter = fake.pr(implPr!.number);
    expect(implPrAfter.body).toContain("Shopfloor-Issue: #42");
    expect(implPrAfter.body).toContain("Shopfloor-Stage: implement");
    expect(implPrAfter.body).toContain("Shopfloor-Review-Iteration: 0");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");

    // 7. Automated review fan-out unanimously approves.
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

    // 8. Merge impl PR. handle-merge closes the issue with shopfloor:done.
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

    // 9. Persistent complexity label survives every stage.
    expect(fake.labelsOn(42)).toContain("shopfloor:large");

    // Final snapshot
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
