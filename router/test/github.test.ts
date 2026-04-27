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
    createPr: vi.fn().mockResolvedValue({
      data: { number: 100, html_url: "https://x/pr/100" },
    }),
    listPrs: vi.fn().mockResolvedValue({ data: [] }),
    updatePr: vi.fn().mockResolvedValue({ data: {} }),
    getPr: vi.fn().mockResolvedValue({ data: {} }),
    listFiles: vi.fn().mockResolvedValue({ data: [] }),
    createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
    listReviews: vi.fn().mockResolvedValue({ data: [] }),
    listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
    listIssueComments: vi.fn().mockResolvedValue({ data: [] }),
    createCommitStatus: vi.fn().mockResolvedValue({ data: {} }),
    getRef: vi
      .fn()
      .mockResolvedValue({ data: { object: { sha: "main-sha" } } }),
    createRef: vi.fn().mockResolvedValue({ data: {} }),
    getContent: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("nope"), { status: 404 })),
    createOrUpdateFileContents: vi.fn().mockResolvedValue({ data: {} }),
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
        listComments: mocks.listIssueComments,
      },
      pulls: {
        create: mocks.createPr,
        list: mocks.listPrs,
        update: mocks.updatePr,
        get: mocks.getPr,
        listFiles: mocks.listFiles,
        createReview: mocks.createReview,
        listReviews: mocks.listReviews,
        listReviewComments: mocks.listReviewComments,
      },
      repos: {
        createCommitStatus: mocks.createCommitStatus,
        getContent: mocks.getContent,
        createOrUpdateFileContents: mocks.createOrUpdateFileContents,
      },
      git: {
        getRef: mocks.getRef,
        createRef: mocks.createRef,
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

  test("openStagePr creates when no existing PR and injects metadata", async () => {
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
    expect(mocks.listPrs).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "niranjan94",
        repo: "shopfloor",
        head: "niranjan94:shopfloor/spec/42-x",
        state: "open",
      }),
    );
    expect(mocks.updatePr).not.toHaveBeenCalled();
    const call = mocks.createPr.mock.calls[0][0] as { body: string };
    expect(call.body).toMatch(/Shopfloor-Issue: #42/);
    expect(call.body).toMatch(/Shopfloor-Stage: spec/);
    expect(call.body).toMatch(/Body text\./);
  });

  test("openStagePr upserts existing spec PR by updating title and body", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.listPrs.mockResolvedValueOnce({
      data: [{ number: 77, html_url: "https://x/pr/77" }],
    });
    const adapter = new GitHubAdapter(octokit, repo);
    const result = await adapter.openStagePr({
      base: "main",
      head: "shopfloor/spec/42-x",
      title: "Spec for #42 (retry)",
      body: "Fresh body.",
      stage: "spec",
      issueNumber: 42,
    });
    expect(result.number).toBe(77);
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 77,
        title: "Spec for #42 (retry)",
        body: expect.stringMatching(/Fresh body\./),
      }),
    );
  });

  test("openStagePr upserts existing impl PR without clobbering title or body when preserveBodyIfExists is set", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.listPrs.mockResolvedValueOnce({
      data: [{ number: 88, html_url: "https://x/pr/88" }],
    });
    const adapter = new GitHubAdapter(octokit, repo);
    const result = await adapter.openStagePr({
      base: "main",
      head: "shopfloor/impl/42-x",
      title: "wip: whatever",
      body: "Placeholder body",
      stage: "implement",
      issueNumber: 42,
      preserveBodyIfExists: true,
    });
    expect(result.number).toBe(88);
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.updatePr).not.toHaveBeenCalled();
  });

  test("listPrReviews returns reviews with state and submitted_at", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 10,
          user: { login: "reviewer" },
          body: "please fix",
          commit_id: "abc",
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-04-14T12:00:00Z",
        },
        {
          id: 11,
          user: null,
          body: null,
          commit_id: "abc",
          state: "COMMENTED",
          submitted_at: null,
        },
      ],
    });
    const adapter = new GitHubAdapter(octokit, repo);
    const reviews = await adapter.listPrReviews(45);
    expect(mocks.listReviews).toHaveBeenCalledWith({
      owner: "niranjan94",
      repo: "shopfloor",
      pull_number: 45,
      per_page: 100,
    });
    expect(reviews).toEqual([
      {
        id: 10,
        user: { login: "reviewer" },
        body: "please fix",
        commit_id: "abc",
        state: "changes_requested",
        submitted_at: "2026-04-14T12:00:00Z",
      },
      {
        id: 11,
        user: null,
        body: "",
        commit_id: "abc",
        state: "commented",
        submitted_at: null,
      },
    ]);
  });

  test("listPrReviewComments returns inline comments with review id", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 501,
          pull_request_review_id: 10,
          path: "src/auth.ts",
          line: 42,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "rename this",
        },
      ],
    });
    const adapter = new GitHubAdapter(octokit, repo);
    const comments = await adapter.listPrReviewComments(45);
    expect(mocks.listReviewComments).toHaveBeenCalledWith({
      owner: "niranjan94",
      repo: "shopfloor",
      pull_number: 45,
      per_page: 100,
      page: 1,
    });
    expect(comments).toEqual([
      {
        id: 501,
        pull_request_review_id: 10,
        path: "src/auth.ts",
        line: 42,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        body: "rename this",
      },
    ]);
  });

  test("listPrReviewComments paginates across exact-100-item pages", async () => {
    const { octokit, mocks } = makeMockOctokit();
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      pull_request_review_id: 10,
      path: "src/file.ts",
      line: i + 1,
      side: "RIGHT",
      start_line: null,
      start_side: null,
      body: `comment ${i}`,
    }));
    const secondPage = [
      {
        id: 2000,
        pull_request_review_id: 10,
        path: "src/file.ts",
        line: 500,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        body: "final comment",
      },
    ];
    mocks.listReviewComments
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: secondPage });
    const adapter = new GitHubAdapter(octokit, repo);
    const comments = await adapter.listPrReviewComments(45);
    expect(comments).toHaveLength(101);
    expect(mocks.listReviewComments).toHaveBeenCalledTimes(2);
    expect(mocks.listReviewComments).toHaveBeenNthCalledWith(1, {
      owner: "niranjan94",
      repo: "shopfloor",
      pull_number: 45,
      per_page: 100,
      page: 1,
    });
    expect(mocks.listReviewComments).toHaveBeenNthCalledWith(2, {
      owner: "niranjan94",
      repo: "shopfloor",
      pull_number: 45,
      per_page: 100,
      page: 2,
    });
  });

  test("listIssueComments returns issue comments with user and created_at", async () => {
    const { octokit, mocks } = makeMockOctokit();
    mocks.listIssueComments.mockResolvedValueOnce({
      data: [
        {
          user: { login: "alice" },
          created_at: "2026-04-14T09:00:00Z",
          body: "please also cover the edge case",
        },
        {
          user: null,
          created_at: "2026-04-14T10:00:00Z",
          body: null,
        },
      ],
    });
    const adapter = new GitHubAdapter(octokit, repo);
    const comments = await adapter.listIssueComments(42);
    expect(mocks.listIssueComments).toHaveBeenCalledWith({
      owner: "niranjan94",
      repo: "shopfloor",
      issue_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(comments).toEqual([
      {
        user: { login: "alice" },
        created_at: "2026-04-14T09:00:00Z",
        body: "please also cover the edge case",
      },
      {
        user: null,
        created_at: "2026-04-14T10:00:00Z",
        body: null,
      },
    ]);
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

describe("GitHubAdapter Git Data + Contents API surface", () => {
  test("getRefSha returns the SHA for a heads ref", async () => {
    const getRef = vi
      .fn()
      .mockResolvedValue({ data: { object: { sha: "abc123" } } });
    const octokit = {
      rest: { git: { getRef } },
    } as unknown as OctokitLike;
    const adapter = new GitHubAdapter(octokit, { owner: "o", repo: "r" });
    expect(await adapter.getRefSha("main")).toBe("abc123");
    expect(getRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/main",
    });
  });

  test("createRef creates a new branch ref", async () => {
    const createRef = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await adapter.createRef("shopfloor/spec/42-foo", "abc123");
    expect(createRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "refs/heads/shopfloor/spec/42-foo",
      sha: "abc123",
    });
  });

  test("createRef rethrows non-422 errors", async () => {
    const createRef = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await expect(adapter.createRef("b", "s")).rejects.toThrow("boom");
  });

  test("createRef swallows 422 (ref already exists) and returns false", async () => {
    const createRef = vi.fn().mockRejectedValue(
      Object.assign(new Error("Reference already exists"), {
        status: 422,
      }),
    );
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(await adapter.createRef("b", "s")).toBe(false);
  });

  test("getFileSha returns null on 404 and the blob sha when present", async () => {
    const get404 = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 404 }));
    const adapter404 = new GitHubAdapter(
      { rest: { repos: { getContent: get404 } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(
      await adapter404.getFileSha("path/to/x.md", "shopfloor/spec/1-x"),
    ).toBeNull();

    const getOk = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: "blob123", type: "file" } });
    const adapterOk = new GitHubAdapter(
      { rest: { repos: { getContent: getOk } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(
      await adapterOk.getFileSha("path/to/x.md", "shopfloor/spec/1-x"),
    ).toBe("blob123");
  });

  test("putFileContents creates a file (no sha) and updates one (with sha)", async () => {
    const put = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter(
      {
        rest: { repos: { createOrUpdateFileContents: put } },
      } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await adapter.putFileContents({
      path: "docs/spec.md",
      branch: "shopfloor/spec/1-x",
      message: "docs(spec): seed",
      content: "hi",
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        path: "docs/spec.md",
        branch: "shopfloor/spec/1-x",
        message: "docs(spec): seed",
        content: Buffer.from("hi", "utf8").toString("base64"),
      }),
    );
    const callWithSha = put.mock.calls[0][0] as { sha?: string };
    expect(callWithSha.sha).toBeUndefined();

    await adapter.putFileContents({
      path: "docs/spec.md",
      branch: "shopfloor/spec/1-x",
      message: "docs(spec): update",
      content: "hi2",
      sha: "blob123",
    });
    const second = put.mock.calls[1][0] as { sha?: string };
    expect(second.sha).toBe("blob123");
  });
});
