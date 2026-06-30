import { describe, expect, it, vi } from "vitest";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import { RUNNERS } from "../../src/runners.js";
import type { StageContext } from "../../src/stages/_shared/context.js";
import { aggregateFindings } from "../../src/stages/review/aggregate.js";
import { applyReview } from "../../src/stages/review/apply.js";
import type { ReviewComment } from "../../src/stages/review/decision.js";
import type { LensOutcome } from "../../src/stages/review/runner.js";
import { baseConfig } from "../_harness/config.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";

function cleanOutcome(lens: LensOutcome["lens"]): LensOutcome {
  return {
    lens,
    decision: {
      verdict: "clean",
      summary: `${lens} clean`,
      comments: [],
    },
    error: null,
  };
}

function commentOutcome(
  lens: LensOutcome["lens"],
  comments: ReviewComment[],
): LensOutcome {
  return {
    lens,
    decision: {
      verdict: "issues_found",
      summary: `${lens} found issues`,
      comments,
    },
    error: null,
  };
}

function blockedOutcome(lens: LensOutcome["lens"]): LensOutcome {
  return {
    lens,
    decision: {
      verdict: "blocked",
      summary: `${lens} could not run git diff`,
      comments: [],
    },
    error: null,
  };
}

function failedOutcome(
  lens: LensOutcome["lens"],
  kind: string,
  message: string,
): LensOutcome {
  return { lens, decision: null, error: { kind, message } };
}

const patch = `@@ -1,1 +1,3 @@
-old line
+new line a
+new line b
+new line c
`;

