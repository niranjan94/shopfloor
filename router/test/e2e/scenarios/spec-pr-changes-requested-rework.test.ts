import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("spec PR changes requested rework", () => {
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
    // Seed title/body that match the needs-spec fixture payload so the
    // slug derived from payload.issue.title (add-github-oauth-login) and
    // the slug persisted into the issue body metadata block agree. Mixing
    // them produces a misleading snapshot where the PR branch references
    // one slug and the issue metadata another.
    fake.seedIssue({
      number: 42,
      title: "Add GitHub OAuth login",
      body: "We need OAuth login via GitHub App with a full design doc.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("spec PR REQUEST_CHANGES -> rework -> same PR reused -> merge -> needs-plan", async () => {
    // 1. Triage classifies the issue as large, pushing it to the spec
    //    stage. The spec stage is the only one that exercises the
    //    human-gated review loop we're testing here; medium and quick
    //    flows skip spec entirely.
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "large",
        rationale: "needs a full spec",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:large");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-spec");

    // 2. First spec run produces the initial spec PR. Seed the spec
    //    branch sha after the route emits its name, then queue the
    //    agent stub for v1 output.
    const specRoute1 = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-spec.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const specBranch = specRoute1.branch_name;
    if (!specBranch) {
      throw new Error("expected route to emit branch_name for spec stage");
    }
    fake.seedBranch(specBranch, "sha-spec-0");
    harness.queueAgent("spec", {
      pr_title: "spec: add github oauth login (v1)",
      pr_body: "First spec draft.",
      summary_for_issue_comment: "Spec ready.",
      changed_files: JSON.stringify([
        "docs/shopfloor/specs/42-add-github-oauth-login.md",
      ]),
    });
    await harness.runStage("spec");
    const specPr = fake.openPrs().find((p) => p.head.ref === specBranch);
    expect(specPr).toBeDefined();
    expect(specPr!.body ?? "").toMatch(/Shopfloor-Stage: spec/);
    const specPrNumber = specPr!.number;
    expect(fake.labelsOn(42)).toContain("shopfloor:spec-in-review");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-spec");

    // 3. A human reviewer requests changes on the spec PR. The review
    //    goes through a third identity (reviewer-human) so the fake's
    //    "cannot review your own PR" guard doesn't fire: the spec PR
    //    author is the primary shopfloor[bot] App.
    await fake.asOctokit("reviewer-human").rest.pulls.createReview({
      owner: fake.owner,
      repo: fake.repo,
      pull_number: specPrNumber,
      commit_id: specPr!.head.sha,
      event: "REQUEST_CHANGES",
      body: "Needs more detail on the auth flow.",
      comments: [],
    });
    expect(fake.reviewsOn(specPrNumber)).toHaveLength(1);
    expect(fake.reviewsOn(specPrNumber)[0].state).toBe("changes_requested");

    // 4. Deliver the changes-requested event. The router should
    //    classify this as a spec stage re-run in revision mode and
    //    re-emit the same branch_name so open-stage-pr can upsert the
    //    existing PR instead of creating a new one.
    const rerunRoute = await harness.deliverEvent(
      loadEvent("pr-review-spec-changes-requested.json", {
        issueNumber: 42,
        prNumber: specPrNumber,
        sha: specPr!.head.sha,
        headRef: specBranch,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    expect(rerunRoute.stage).toBe("spec");
    expect(rerunRoute.revision_mode).toBe("true");
    expect(rerunRoute.branch_name).toBe(specBranch);

    // 5. Re-run spec. The stub returns a revised title/body. The
    //    spec stage should find the existing open PR for this head
    //    branch and update it in place.
    harness.queueAgent("spec", {
      pr_title: "spec: add github oauth login (v2)",
      pr_body: "Revised spec with more detail on the auth flow.",
      summary_for_issue_comment: "Spec revised.",
      changed_files: JSON.stringify([
        "docs/shopfloor/specs/42-add-github-oauth-login.md",
      ]),
    });
    await harness.runStage("spec");

    // 6. Same PR number is reused; only one open PR exists for this
    //    head branch; title reflects v2 output.
    const specPrsAfter = fake
      .openPrs()
      .filter((p) => p.head.ref === specBranch);
    expect(specPrsAfter).toHaveLength(1);
    expect(specPrsAfter[0].number).toBe(specPrNumber);
    expect(specPrsAfter[0].title).toMatch(/v2/);
    expect(specPrsAfter[0].body ?? "").toMatch(/Revised spec with more detail/);
    expect(fake.labelsOn(42)).toContain("shopfloor:spec-in-review");

    // 7. The human merges the revised spec PR. handle-merge flips
    //    the issue onto shopfloor:needs-plan, same as the large
    //    happy path.
    fake.mergePr(specPrNumber, specPrsAfter[0].head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-spec.json", {
        issueNumber: 42,
        prNumber: specPrNumber,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-plan");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:spec-in-review");

    // Persistent complexity label survives every stage.
    expect(fake.labelsOn(42)).toContain("shopfloor:large");

    // Final snapshot
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
