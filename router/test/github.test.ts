import { describe, expect, test, vi } from "vitest";
import { GitHubAdapter } from "../src/github";
import type { OctokitLike } from "../src/types";

function makeMockOctokit(): {
  octokit: OctokitLike;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
    updateComment: vi.fn().mockResolvedValue({ data: {} }),
    createLabel: vi.fn().mockResolvedValue({ data: {} }),
    listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
    updateIssue: vi.fn().mockResolvedValue({ data: {} }),
    getIssue: vi
      .fn()
      .mockResolvedValue({ data: { labels: [], state: "open" } }),
    createPr: vi
      .fn()
      .mockResolvedValue({
        data: { number: 100, html_url: "https://x/pr/100" },
      }),
    updatePr: vi.fn().mockResolvedValue({ data: {} }),
    getPr: vi.fn().mockResolvedValue({ data: {} }),
    listFiles: vi.fn().mockResolvedValue({ data: [] }),
    createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
    listReviews: vi.fn().mockResolvedValue({ data: [] }),
    createCommitStatus: vi.fn().mockResolvedValue({ data: {} }),
  };
  const octokit: OctokitLike = {
    rest: {
      issues: {
        addLabels: mocks.addLabels,
        removeLabel: mocks.removeLabel,
        createComment: mocks.createComment,
        updateComment: mocks.updateComment,
        createLabel: mocks.createLabel,
        listLabelsForRepo: mocks.listLabelsForRepo,
        update: mocks.updateIssue,
        get: mocks.getIssue,
      },
      pulls: {
        create: mocks.createPr,
        update: mocks.updatePr,
        get: mocks.getPr,
        listFiles: mocks.listFiles,
        createReview: mocks.createReview,
        listReviews: mocks.listReviews,
      },
      repos: {
        createCommitStatus: mocks.createCommitStatus,
      },
    },
  };
  return { octokit, mocks };
}

describe("GitHubAdapter", () => {
  const repo = { owner: "niranjan94", repo: "shopfloor" };

  test("addLabel calls issues.addLabels with correct shape", async () => {
    const { octokit, mocks } = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.addLabel(42, "shopfloor:triaging");
    expect(mocks.addLabels).toHaveBeenCalledWith({
      owner: "niranjan94",
      repo: "shopfloor",
      issue_number: 42,
      labels: ["shopfloor:triaging"],
    });
  });

  test("removeLabel ignores 404s", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.removeLabel.mockRejectedValueOnce({ status: 404 });
    const adapter = new GitHubAdapter(octokit, repo);
    await expect(
      adapter.removeLabel(42, "shopfloor:triaging"),
    ).resolves.toBeUndefined();
  });

  test("postIssueComment returns comment id", async () => {
    const { octokit } = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    const id = await adapter.postIssueComment(42, "hello");
    expect(id).toBe(999);
  });

  test("openStagePr merges title, body, metadata block", async () => {
    const { octokit, mocks } = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.openStagePr({
      base: "main",
      head: "shopfloor/spec/42-x",
      title: "Spec for #42",
      body: "Body text.",
      stage: "spec",
      issueNumber: 42,
    });
    const call = mocks.createPr.mock.calls[0][0] as { body: string };
    expect(call.body).toMatch(/Shopfloor-Issue: #42/);
    expect(call.body).toMatch(/Shopfloor-Stage: spec/);
    expect(call.body).toMatch(/Body text\./);
  });

  test("setReviewStatus calls createCommitStatus with context shopfloor/review", async () => {
    const { octokit, mocks } = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.setReviewStatus("abc123", "pending", "Running...");
    expect(mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "niranjan94",
        repo: "shopfloor",
        sha: "abc123",
        state: "pending",
        context: "shopfloor/review",
        description: "Running...",
      }),
    );
  });
});