describe("aggregateFindings", () => {
  it("approves when all four lenses are clean", () => {
    const result = aggregateFindings({
      outcomes: [
        cleanOutcome("compliance"),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("approve");
    if (result.kind === "approve") {
      expect(result.body).toContain("passed");
      expect(result.body).toContain("No issues found");
      // Clean summary stays minimal: no per-lens prose dumped into the body.
      expect(result.body).not.toContain("compliance clean");
      expect(result.successfulLenses).toBe(4);
    }
  });

  it("does not approve when a lens is blocked, even with no findings", () => {
    const result = aggregateFindings({
      outcomes: [
        cleanOutcome("compliance"),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        blockedOutcome("smells"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.body).toContain("Some checks couldn't complete");
      expect(result.body).toContain("code smells");
      expect(result.anchoredComments).toHaveLength(0);
    }
  });

  it("requests changes when any lens reports a finding above the threshold", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("compliance", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "uses npx instead of pnpx",
            confidence: 95,
            category: "compliance",
          },
        ]),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.anchoredComments).toHaveLength(1);
      expect(result.droppedComments).toHaveLength(0);
      expect(result.nextIteration).toBe(1);
      // Headline leads with the count; details are deferred to inline comments.
      expect(result.body).toContain("1 issue to address");
      expect(result.body).toContain("See the 1 inline comment below");
      // Category breakdown table replaces the per-lens prose dump.
      expect(result.body).toContain("| Compliance | 1 |");
      expect(result.body).not.toContain("compliance found issues");
    }
  });

  it("pluralizes the headline and counts categories across lenses", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("bugs", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "off-by-one",
            confidence: 95,
            category: "bug",
          },
          {
            path: "src/x.ts",
            line: 3,
            side: "RIGHT",
            body: "null deref",
            confidence: 90,
            category: "bug",
          },
        ]),
        commentOutcome("security", [
          {
            path: "src/x.ts",
            line: 1,
            side: "RIGHT",
            body: "missing authz",
            confidence: 95,
            category: "security",
          },
        ]),
        cleanOutcome("compliance"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.body).toContain("3 issues to address");
      expect(result.body).toContain("| Bug | 2 |");
      expect(result.body).toContain("| Security | 1 |");
    }
  });

  it("drops comments whose line falls outside the diff hunks", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("compliance", [
          {
            path: "src/x.ts",
            line: 999,
            side: "RIGHT",
            body: "off-diff comment",
            confidence: 95,
            category: "compliance",
          },
        ]),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.anchoredComments).toHaveLength(0);
      expect(result.droppedComments).toHaveLength(1);
      expect(result.body).toContain("outside the changed lines");
    }
  });

  it("filters comments below the confidence threshold", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("compliance", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "low-confidence finding",
            confidence: 70,
            category: "compliance",
          },
        ]),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    // Verdict is approve because nothing survives the threshold filter
    // and all lens verdicts were clean except compliance which had a sub-
    // threshold comment dropped. v1 treated this case as approve only when
    // every lens verdict was clean -- compliance returned "issues_found",
    // so this stays request_changes per v1 semantics.
    expect(result.kind).toBe("request_changes");
  });

  it("requests changes when a lens fails outright", () => {
    const result = aggregateFindings({
      outcomes: [
        cleanOutcome("compliance"),
        cleanOutcome("bugs"),
        {
          lens: "security",
          decision: null,
          error: { kind: "agent_budget", message: "over budget" },
        },
        cleanOutcome("smells"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.body).toContain("Some checks couldn't complete");
      expect(result.body).toContain("security");
    }
  });

  it("returns errored when every lens fails to complete", () => {
    const result = aggregateFindings({
      outcomes: [
        failedOutcome(
          "compliance",
          "agent_execution",
          "Claude CLI installer exited with code 1: getaddrinfo ESERVFAIL downloads.claude.ai",
        ),
        failedOutcome(
          "bugs",
          "agent_execution",
          "Claude CLI installer exited with code 1",
        ),
        failedOutcome(
          "security",
          "agent_execution",
          "Claude CLI installer exited with code 1",
        ),
        failedOutcome(
          "smells",
          "agent_execution",
          "Claude CLI installer exited with code 1",
        ),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("errored");
    if (result.kind === "errored") {
      expect(result.body).toContain("could not complete");
      expect(result.body).toContain(
        "getaddrinfo ESERVFAIL downloads.claude.ai",
      );
      expect(result.failures).toHaveLength(4);
      // First failure: count increments to 1, no escalation yet.
      expect(result.errorCount).toBe(1);
      expect(result.escalate).toBe(false);
    }
  });

  it("errored increments the consecutive-error count without escalating below the threshold", () => {
    const result = aggregateFindings({
      outcomes: [
        failedOutcome("compliance", "agent_execution", "installer failed"),
        failedOutcome("bugs", "agent_execution", "installer failed"),
        failedOutcome("security", "agent_execution", "installer failed"),
        failedOutcome("smells", "agent_execution", "installer failed"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
      currentErrorCount: 1,
      maxConsecutiveReviewErrors: 3,
    });
    expect(result.kind).toBe("errored");
    if (result.kind === "errored") {
      expect(result.errorCount).toBe(2);
      expect(result.escalate).toBe(false);
    }
  });

  it("errored escalates once the consecutive-error count reaches the threshold", () => {
    const result = aggregateFindings({
      outcomes: [
        failedOutcome("compliance", "agent_execution", "installer failed"),
        failedOutcome("bugs", "agent_execution", "installer failed"),
        failedOutcome("security", "agent_execution", "installer failed"),
        failedOutcome("smells", "agent_execution", "installer failed"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
      currentErrorCount: 2,
      maxConsecutiveReviewErrors: 3,
    });
    expect(result.kind).toBe("errored");
    if (result.kind === "errored") {
      expect(result.errorCount).toBe(3);
      expect(result.escalate).toBe(true);
    }
  });

  it("does not return errored when at least one lens succeeded", () => {
    const result = aggregateFindings({
      outcomes: [
        cleanOutcome("compliance"),
        failedOutcome("bugs", "agent_execution", "installer failed"),
        failedOutcome("security", "agent_execution", "installer failed"),
        failedOutcome("smells", "agent_execution", "installer failed"),
      ],
      patches: [],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
  });

  it("returns iteration_cap when nextIteration > maxIterations", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("compliance", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "still broken",
            confidence: 95,
            category: "compliance",
          },
        ]),
        cleanOutcome("bugs"),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 3,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("iteration_cap");
  });

  it("dedupes overlapping comments and keeps the higher-confidence one", () => {
    const result = aggregateFindings({
      outcomes: [
        commentOutcome("compliance", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "use pnpx not npx",
            confidence: 85,
            category: "compliance",
          },
        ]),
        commentOutcome("bugs", [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "use pnpx not npx",
            confidence: 95,
            category: "bug",
          },
        ]),
        cleanOutcome("security"),
        cleanOutcome("smells"),
      ],
      patches: [{ filename: "src/x.ts", patch }],
      currentIteration: 0,
      maxIterations: 3,
      confidenceThreshold: 80,
    });
    expect(result.kind).toBe("request_changes");
    if (result.kind === "request_changes") {
      expect(result.anchoredComments).toHaveLength(1);
      expect(result.anchoredComments[0]?.confidence).toBe(95);
    }
  });
});

function ctxFor(reviewGithub: ReturnType<typeof makeMockGithub> | null) {
  const mg = makeMockGithub();
  const rg = reviewGithub;
  const audit = vi.fn();
  const ctx: StageContext = {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    defaultBranch: "main",
    decision: { stage: "review" },
    pr: {
      number: 100,
      title: "feat: x",
      body: "PR body\n\nShopfloor-Review-Iteration: 0",
      headRef: "shopfloor/impl/42-x",
      headSha: "head-sha",
      baseRef: "main",
    },
    github: asAdapter(mg),
    reviewGithub: rg ? asAdapter(rg) : null,
    agent: { runStage: async () => null } as never,
    audit,
    config: {} as never,
    runId: "r1",
  };
  return { ctx, mg, rg, audit };
}

describe("applyReview", () => {
  it("posts an APPROVE review via reviewGithub when configured", async () => {
    const reviewGh = makeMockGithub();
    const { ctx, mg } = ctxFor(reviewGh);
    await applyReview(ctx, {
      outcome: { kind: "approve", body: "clean", successfulLenses: 4 },
      labelTarget: 42,
    });
    expect(reviewGh.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(mg.postReview).not.toHaveBeenCalled();
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:review-approved");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:needs-review");
  });

  it("approve clears a persisted consecutive-error count", async () => {
    const reviewGh = makeMockGithub();
    const { ctx, mg } = ctxFor(reviewGh);
    ctx.pr!.body =
      "PR body\n\nShopfloor-Review-Iteration: 0\nShopfloor-Review-Error-Count: 2";
    await applyReview(ctx, {
      outcome: { kind: "approve", body: "clean", successfulLenses: 4 },
      labelTarget: 42,
    });
    // A clean approval proves the CLI works, so the counter must be reset.
    expect(mg.updatePrBody).toHaveBeenCalledWith(
      100,
      expect.not.stringContaining("Shopfloor-Review-Error-Count"),
    );
  });

  it("approve does not rewrite the body when no error count is present", async () => {
    const reviewGh = makeMockGithub();
    const { ctx, mg } = ctxFor(reviewGh);
    await applyReview(ctx, {
      outcome: { kind: "approve", body: "clean", successfulLenses: 4 },
      labelTarget: 42,
    });
    expect(mg.updatePrBody).not.toHaveBeenCalled();
  });

  it("posts REQUEST_CHANGES and writes iteration line to PR body", async () => {
    const reviewGh = makeMockGithub();
    const { ctx, mg } = ctxFor(reviewGh);
    await applyReview(ctx, {
      outcome: {
        kind: "request_changes",
        body: "changes",
        anchoredComments: [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "fix",
            confidence: 95,
            category: "compliance",
          },
        ],
        droppedComments: [],
        nextIteration: 1,
        lensWarnings: [],
      },
      labelTarget: 42,
    });
    expect(reviewGh.postReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        comments: [
          expect.objectContaining({
            path: "src/x.ts",
            line: 2,
            // Readable header: category label + confidence word + raw score.
            body: expect.stringContaining(
              "Compliance** · very high confidence (95/100)",
            ),
          }),
        ],
      }),
    );
    expect(mg.updatePrBody).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Shopfloor-Review-Iteration: 1"),
    );
    expect(mg.addLabel).toHaveBeenCalledWith(
      42,
      "shopfloor:review-requested-changes",
    );
  });

  function erroredOutcome(errorCount: number, escalate: boolean) {
    return {
      kind: "errored" as const,
      body: "could not complete",
      failures: [
        {
          lens: "bugs" as const,
          kind: "agent_execution",
          message: "installer failed",
        },
      ],
      errorCount,
      escalate,
    };
  }

  it("errored (below threshold): COMMENTs, errors the status, persists the count, no verdict labels", async () => {
    const reviewGh = makeMockGithub();
    const { ctx, mg, audit } = ctxFor(reviewGh);
    await applyReview(ctx, {
      outcome: erroredOutcome(1, false),
      labelTarget: 42,
    });
    expect(mg.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT" }),
    );
    expect(mg.setReviewStatus).toHaveBeenCalledWith(
      "head-sha",
      "error",
      expect.stringContaining("could not complete"),
      undefined,
    );
    // Persist the incremented count so the next run can escalate.
    expect(mg.updatePrBody).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Shopfloor-Review-Error-Count: 1"),
    );
    // No stuck/changes labels and no REQUEST_CHANGES verdict event.
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(reviewGh.postReview).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "review_posted", verdict: "errored" }),
    );
  });

  it("errored (escalate): flips review-stuck, pages a human, does not persist the count", async () => {
    const { ctx, mg } = ctxFor(null);
    await applyReview(ctx, {
      outcome: erroredOutcome(3, true),
      labelTarget: 42,
    });
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:review-stuck");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:needs-review");
    expect(mg.postIssueComment).toHaveBeenCalledWith(
      100,
      expect.stringContaining("consecutive"),
    );
    expect(mg.setReviewStatus).toHaveBeenCalledWith(
      "head-sha",
      "error",
      expect.any(String),
      undefined,
    );
    expect(mg.updatePrBody).not.toHaveBeenCalled();
  });

  it("reviewOnly: errored skips error-count persistence and all labels", async () => {
    const { ctx, mg } = ctxFor(null);
    ctx.reviewOnly = true;
    await applyReview(ctx, {
      outcome: erroredOutcome(1, false),
      labelTarget: 42,
    });
    expect(mg.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT" }),
    );
    expect(mg.updatePrBody).not.toHaveBeenCalled();
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.removeLabel).not.toHaveBeenCalled();
  });

  it("applies review-stuck on iteration_cap", async () => {
    const { ctx, mg } = ctxFor(null);
    await applyReview(ctx, {
      outcome: { kind: "iteration_cap", maxIterations: 3 },
      labelTarget: 42,
    });
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:review-stuck");
    expect(mg.postIssueComment).toHaveBeenCalledWith(
      100,
      expect.stringContaining("3 iterations"),
    );
    expect(mg.setReviewStatus).toHaveBeenCalledWith(
      "head-sha",
      "failure",
      expect.stringContaining("iteration cap"),
      undefined,
    );
  });

  it("falls back to ctx.github.postReview when reviewGithub is null", async () => {
    const { ctx, mg } = ctxFor(null);
    await applyReview(ctx, {
      outcome: { kind: "approve", body: "clean", successfulLenses: 4 },
      labelTarget: 42,
    });
    expect(mg.postReview).toHaveBeenCalled();
  });

  it("reviewOnly: APPROVE skips Shopfloor label flips", async () => {
    const { ctx, mg } = ctxFor(null);
    ctx.reviewOnly = true;
    await applyReview(ctx, {
      outcome: { kind: "approve", body: "clean", successfulLenses: 4 },
      labelTarget: 42,
    });
    expect(mg.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.removeLabel).not.toHaveBeenCalled();
  });

  it("reviewOnly: REQUEST_CHANGES skips labels and PR body mutation", async () => {
    const { ctx, mg } = ctxFor(null);
    ctx.reviewOnly = true;
    await applyReview(ctx, {
      outcome: {
        kind: "request_changes",
        body: "changes",
        anchoredComments: [
          {
            path: "src/x.ts",
            line: 2,
            side: "RIGHT",
            body: "fix",
            confidence: 95,
            category: "compliance",
          },
        ],
        droppedComments: [],
        nextIteration: 1,
        lensWarnings: [],
      },
      labelTarget: 42,
    });
    expect(mg.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    expect(mg.updatePrBody).not.toHaveBeenCalled();
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.removeLabel).not.toHaveBeenCalled();
  });
});

