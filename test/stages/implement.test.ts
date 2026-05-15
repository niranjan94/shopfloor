import { describe, expect, it, vi } from "vitest";
import { runImplement } from "../../src/stages/implement/runner.js";
import { applyImplement } from "../../src/stages/implement/apply.js";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";
import type { MockGithub } from "../github/_mock-github.js";
import type { StageContext } from "../../src/stages/_shared/context.js";
import type { Config } from "../../src/config/inputs.js";

const baseConfig: Config = {
  anthropicApiKey: "x",
  claudeCodeOAuthToken: "",
  githubApp: { clientId: "id", privateKey: "key" },
  reviewGithubApp: { clientId: "rid", privateKey: "rkey" },
  sshSigningKey: null,
  triggerLabel: null,
  maxReviewIterations: 3,
  triageModel: "claude-haiku",
  specModel: "claude-opus",
  planModel: "claude-opus",
  implModel: "claude-opus",
  reviewModels: {
    compliance: "claude-opus",
    bugs: "claude-opus",
    security: "claude-opus",
    smells: "claude-opus",
  },
  triageEffort: "high",
  specEffort: "high",
  planEffort: "high",
  implEffort: "high",
  reviewEfforts: {
    compliance: "high",
    bugs: "high",
    security: "high",
    smells: "high",
  },
  triageMaxBudgetUsd: 0.25,
  specMaxBudgetUsd: 1.5,
  planMaxBudgetUsd: 1.5,
  implMaxBudgetUsd: 2.5,
  reviewMaxBudgetUsdPerLens: 0.75,
  triageTimeoutMs: 60_000,
  specTimeoutMs: 120_000,
  planTimeoutMs: 120_000,
  implTimeoutMs: 360_000,
  reviewTimeoutMsPerLens: 90_000,
  mode: "auto" as const,
  stages: [] as Array<"triage" | "spec" | "plan" | "implement" | "review">,
};

function defaultMockGithub(): MockGithub {
  const mg = makeMockGithub();
  mg.openStagePr.mockResolvedValue({ number: 200, url: "https://x/pr/200" });
  // Mock reflects the post-markPullRequestReadyForReview state: draft is
  // false by the time check-review-skip reads the PR.
  mg.getPr.mockResolvedValue({
    state: "open",
    draft: false,
    merged: false,
    labels: [],
    head: { sha: "head-sha" },
    body: "",
  });
  mg.listChangedFiles.mockResolvedValue(["src/x.ts"]);
  mg.getPrReviewsAtSha.mockResolvedValue([]);
  return mg;
}

function makeCtx(opts: { hasReviewApp: boolean; mg?: MockGithub }) {
  const mg = opts.mg ?? defaultMockGithub();
  const audit = vi.fn();
  const ctx: StageContext = {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    defaultBranch: "main",
    decision: { stage: "implement" },
    issue: {
      number: 42,
      title: "feat: do thing",
      body: "...",
      labels: ["shopfloor:implementing"],
    },
    github: asAdapter(mg),
    reviewGithub: opts.hasReviewApp ? asAdapter(makeMockGithub()) : null,
    agent: new MockAgentAdapter([]),
    audit,
    config: baseConfig,
    runId: "r1",
  };
  return { ctx, mg, audit };
}

const decision = {
  pr_title: "feat: do thing (#42)",
  pr_body: "Implements #42.",
  summary_for_issue_comment: "Did the thing.",
  changed_files: ["src/thing.ts"],
};

