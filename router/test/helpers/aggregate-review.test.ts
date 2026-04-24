import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregateReview } from "../../src/helpers/aggregate-review";
import { makeMockAdapter } from "./_mock-adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "../fixtures/reviewer-outputs", `${name}.json`),
    "utf-8",
  );
}

function primeImplPr(
  bundle: ReturnType<typeof makeMockAdapter>,
  iteration = 0,
  sha = "abc",
): void {
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha },
      body: `Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: ${iteration}\n`,
    },
  });
}

describe("aggregateReview", () => {
  test("all clean -> APPROVE review and success status", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-clean"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 45,
        event: "APPROVE",
        comments: [],
      }),
    );
    expect(bundle.mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "success" }),
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:review-approved"] }),
    );
  });

  test("issues found -> REQUEST_CHANGES with filtered+deduped comments", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [
        {
          filename: "src/auth.ts",
          status: "modified",
          patch:
            "@@ -40,5 +40,5 @@\n unchanged40\n unchanged41\n-old42\n+new42\n unchanged43\n",
        },
      ],
    });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-issues"),
        security: fixture("security-clean"),
        smells: fixture("smells-low-confidence"),
      },
    });

    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );

    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      comments: Array<{ path: string; body: string }>;
    };
    expect(
      reviewCall.comments.filter((c) => c.path === "src/auth.ts").length,
    ).toBe(1);
    expect(
      reviewCall.comments.some((c) => c.body.includes("low-confidence")),
    ).toBe(false);

    expect(bundle.mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failure" }),
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["shopfloor:review-requested-changes"],
      }),
    );
  });

  test("iteration cap exceeded -> review-stuck, no REQUEST_CHANGES posted", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle, 3);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:review-stuck"] }),
    );
    expect(bundle.mocks.createReview).not.toHaveBeenCalled();
    const lastStatus = bundle.mocks.createCommitStatus.mock.calls.at(
      -1,
    )?.[0] as {
      state: string;
      description: string;
    };
    expect(lastStatus.state).toBe("failure");
    expect(lastStatus.description).toMatch(/cap/);
  });

  test("separate review adapter receives postReview call (two-App setup)", async () => {
    // When the caller configures a secondary GitHub App for reviews, the
    // createReview call must go through that second adapter's octokit so the
    // reviewer identity differs from the PR author. Every other mutation
    // (labels, comments, statuses, PR body edits) must still land on the
    // primary adapter that owns write access to the issue tracker.
    const primary = makeMockAdapter();
    const review = makeMockAdapter();
    primeImplPr(primary);
    await aggregateReview(
      primary.adapter,
      {
        issueNumber: 42,
        prNumber: 45,
        confidenceThreshold: 80,
        maxIterations: 3,
        reviewerOutputs: {
          compliance: fixture("compliance-issues"),
          bugs: fixture("bugs-clean"),
          security: fixture("security-clean"),
          smells: fixture("smells-clean"),
        },
      },
      review.adapter,
    );
    expect(review.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    expect(primary.mocks.createReview).not.toHaveBeenCalled();
    expect(primary.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["shopfloor:review-requested-changes"],
      }),
    );
    expect(primary.mocks.createCommitStatus).toHaveBeenCalled();
    expect(review.mocks.addLabels).not.toHaveBeenCalled();
    expect(review.mocks.createCommitStatus).not.toHaveBeenCalled();
  });

  test("exits no-op when PR head SHA has drifted from the analysed SHA", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "newsha" },
        body: "Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      analysedSha: "oldsha",
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    expect(bundle.mocks.createReview).not.toHaveBeenCalled();
    expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
  });

  test('matrix cell failed (empty output) -> treated as "no findings"', async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: "",
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE" }),
    );
  });

  test("issueNumber omitted -> labels land on PR number", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        // Non-shopfloor human PR: no metadata footer.
        body: "Quick fix for the sidebar.",
      },
    });
    await aggregateReview(bundle.adapter, {
      prNumber: 77,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 77, // label target falls back to PR number
        labels: ["shopfloor:review-requested-changes"],
      }),
    );
    expect(bundle.mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 77,
        name: "shopfloor:needs-review",
      }),
    );
  });

  test("drops comments whose line is outside the PR diff hunks and surfaces them in the body", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    // src/auth.ts is changed but only lines 1-3 are in the diff. The
    // compliance-issues fixture targets line 42 RIGHT, which GitHub would
    // reject with "Line could not be resolved". The aggregator must drop it
    // before posting and surface it in the review body so the next iteration
    // can self-correct.
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [
        {
          filename: "src/auth.ts",
          status: "modified",
          patch: "@@ -1,3 +1,3 @@\n-old1\n+new1\n unchanged2\n unchanged3\n",
        },
      ],
    });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      body: string;
      comments: Array<{ path: string; line: number }>;
    };
    expect(reviewCall.comments).toHaveLength(0);
    expect(reviewCall.body).toMatch(/dropped/i);
    expect(reviewCall.body).toContain("src/auth.ts:42");
  });

  test("drops comments whose file is not part of the PR diff", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    bundle.mocks.listFiles.mockResolvedValueOnce({ data: [] });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      body: string;
      comments: Array<{ path: string; line: number }>;
    };
    expect(reviewCall.comments).toHaveLength(0);
    expect(reviewCall.body).toContain("src/auth.ts:42");
  });

  test("keeps comments that land inside a diff hunk", async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [
        {
          filename: "src/auth.ts",
          status: "modified",
          patch:
            "@@ -40,5 +40,5 @@\n unchanged40\n unchanged41\n-old42\n+new42\n unchanged43\n",
        },
      ],
    });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      body: string;
      comments: Array<{ path: string; line: number }>;
    };
    expect(reviewCall.comments).toHaveLength(1);
    expect(reviewCall.comments[0].path).toBe("src/auth.ts");
    expect(reviewCall.comments[0].line).toBe(42);
  });

  test("posts REQUEST_CHANGES with empty comments when every finding is off-diff", async () => {
    // GitHub's createReview is atomic on comments: any single off-diff line
    // 422s the entire call. With every comment dropped, post the review with
    // an empty comments array so the body-level summary still lands and the
    // status check fails visibly.
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    bundle.mocks.listFiles.mockResolvedValueOnce({ data: [] });
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    // We still post a REQUEST_CHANGES so the dropped findings are visible,
    // but the comments array must be empty (otherwise GitHub 422s).
    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      event: string;
      comments: unknown[];
    };
    expect(reviewCall.event).toBe("REQUEST_CHANGES");
    expect(reviewCall.comments).toEqual([]);
  });

  test("inserts Shopfloor-Review-Iteration footer when absent", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        body: "Fixes a rendering bug.\n",
      },
    });
    await aggregateReview(bundle.adapter, {
      prNumber: 77,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture("compliance-issues"),
        bugs: fixture("bugs-clean"),
        security: fixture("security-clean"),
        smells: fixture("smells-clean"),
      },
    });
    const updatePrCall = bundle.mocks.updatePr.mock.calls.at(-1)?.[0] as {
      body: string;
    };
    expect(updatePrCall.body).toMatch(/Shopfloor-Review-Iteration: 1/);
    // Original body preserved.
    expect(updatePrCall.body).toContain("Fixes a rendering bug.");
  });
});
