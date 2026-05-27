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
      expect(result.body).toContain("clean");
      expect(result.successfulLenses).toBe(4);
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
      expect(result.body).toContain("Findings dropped");
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
      expect(result.body).toContain("Lens failures");
      expect(result.body).toContain("security");
    }
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
        comments: [expect.objectContaining({ path: "src/x.ts", line: 2 })],
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
