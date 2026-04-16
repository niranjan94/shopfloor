import { describe, expect, test } from "vitest";
import { checkReviewSkip } from "../../src/helpers/check-review-skip";
import { makeMockAdapter, type MockBundle } from "./_mock-adapter";

interface PrFixture {
  labels?: Array<{ name: string }>;
  body?: string;
  state?: "open" | "closed";
  draft?: boolean;
  headSha?: string;
  changedFiles?: string[];
  issueLabels?: Array<{ name: string }>;
  issueState?: "open" | "closed";
  reviewsAtSha?: Array<{
    commit_id: string;
    body: string;
    id: number;
    user: unknown;
  }>;
}

function primePrFixture(bundle: MockBundle, fixture: PrFixture): void {
  const sha = fixture.headSha ?? "abc";
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: fixture.state ?? "open",
      draft: fixture.draft ?? false,
      merged: false,
      labels: fixture.labels ?? [],
      head: { sha },
      body:
        fixture.body ??
        "Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\n",
    },
  });
  bundle.mocks.listFiles.mockResolvedValueOnce({
    data: (fixture.changedFiles ?? ["src/foo.ts"]).map((f) => ({
      filename: f,
    })),
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: fixture.issueLabels ?? [],
      state: fixture.issueState ?? "open",
    },
  });
  bundle.mocks.listReviews.mockResolvedValueOnce({
    data: fixture.reviewsAtSha ?? [],
  });
}

describe("checkReviewSkip", () => {
  test("skip=true when PR has shopfloor:skip-review label", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, { labels: [{ name: "shopfloor:skip-review" }] });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("skip_review_label_pr");
  });

  test("skip=true when PR has shopfloor:wip label", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, { labels: [{ name: "shopfloor:wip" }] });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("pr_wip_label");
  });

  test("skip=true when PR changed files are all in docs/shopfloor/", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, { changedFiles: ["docs/shopfloor/specs/42-x.md"] });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("only_shopfloor_docs");
  });

  test("skip=false on normal impl PR", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, { changedFiles: ["src/auth.ts"] });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(false);
  });

  test("skip=true when origin issue carries shopfloor:skip-review", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, {
      issueLabels: [{ name: "shopfloor:skip-review" }],
      changedFiles: ["src/auth.ts"],
    });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("skip_review_label_issue");
  });

  test("skip=true when origin issue is closed", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, {
      issueState: "closed",
      changedFiles: ["src/auth.ts"],
    });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("origin_issue_closed");
  });

  test("skip=true when already reviewed at this SHA", async () => {
    const bundle = makeMockAdapter();
    primePrFixture(bundle, {
      changedFiles: ["src/auth.ts"],
      headSha: "deadbeef",
      reviewsAtSha: [
        {
          id: 1,
          user: { login: "shopfloor-bot" },
          body: "<!-- shopfloor-review -->\nclean",
          commit_id: "deadbeef",
        },
      ],
    });
    const result = await checkReviewSkip(bundle.adapter, 45);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("already_reviewed_at_sha");
  });
});
