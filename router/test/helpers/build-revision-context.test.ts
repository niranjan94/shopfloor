import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockAdapter } from "./_mock-adapter";
import { buildRevisionContext } from "../../src/helpers/build-revision-context";

describe("buildRevisionContext", () => {
  let tempDir: string;
  let outputPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "build-rev-ctx-"));
    outputPath = join(tempDir, "context.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("happy path: writes context with filtered comments and rendered fragment", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [],
        state: "open",
        title: "Add OAuth login",
        body: "We need OAuth.",
      },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "headsha" },
        body: "PR body\n\nShopfloor-Review-Iteration: 2",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 100,
          user: { login: "reviewer-bot" },
          body: "first",
          commit_id: "sha1",
          state: "commented",
          submitted_at: "2026-04-15T10:00:00Z",
        },
        {
          id: 101,
          user: { login: "reviewer-bot" },
          body: "needs changes",
          commit_id: "sha2",
          state: "changes_requested",
          submitted_at: "2026-04-15T11:00:00Z",
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          pull_request_review_id: 99,
          path: "src/old.ts",
          line: 1,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "stale",
        },
        {
          id: 2,
          pull_request_review_id: 101,
          path: "src/foo.ts",
          line: 42,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "fix this",
        },
        {
          id: 3,
          pull_request_review_id: 101,
          path: "src/bar.ts",
          line: 10,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "and this",
        },
      ],
    });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "implement",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/impl/42-add-oauth",
      specFilePath: "docs/shopfloor/specs/42-add-oauth.md",
      planFilePath: "docs/shopfloor/plans/42-add-oauth.md",
      progressCommentId: "999",
      bashAllowlist: "pnpm test",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/implement-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written.issue_number).toBe("42");
    expect(written.issue_title).toBe("Add OAuth login");
    expect(written.issue_body).toBe("We need OAuth.");
    expect(written.branch_name).toBe("shopfloor/impl/42-add-oauth");
    expect(written.iteration_count).toBe("2");

    const reviewComments = JSON.parse(written.review_comments_json) as Array<{
      path: string;
    }>;
    expect(reviewComments).toHaveLength(2);
    expect(reviewComments.map((c) => c.path).sort()).toEqual([
      "src/bar.ts",
      "src/foo.ts",
    ]);

    expect(written.revision_block).toContain("THIS IS A REVISION RUN");
    expect(written.revision_block).toContain("iteration 2");
    expect(written.revision_block).toContain("src/foo.ts");
  });

  test("throws when no REQUEST_CHANGES review is found", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "t", body: "b" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 1",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          user: { login: "x" },
          body: "",
          commit_id: "x",
          state: "approved",
          submitted_at: null,
        },
      ],
    });

    await expect(
      buildRevisionContext(adapter, {
        issueNumber: 42,
        prNumber: 45,
        branchName: "shopfloor/impl/42-x",
        specFilePath: "docs/shopfloor/specs/42-x.md",
        planFilePath: "docs/shopfloor/plans/42-x.md",
        progressCommentId: "0",
        bashAllowlist: "",
        repoOwner: "o",
        repoName: "r",
        outputPath,
        promptFragmentPath: "prompts/implement-revision-fragment.md",
      }),
    ).rejects.toThrow(/no REQUEST_CHANGES review/);
  });

  test("picks latest review by id when submitted_at is null on both", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "t", body: "b" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 1",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 100,
          user: { login: "reviewer-bot" },
          body: "older",
          commit_id: "sha1",
          state: "changes_requested",
          submitted_at: null,
        },
        {
          id: 200,
          user: { login: "reviewer-bot" },
          body: "newer",
          commit_id: "sha2",
          state: "changes_requested",
          submitted_at: null,
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          pull_request_review_id: 100,
          path: "src/old.ts",
          line: 1,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "stale",
        },
        {
          id: 2,
          pull_request_review_id: 200,
          path: "src/new.ts",
          line: 7,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "fresh",
        },
      ],
    });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "implement",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/impl/42-x",
      specFilePath: "docs/shopfloor/specs/42-x.md",
      planFilePath: "docs/shopfloor/plans/42-x.md",
      progressCommentId: "0",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/implement-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    const reviewComments = JSON.parse(written.review_comments_json) as Array<{
      path: string;
    }>;
    expect(reviewComments).toHaveLength(1);
    expect(reviewComments[0].path).toBe("src/new.ts");
  });

  test("picks latest review by id when submitted_at is equal", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "t", body: "b" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 1",
      },
    });
    const sameTime = "2026-04-15T12:00:00Z";
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 300,
          user: { login: "reviewer-bot" },
          body: "older",
          commit_id: "sha1",
          state: "changes_requested",
          submitted_at: sameTime,
        },
        {
          id: 400,
          user: { login: "reviewer-bot" },
          body: "newer",
          commit_id: "sha2",
          state: "changes_requested",
          submitted_at: sameTime,
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          pull_request_review_id: 300,
          path: "src/old.ts",
          line: 1,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "stale",
        },
        {
          id: 2,
          pull_request_review_id: 400,
          path: "src/new.ts",
          line: 7,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "fresh",
        },
      ],
    });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "implement",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/impl/42-x",
      specFilePath: "docs/shopfloor/specs/42-x.md",
      planFilePath: "docs/shopfloor/plans/42-x.md",
      progressCommentId: "0",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/implement-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    const reviewComments = JSON.parse(written.review_comments_json) as Array<{
      path: string;
    }>;
    expect(reviewComments).toHaveLength(1);
    expect(reviewComments[0].path).toBe("src/new.ts");
  });

  test("implement stage passes paths, not full contents", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "t", body: "b" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 1",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          user: { login: "x" },
          body: "",
          commit_id: "x",
          state: "changes_requested",
          submitted_at: null,
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({ data: [] });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "implement",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/impl/42-add-oauth",
      specFilePath: "docs/shopfloor/specs/42-add-oauth.md",
      planFilePath: "docs/shopfloor/plans/42-add-oauth.md",
      progressCommentId: "0",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/implement-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written.spec_file_path).toBe("docs/shopfloor/specs/42-add-oauth.md");
    expect(written.plan_file_path).toBe("docs/shopfloor/plans/42-add-oauth.md");
    expect(written).not.toHaveProperty("spec_source");
    expect(written).not.toHaveProperty("plan_file_contents");
  });

  test("spec stage renders spec-revision-fragment and outputs spec context shape", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "Spec issue", body: "body" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 0",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 50,
          user: { login: "reviewer" },
          body: "fix it",
          commit_id: "sha1",
          state: "changes_requested",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          pull_request_review_id: 50,
          path: "docs/spec.md",
          line: 5,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "expand this section",
        },
      ],
    });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "spec",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/spec/42-spec-issue",
      specFilePath: "docs/shopfloor/specs/42-spec-issue.md",
      planFilePath: "",
      progressCommentId: "",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/spec-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written.spec_file_path).toBe(
      "docs/shopfloor/specs/42-spec-issue.md",
    );
    expect(written.triage_rationale).toBe("");
    expect(written.revision_block).toContain("THIS IS A REVISION RUN");
    expect(written.revision_block).toContain("existing spec PR");
    expect(written.revision_block).toContain("expand this section");
    expect(written).not.toHaveProperty("plan_file_path");
    expect(written).not.toHaveProperty("progress_comment_id");
    expect(written).not.toHaveProperty("bash_allowlist");
  });

  test("applies Shopfloor-Spec-Path override from issue metadata onto impl revision context", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [],
        state: "open",
        title: "issue",
        body: [
          "Body.",
          "<!-- shopfloor:metadata",
          "Shopfloor-Slug: foo",
          "Shopfloor-Spec-Path: docs/specs/external.md",
          "-->",
        ].join("\n"),
      },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 1",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          user: { login: "h" },
          body: "fix it",
          commit_id: "c",
          state: "changes_requested",
          submitted_at: "2025-01-01",
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({ data: [] });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "implement",
      issueNumber: 42,
      prNumber: 7,
      branchName: "shopfloor/impl/42-foo",
      specFilePath: "docs/shopfloor/specs/42-foo.md",
      planFilePath: "docs/shopfloor/plans/42-foo.md",
      progressCommentId: "1",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/implement-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written.spec_file_path).toBe("docs/specs/external.md");
    expect(written.plan_file_path).toBe("docs/shopfloor/plans/42-foo.md");
  });

  test("plan stage renders plan-revision-fragment and outputs plan context shape", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open", title: "Plan issue", body: "body" },
    });
    mocks.getPr.mockResolvedValueOnce({
      data: {
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        head: { sha: "x" },
        body: "Shopfloor-Review-Iteration: 0",
      },
    });
    mocks.listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 60,
          user: { login: "reviewer" },
          body: "revise",
          commit_id: "sha1",
          state: "changes_requested",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ],
    });
    mocks.listReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          pull_request_review_id: 60,
          path: "docs/plan.md",
          line: 3,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          body: "add test step",
        },
      ],
    });
    mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

    await buildRevisionContext(adapter, {
      stage: "plan",
      issueNumber: 42,
      prNumber: 45,
      branchName: "shopfloor/plan/42-plan-issue",
      specFilePath: "docs/shopfloor/specs/42-plan-issue.md",
      planFilePath: "docs/shopfloor/plans/42-plan-issue.md",
      progressCommentId: "",
      bashAllowlist: "",
      repoOwner: "o",
      repoName: "r",
      outputPath,
      promptFragmentPath: "prompts/plan-revision-fragment.md",
    });

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written.plan_file_path).toBe(
      "docs/shopfloor/plans/42-plan-issue.md",
    );
    expect(written.spec_file_path).toBe(
      "docs/shopfloor/specs/42-plan-issue.md",
    );
    expect(written.revision_block).toContain("THIS IS A REVISION RUN");
    expect(written.revision_block).toContain("existing plan PR");
    expect(written.revision_block).toContain("add test step");
    expect(written).not.toHaveProperty("progress_comment_id");
    expect(written).not.toHaveProperty("bash_allowlist");
    expect(written).not.toHaveProperty("triage_rationale");
  });
});
