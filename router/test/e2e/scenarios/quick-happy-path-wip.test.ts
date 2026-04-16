import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("quick happy path (WIP mode)", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake, useDraftPrs: false });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "Add foo",
      body: "Need foo.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage -> implement -> review approved -> merge -> done", async () => {
    // 1. Triage
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "quick",
        rationale: "single-file fix",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:quick");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");

    // 2. Implement
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
      pr_body: "Implements foo as requested.",
      summary_for_issue_comment: "Done.",
      changed_files: JSON.stringify(["src/foo.ts"]),
    });
    await harness.runStage("implement");
    const implPr = fake.openPrs().find((p) => p.head.ref === implBranch);
    expect(implPr).toBeDefined();
    // In WIP mode, PR should NOT be draft
    expect(implPr!.draft).toBe(false);
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:implementing");
    // WIP label should have been removed after impl
    expect(implPr!.labels.some((l) => l === "shopfloor:wip")).toBe(false);

    const implPrAfter = fake.pr(implPr!.number);
    expect(implPrAfter.body).toContain("Shopfloor-Issue: #42");
    expect(implPrAfter.body).toContain("Shopfloor-Stage: implement");

    // 3. Review -- in WIP mode, the canonical trigger is pull_request.unlabeled
    // with label.name === "shopfloor:wip". In production, the push fires
    // synchronize while the WIP label is still present (suppressed), then
    // the label removal fires unlabeled which routes to review. We must
    // exercise the unlabeled code path here.
    await harness.deliverEvent(
      loadEvent("pr-unlabeled-wip-impl.json", {
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

    // 4. Merge
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

    expect(fake.snapshot()).toMatchSnapshot();
  });
});
