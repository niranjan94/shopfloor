import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("quick happy path", () => {
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
      body: "Need foo.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage -> implement -> review approved -> merge -> done", async () => {
    // 1. Trigger label added runs triage. The stub classifies the issue
    //    as 'quick', which sends it straight to needs-impl (skipping spec
    //    and plan).
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

    // 2. needs-impl label triggers implement. Seed the impl branch first
    //    so open-stage-pr can resolve it. The branch name comes from the
    //    route output so we never hard-code the slug.
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
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:implementing");
    // The PR body written by apply-impl-postwork must carry the metadata
    // block the rest of the pipeline keys off of.
    const implPrAfter = fake.pr(implPr!.number);
    expect(implPrAfter.body).toContain("Shopfloor-Issue: #42");
    expect(implPrAfter.body).toContain("Shopfloor-Stage: implement");
    expect(implPrAfter.body).toContain("Shopfloor-Review-Iteration: 0");

    // 3. ready_for_review on the impl PR triggers review. The stub
    //    returns four clean reviewer outputs so aggregate-review applies
    //    shopfloor:review-approved.
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
        output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }),
      },
      bugs: {
        output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }),
      },
      security: {
        output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }),
      },
      smells: {
        output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }),
      },
    });
    await harness.runStage("review");
    expect(fake.labelsOn(42)).toContain("shopfloor:review-approved");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-review");

    // 4. Merge the impl PR (the production handler closes the issue
    //    here). The merge event is synthesised from the fake PR state so
    //    the payload head sha matches the current PR.
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
    // Persistent complexity label survives every transient label flip.
    expect(fake.labelsOn(42)).toContain("shopfloor:quick");

    // Final snapshot
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