describe("runImplement", () => {
  it("renders the user prompt with provided branch + paths and returns parsed decision", async () => {
    const mg = defaultMockGithub();
    const audit = vi.fn();
    const ctx: StageContext = {
      event: {} as never,
      repo: { owner: "octo", name: "demo" },
      defaultBranch: "main",
      decision: { stage: "implement" },
      issue: {
        number: 42,
        title: "do thing",
        body: "issue body",
        labels: ["shopfloor:implementing"],
      },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([
        {
          matchUserPromptIncludes: "shopfloor/impl/42-do-thing",
          decision,
        },
      ]),
      audit,
      config: baseConfig,
      runId: "r1",
    };
    const result = await runImplement(ctx, {
      progressCommentId: 9,
      branchName: "shopfloor/impl/42-do-thing",
      specFilePath: "docs/shopfloor/specs/42-do-thing.md",
      planFilePath: "docs/shopfloor/plans/42-do-thing.md",
      bashAllowlist: "pnpm test",
      revisionBlock: "",
    });
    expect(result.pr_title).toContain("feat:");
    expect(result.changed_files).toEqual(["src/thing.ts"]);
  });
});

describe("applyImplement", () => {
  it("opens a draft impl PR, finalizes progress, marks ready, and routes to needs-review when review app + no skip", async () => {
    const { ctx, mg } = makeCtx({ hasReviewApp: true });
    const result = await applyImplement(ctx, {
      decision,
      progressCommentId: 9,
      branchName: "shopfloor/impl/42-do-thing",
      baseBranch: "main",
    });
    expect(result.prNumber).toBe(200);
    expect(result.nextLabel).toBe("shopfloor:needs-review");
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "implement",
        draft: true,
        preserveBodyIfExists: true,
      }),
    );
    expect(mg.updateComment).toHaveBeenCalledWith(
      9,
      expect.stringContaining("Did the thing"),
    );
    expect(mg.markPullRequestReadyForReview).toHaveBeenCalledWith(200);
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:needs-review");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:implementing");
  });

  it("routes to impl-in-review when no review App is configured", async () => {
    const { ctx, mg } = makeCtx({ hasReviewApp: false });
    const result = await applyImplement(ctx, {
      decision,
      progressCommentId: 9,
      branchName: "shopfloor/impl/42-do-thing",
      baseBranch: "main",
    });
    expect(result.nextLabel).toBe("shopfloor:impl-in-review");
    expect(result.skipReason).toBe("no_review_app_configured");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:impl-in-review");
  });

  it("routes to impl-in-review when checkReviewSkip flags docs-only", async () => {
    const mg = defaultMockGithub();
    mg.listChangedFiles.mockResolvedValue(["docs/shopfloor/plans/x.md"]);
    const { ctx } = makeCtx({ hasReviewApp: true, mg });
    const result = await applyImplement(ctx, {
      decision,
      progressCommentId: 9,
      branchName: "shopfloor/impl/42-do-thing",
      baseBranch: "main",
    });
    expect(result.nextLabel).toBe("shopfloor:impl-in-review");
    expect(result.skipReason).toBe("only_shopfloor_docs");
  });

  it("refuses to finalize when shopfloor:implementing marker is absent", async () => {
    const mg = defaultMockGithub();
    const audit = vi.fn();
    const ctx: StageContext = {
      event: {} as never,
      repo: { owner: "octo", name: "demo" },
      defaultBranch: "main",
      decision: { stage: "implement" },
      issue: {
        number: 42,
        title: "x",
        body: "",
        labels: [],
      },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit,
      config: baseConfig,
      runId: "r1",
    };
    await expect(
      applyImplement(ctx, {
        decision,
        progressCommentId: 9,
        branchName: "shopfloor/impl/42-do-thing",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/implementing marker is not present/);
  });

  it("preserves the review iteration footer in the PR body update", async () => {
    const mg = defaultMockGithub();
    mg.getPr.mockResolvedValue({
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "head-sha" },
      body: "old body\n\nShopfloor-Review-Iteration: 2",
    });
    const { ctx } = makeCtx({ hasReviewApp: true, mg });
    await applyImplement(ctx, {
      decision,
      progressCommentId: 9,
      branchName: "shopfloor/impl/42-do-thing",
      baseBranch: "main",
    });
    const updateCall = mg.updatePr.mock.calls[0]![1] as { body: string };
    expect(updateCall.body).toContain("Shopfloor-Review-Iteration: 2");
  });
});