describe("review runner labelTarget guard", () => {
  function reviewCtx(opts: { reviewOnly: boolean; withIssue: boolean }) {
    const mg = makeMockGithub();
    mg.listChangedFilePatches.mockResolvedValue([
      {
        filename: "src/auth.ts",
        patch: "@@ -1,0 +1,1 @@\n+const x = 1;",
        status: "added",
      },
    ]);
    const cleanLens = {
      verdict: "clean",
      summary: "clean",
      comments: [],
    };
    const ctx: StageContext = {
      event: {} as never,
      repo: { owner: "octo", name: "demo" },
      defaultBranch: "main",
      decision: { stage: "review" },
      pr: {
        number: 100,
        title: "feat: x",
        body: "PR body\n\nShopfloor-Review-Iteration: 0",
        headRef: "shopfloor/impl/42-x",
        headSha: "head-sha",
        baseRef: "main",
      },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([
        { matchUserPromptIncludes: "src/auth.ts", decision: cleanLens },
      ]),
      audit: vi.fn(),
      config: baseConfig,
      runId: "r1",
    };
    if (opts.withIssue) {
      ctx.issue = { number: 42, title: "t", body: null, labels: [] };
    }
    if (opts.reviewOnly) ctx.reviewOnly = true;
    return { ctx, mg };
  }

  it("throws in pipeline mode when ctx.issue is missing so the silent PR fallback cannot regress", async () => {
    const { ctx } = reviewCtx({ reviewOnly: false, withIssue: false });
    await expect(
      RUNNERS.review.execute(ctx, { stage: "review" }),
    ).rejects.toThrow(/review stage requires ctx.issue in pipeline mode/);
  });

  it("does not throw in reviewOnly mode even though ctx.issue is null on a human-authored PR", async () => {
    const { ctx, mg } = reviewCtx({ reviewOnly: true, withIssue: false });
    await expect(
      RUNNERS.review.execute(ctx, { stage: "review" }),
    ).resolves.toBeUndefined();
    // Sanity: reviewOnly still writes no pipeline-state labels.
    expect(mg.addLabel).not.toHaveBeenCalled();
  });
});
