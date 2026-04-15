import { describe, expect, test } from "vitest";
import { applyImplPostwork } from "../../src/helpers/apply-impl-postwork";
import { makeMockAdapter } from "./_mock-adapter";

describe("applyImplPostwork", () => {
  test("normal impl PR -> needs-review, updates PR body + title", async () => {
    const bundle = makeMockAdapter();
    // implementing-marker assertion check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [
          { name: "shopfloor:needs-impl" },
          { name: "shopfloor:implementing" },
        ],
        state: "open",
      },
    });
    // First getPr call: new fetch in applyImplPostwork to read existing iteration
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    // Second getPr call: checkReviewSkip's getPr
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [{ filename: "src/auth.ts" }],
    });
    // checkReviewSkip origin-issue check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    const result = await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: "feat: add GitHub OAuth login (#42)",
      prBody: "Full implementation body",
    });
    expect(result.nextLabel).toBe("shopfloor:needs-review");
    expect(bundle.mocks.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 45,
        title: "feat: add GitHub OAuth login (#42)",
      }),
    );
    const writtenBody = bundle.mocks.updatePr.mock.calls[0][0].body as string;
    expect(writtenBody).toContain("Full implementation body");
    expect(writtenBody).toContain("Shopfloor-Issue: #42");
    expect(writtenBody).toContain("Shopfloor-Stage: implement");
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:needs-review"] }),
    );
  });

  test("skip-review on PR -> impl-in-review", async () => {
    const bundle = makeMockAdapter();
    // implementing-marker assertion check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [
          { name: "shopfloor:needs-impl" },
          { name: "shopfloor:implementing" },
        ],
        state: "open",
      },
    });
    // First getPr call: new fetch in applyImplPostwork to read existing iteration
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [{ name: "shopfloor:skip-review" }],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    // Second getPr call: checkReviewSkip's getPr
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [{ name: "shopfloor:skip-review" }],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [{ filename: "src/auth.ts" }],
    });
    // checkReviewSkip origin-issue check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    const result = await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: "title",
      prBody: "body",
    });
    expect(result.nextLabel).toBe("shopfloor:impl-in-review");
  });

  test("throws when shopfloor:implementing marker is not present", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:needs-impl" }], state: "open" },
    });
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        labels: [],
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "x" },
        body: "",
      },
    });
    await expect(
      applyImplPostwork(bundle.adapter, {
        issueNumber: 42,
        prNumber: 45,
        prTitle: "t",
        prBody: "b",
      }),
    ).rejects.toThrow(/implementing/);
  });

  test("removes shopfloor:implementing as part of the transition", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [
          { name: "shopfloor:needs-impl" },
          { name: "shopfloor:implementing" },
        ],
        state: "open",
      },
    });
    // First getPr call: new fetch in applyImplPostwork to read existing iteration
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    // Second getPr call: checkReviewSkip's getPr
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "abc" },
        body: "Body\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      },
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [{ filename: "src/auth.ts" }],
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: "t",
      prBody: "b",
    });
    expect(bundle.mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:implementing" }),
    );
  });

  test("rewrites PR body with Shopfloor metadata footer, preserving iteration from existing body", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [
          { name: "shopfloor:needs-impl" },
          { name: "shopfloor:implementing" },
        ],
        state: "open",
      },
    });
    // First getPr call: new fetch in applyImplPostwork to read existing iteration
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        labels: [],
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "x" },
        body: "Old agent narrative.\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 2\n",
      },
    });
    // Second getPr call: checkReviewSkip's getPr
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        labels: [],
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "x" },
        body: "Old agent narrative.\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 2\n",
      },
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({
      data: [{ filename: "src/x.ts" }],
    });
    // checkReviewSkip origin-issue check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: "feat: x",
      prBody: "New agent narrative from this run.",
    });

    const updatePrCalls = bundle.mocks.updatePr.mock.calls;
    const lastCall = updatePrCalls[updatePrCalls.length - 1];
    const writtenBody = lastCall[0].body as string;
    expect(writtenBody).toContain("New agent narrative from this run.");
    expect(writtenBody).toContain("---");
    expect(writtenBody).toContain("Shopfloor-Issue: #42");
    expect(writtenBody).toContain("Shopfloor-Stage: implement");
    expect(writtenBody).toContain("Shopfloor-Review-Iteration: 2");
  });
});
