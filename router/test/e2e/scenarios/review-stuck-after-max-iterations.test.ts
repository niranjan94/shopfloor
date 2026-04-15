import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("review stuck after max iterations", () => {
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

  test("three REQUEST_CHANGES rounds trip the iteration cap and flag review-stuck", async () => {
    // 1. Triage as medium so the issue skips spec and lands on
    //    needs-plan, matching impl-review-retry-loop's setup.
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

    // 2. Plan stage.
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

    // 3. First implement run.
    const implRoute1 = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-impl.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    expect(implRoute1.revision_mode).toBeUndefined();
    const implBranch = implRoute1.branch_name;
    if (!implBranch) {
      throw new Error("expected route to emit branch_name for implement stage");
    }
    fake.seedBranch(implBranch, "sha-impl-0");

    // Seed the plan file so build-revision-context can read it on the
    // revision passes below.
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

    // 4. Drive three consecutive REQUEST_CHANGES rounds. aggregate-review
    //    tripwire condition is `nextIteration > maxIterations`, where
    //    currentIteration is parsed from the PR body and nextIteration is
    //    currentIteration + 1. With max=3 the sequence is:
    //      round 0: body=0 -> next=1 -> REQUEST_CHANGES, body becomes 1
    //      round 1: body=1 -> next=2 -> REQUEST_CHANGES, body becomes 2
    //      round 2: body=2 -> next=3 -> REQUEST_CHANGES, body becomes 3
    //      round 3: body=3 -> next=4 > 3 -> STUCK branch fires
    //    So we need three REQUEST_CHANGES rounds followed by a fourth
    //    review run that trips the cap. Between each review we must run
    //    the implement-revision graph so push_files_revision advances
    //    the head sha and apply-impl-postwork re-labels needs-review.
    const complianceIssues = (version: number) =>
      JSON.stringify({
        verdict: "issues_found",
        summary: `still needs rename (v${version})`,
        comments: [
          {
            path: "src/foo.ts",
            line: 1,
            side: "RIGHT",
            body: `iteration ${version}: rename foo to bar`,
            confidence: 95,
            category: "compliance",
          },
        ],
      });
    const cleanOutput = JSON.stringify({
      verdict: "clean",
      summary: "ok",
      comments: [],
    });

    for (let iteration = 0; iteration < 3; iteration++) {
      // Review round: one high-confidence compliance finding,
      // other reviewers clean.
      await harness.deliverEvent(
        loadEvent("pr-ready-for-review-impl.json", {
          issueNumber: 42,
          prNumber: implPrNumber,
          sha: fake.pr(implPrNumber).head.sha,
        }),
        { trigger_label: "shopfloor:enabled" },
      );
      harness.queueReviewAgents({
        compliance: { output: complianceIssues(iteration) },
        bugs: { output: cleanOutput },
        security: { output: cleanOutput },
        smells: { output: cleanOutput },
      });
      await harness.runStage("review");

      // After each REQUEST_CHANGES round the label should still be the
      // changes-requested one, and the iteration counter must reflect
      // the round we just ran (body=iteration+1).
      expect(fake.labelsOn(42)).toContain(
        "shopfloor:review-requested-changes",
      );
      expect(fake.labelsOn(42)).not.toContain("shopfloor:review-stuck");
      expect(fake.pr(implPrNumber).body ?? "").toMatch(
        new RegExp(`Shopfloor-Review-Iteration: ${iteration + 1}`),
      );

      // Feed the PR review event so the route flips into revision mode,
      // then run the implement-revision graph. push_files_revision will
      // advance the branch sha so the next review lands on a distinct
      // commit, matching what a real `git push` would do.
      const headShaForRevisionEvent = fake.pr(implPrNumber).head.sha;
      const implRouteRevision = await harness.deliverEvent(
        loadEvent("pr-review-submitted-changes-requested.json", {
          issueNumber: 42,
          prNumber: implPrNumber,
          sha: headShaForRevisionEvent,
          headRef: implBranch,
        }),
        { trigger_label: "shopfloor:enabled" },
      );
      expect(implRouteRevision.stage).toBe("implement");
      expect(implRouteRevision.revision_mode).toBe("true");
      expect(implRouteRevision.impl_pr_number).toBe(String(implPrNumber));

      harness.queueAgent("implement", {
        pr_title: `feat: add foo (v${iteration + 2})`,
        pr_body: `Revision ${iteration + 1}: still not enough.`,
        summary_for_issue_comment: `Revised (v${iteration + 2}).`,
        changed_files: JSON.stringify([`src/foo.ts`]),
      });
      await harness.runStage("implement");

      // Same PR, advanced sha, label reset to needs-review, and the
      // iteration counter is preserved by apply-impl-postwork so the
      // next review round reads the bumped value.
      const implPrsNow = fake
        .openPrs()
        .filter((p) => p.head.ref === implBranch);
      expect(implPrsNow).toHaveLength(1);
      expect(implPrsNow[0].number).toBe(implPrNumber);
      expect(implPrsNow[0].head.sha).not.toBe(headShaForRevisionEvent);
      expect(implPrsNow[0].body ?? "").toMatch(
        new RegExp(`Shopfloor-Review-Iteration: ${iteration + 1}`),
      );
      expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");
      expect(fake.labelsOn(42)).not.toContain(
        "shopfloor:review-requested-changes",
      );
    }

    // 5. Fourth review round. The PR body sits at iteration 3, so
    //    aggregate-review computes nextIteration=4, sees 4 > 3, and
    //    takes the stuck branch: adds shopfloor:review-stuck, posts a
    //    stuck comment on the PR, marks the review status as failure,
    //    and does NOT post a REQUEST_CHANGES review.
    expect(fake.pr(implPrNumber).body ?? "").toMatch(
      /Shopfloor-Review-Iteration: 3/,
    );
    const reviewsBeforeStuck = fake.reviewsOn(implPrNumber);
    expect(reviewsBeforeStuck.length).toBe(3);
    expect(
      reviewsBeforeStuck.every((r) => r.state === "changes_requested"),
    ).toBe(true);
    const distinctCommitsBeforeStuck = new Set(
      reviewsBeforeStuck.map((r) => r.commitId),
    );
    expect(distinctCommitsBeforeStuck.size).toBe(3);

    await harness.deliverEvent(
      loadEvent("pr-ready-for-review-impl.json", {
        issueNumber: 42,
        prNumber: implPrNumber,
        sha: fake.pr(implPrNumber).head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueReviewAgents({
      compliance: { output: complianceIssues(3) },
      bugs: { output: cleanOutput },
      security: { output: cleanOutput },
      smells: { output: cleanOutput },
    });
    await harness.runStage("review");

    // 6. Final assertions.
    expect(fake.labelsOn(42)).toContain("shopfloor:review-stuck");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:done");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-review");
    expect(fake.labelsOn(42)).not.toContain(
      "shopfloor:review-requested-changes",
    );
    // The persistent complexity label survives the stuck transition.
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");
    // Issue stays open for a human to inspect.
    expect(fake.issue(42).state).toBe("open");
    // Impl PR is left open and unmerged.
    expect(fake.pr(implPrNumber).state).toBe("open");
    expect(fake.pr(implPrNumber).merged).toBe(false);

    // The stuck branch posts a single explanatory comment on the PR
    // (stored under issueNumber=prNumber because PRs-are-issues).
    const prComments = fake.commentsOn(implPrNumber);
    const stuckComment = prComments.find((c) =>
      /iteration(s)? without converging/i.test(c.body),
    );
    expect(stuckComment).toBeDefined();

    // No fourth REQUEST_CHANGES review was posted. The review count
    // sits at 3 (the three prior REQUEST_CHANGES) even though we ran
    // aggregate-review a fourth time.
    const finalReviews = fake.reviewsOn(implPrNumber);
    expect(finalReviews.length).toBe(3);
    expect(finalReviews.every((r) => r.state === "changes_requested")).toBe(
      true,
    );

    // The commit status on the current head should be a failure whose
    // description calls out the iteration cap.
    const finalStatus = fake.statusFor(
      fake.pr(implPrNumber).head.sha,
      "shopfloor/review",
    );
    expect(finalStatus).toBeDefined();
    expect(finalStatus!.state).toBe("failure");
    expect(finalStatus!.description).toMatch(/iteration cap/i);

    expect(fake.snapshot()).toMatchSnapshot();
  });
});
