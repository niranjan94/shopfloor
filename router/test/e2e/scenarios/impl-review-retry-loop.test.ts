import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("impl review retry loop", () => {
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
      body: "Implement foo per spec.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("revision_mode flips, same PR reused, iteration counter increments", async () => {
    // 1. Triage as medium so the issue skips spec and lands on
    //    needs-plan. Plan and impl together exercise the cross-stage
    //    plan-file plumbing that build-revision-context reads on the
    //    revision pass.
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "medium",
        rationale: "needs plan",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-plan");

    // 2. Plan stage. Seed the plan branch sha after the route emits
    //    the canonical name so open-stage-pr can resolve it.
    const planRoute = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-plan-no-title.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const planBranch = planRoute.branch_name;
    if (!planBranch) {
      throw new Error("expected route to emit branch_name for plan stage");
    }
    fake.seedBranch(planBranch, "sha-plan-0");
    harness.queueAgent("plan", {
      pr_title: "plan: add foo",
      pr_body: "Plan body.",
      summary_for_issue_comment: "Plan ready.",
      changed_files: JSON.stringify([
        planRoute.plan_file_path ?? "docs/shopfloor/plans/issue-42-plan.md",
      ]),
    });
    await harness.runStage("plan");
    const planPr = fake.openPrs().find((p) => p.head.ref === planBranch);
    expect(planPr).toBeDefined();
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

    // 3. First implement run. The route should emit revision_mode=false
    //    along with the canonical impl branch name and the spec/plan
    //    file paths the implement context will read.
    const implRoute1 = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-impl.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    // First-run implement does not flip revisionMode, so the route
    // output omits the key entirely. The harness's runStage("implement")
    // dispatcher reads this same field to decide between
    // implement-first-run and implement-revision graphs; an absent
    // value selects the first-run path.
    expect(implRoute1.revision_mode).toBeUndefined();
    const implBranch = implRoute1.branch_name;
    if (!implBranch) {
      throw new Error("expected route to emit branch_name for implement stage");
    }
    fake.seedBranch(implBranch, "sha-impl-0");

    // Seed the plan file at the relative path the implement context
    // expects. build-revision-context (used on the revision pass below)
    // will look up this same path via existsSync, so it has to be
    // present on disk under the harness workspace.
    if (implRoute1.plan_file_path) {
      harness.seedFile(
        implRoute1.plan_file_path,
        "# Plan for issue 42\n\nDo X then Y.\n",
      );
    }

    harness.queueAgent("implement", {
      pr_title: "feat: add foo (v1)",
      pr_body: "First impl draft.",
      summary_for_issue_comment: "Done v1.",
      changed_files: JSON.stringify(["src/foo.ts"]),
    });
    await harness.runStage("implement");
    const implPr1 = fake.openPrs().find((p) => p.head.ref === implBranch);
    expect(implPr1).toBeDefined();
    expect(implPr1!.body ?? "").toMatch(/Shopfloor-Review-Iteration: 0/);
    const implPrNumber = implPr1!.number;
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");

    // 4. Review iteration 0: REQUEST_CHANGES from the agent fan-out.
    //    One reviewer raises a high-confidence finding; the other
    //    three return clean. aggregate-review should post a single
    //    consolidated REQUEST_CHANGES via the review App, bump the
    //    PR body iteration counter to 1, and add the label.
    await harness.deliverEvent(
      loadEvent("pr-ready-for-review-impl.json", {
        issueNumber: 42,
        prNumber: implPrNumber,
        sha: fake.pr(implPrNumber).head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueReviewAgents({
      compliance: {
        output: JSON.stringify({
          verdict: "issues_found",
          summary: "needs rename",
          comments: [
            {
              path: "src/foo.ts",
              line: 1,
              side: "RIGHT",
              body: "rename foo to bar",
              confidence: 95,
              category: "compliance",
            },
          ],
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
    expect(fake.labelsOn(42)).toContain("shopfloor:review-requested-changes");
    const reviewsAfterIter0 = fake.reviewsOn(implPrNumber);
    expect(reviewsAfterIter0.length).toBe(1);
    expect(reviewsAfterIter0[0].state).toBe("changes_requested");
    expect(reviewsAfterIter0[0].user.login).toBe("shopfloor-review[bot]");
    // Iteration counter should have been bumped to 1 in the PR body.
    expect(fake.pr(implPrNumber).body ?? "").toMatch(
      /Shopfloor-Review-Iteration: 1/,
    );

    // 5. The PR review event flips the route into revision_mode. The
    //    PR head sha is whatever it was when the agent reviewer
    //    submitted iteration 0; we re-read it from the fake to keep
    //    the payload honest.
    const headShaForRevisionEvent = fake.pr(implPrNumber).head.sha;
    const implRoute2 = await harness.deliverEvent(
      loadEvent("pr-review-submitted-changes-requested.json", {
        issueNumber: 42,
        prNumber: implPrNumber,
        sha: headShaForRevisionEvent,
        headRef: implBranch,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    expect(implRoute2.stage).toBe("implement");
    expect(implRoute2.revision_mode).toBe("true");
    expect(implRoute2.impl_pr_number).toBe(String(implPrNumber));
    expect(implRoute2.branch_name).toBe(implBranch);

    harness.queueAgent("implement", {
      pr_title: "feat: add foo (v2)",
      pr_body: "Renamed foo to bar.",
      summary_for_issue_comment: "Fixed.",
      changed_files: JSON.stringify(["src/bar.ts"]),
    });
    await harness.runStage("implement");

    // 6. Same PR is reused: the head ref still resolves to a single
    //    open PR with the same number, the title and body now reflect
    //    the v2 agent output, the iteration counter sits at 1, and the
    //    push_files_revision graph step has advanced the head sha to
    //    a distinct commit so iteration 1 can be told from iteration 0.
    const implPrsNow = fake.openPrs().filter((p) => p.head.ref === implBranch);
    expect(implPrsNow).toHaveLength(1);
    expect(implPrsNow[0].number).toBe(implPrNumber);
    expect(implPrsNow[0].title).toMatch(/v2/);
    expect(implPrsNow[0].body ?? "").toMatch(/Renamed foo to bar/);
    expect(implPrsNow[0].body ?? "").toMatch(/Shopfloor-Review-Iteration: 1/);
    expect(implPrsNow[0].head.sha).not.toBe(headShaForRevisionEvent);
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");
    expect(fake.labelsOn(42)).not.toContain(
      "shopfloor:review-requested-changes",
    );

    // 7. Review iteration 1: all four reviewers clean. aggregate-review
    //    should APPROVE this time and flip the issue label to
    //    review-approved. The new review record sits on the advanced
    //    sha, distinct from iteration 0's commit_id.
    await harness.deliverEvent(
      loadEvent("pr-ready-for-review-impl.json", {
        issueNumber: 42,
        prNumber: implPrNumber,
        sha: fake.pr(implPrNumber).head.sha,
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
    const reviewsAfterIter1 = fake.reviewsOn(implPrNumber);
    expect(reviewsAfterIter1.length).toBe(2);
    const distinctCommits = new Set(reviewsAfterIter1.map((r) => r.commitId));
    expect(distinctCommits.size).toBe(2);
    const states = reviewsAfterIter1.map((r) => r.state).sort();
    expect(states).toEqual(["approved", "changes_requested"]);

    // 8. Merge the impl PR. handle-merge closes the issue with
    //    shopfloor:done and the persistent shopfloor:medium label
    //    survives the entire flow.
    fake.mergePr(implPrNumber, fake.pr(implPrNumber).head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-impl.json", {
        issueNumber: 42,
        prNumber: implPrNumber,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.issue(42).state).toBe("closed");
    expect(fake.labelsOn(42)).toContain("shopfloor:done");
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");

    expect(fake.snapshot()).toMatchSnapshot();
  });
});
