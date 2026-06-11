import { describe, expect, it, vi } from "vitest";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import type { Config } from "../../src/config/inputs.js";
import type { StageContext } from "../../src/stages/_shared/context.js";
import { applyPlan } from "../../src/stages/plan/apply.js";
import { PlanDecision } from "../../src/stages/plan/decision.js";
import { runPlan } from "../../src/stages/plan/runner.js";
import type { MockGithub } from "../github/_mock-github.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";

const baseConfig: Config = {
  anthropicApiKey: "x",
  claudeCodeOAuthToken: "",
  agentProvider: "claude" as const,
  openaiApiKey: "",
  codexAuthJson: "",
  codexSandboxMode: "workspace-write" as const,
  codexApprovalPolicy: "never" as const,
  codexNetworkAccess: true,
  codexSkipGitRepoCheck: true,
  githubApp: { clientId: "id", privateKey: "key" },
  reviewGithubApp: null,
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
  triageMaxTurns: undefined,
  specMaxTurns: undefined,
  planMaxTurns: undefined,
  implMaxTurns: undefined,
  reviewMaxTurnsPerLens: undefined,
  triageTimeoutMs: 60_000,
  specTimeoutMs: 120_000,
  planTimeoutMs: 120_000,
  implTimeoutMs: 360_000,
  reviewTimeoutMsPerLens: 90_000,
  mode: "auto" as const,
  stages: [] as Array<"triage" | "spec" | "plan" | "implement" | "review">,
};

const decision = {
  file_path: "docs/shopfloor/plans/42-do-thing.md",
  plan_markdown:
    "# Plan\n\n## Phase 1\n\n- [ ] Task 1: do the thing\n  - verify: pnpm test\n  - commit: feat(x): add\n",
  pr_title: "Plan for #42: do the thing",
  pr_body: "Plan summary.\n",
  summary_for_issue_comment: "Drafted a plan.",
};

function makeCtx(mg: MockGithub) {
  const audit = vi.fn();
  const ctx: StageContext = {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    defaultBranch: "main",
    decision: { stage: "plan" },
    issue: {
      number: 42,
      title: "do thing",
      body: "...",
      labels: ["shopfloor:plan-running", "shopfloor:needs-plan"],
    },
    github: asAdapter(mg),
    reviewGithub: null,
    agent: new MockAgentAdapter([
      { matchUserPromptIncludes: "do the thing", decision },
    ]),
    audit,
    config: baseConfig,
    runId: "r1",
  };
  return { ctx, audit };
}

describe("runPlan", () => {
  it("returns a parsed PlanDecision", async () => {
    const mg = makeMockGithub();
    const { ctx } = makeCtx(mg);
    const result = await runPlan(ctx, {
      branchName: "shopfloor/plan/42-do-the-thing",
      planFilePath: "docs/shopfloor/plans/42-do-the-thing.md",
      specFilePath: "docs/shopfloor/specs/42-do-the-thing.md",
      revisionBlock: "",
      issueComments: "the user wants to do the thing",
    });
    expect(result.file_path).toMatch(/^docs\/shopfloor\/plans\//);
  });
});

describe("applyPlan", () => {
  it("commits markdown, opens a non-draft PR, upserts planPath, flips labels", async () => {
    const mg = makeMockGithub();
    mg.openStagePr.mockResolvedValue({ number: 150, url: "https://x/pr/150" });
    const { ctx } = makeCtx(mg);
    const result = await applyPlan(ctx, {
      decision,
      branchName: "shopfloor/plan/42-do-the-thing",
      baseBranch: "main",
    });
    expect(result.prNumber).toBe(150);
    expect(mg.putFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/shopfloor/plans/42-do-thing.md",
        branch: "shopfloor/plan/42-do-the-thing",
        content: expect.stringContaining("Task 1"),
      }),
    );
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "plan", draft: false }),
    );
    expect(mg.upsertIssueMetadata).toHaveBeenCalledWith(42, {
      planPath: "docs/shopfloor/plans/42-do-thing.md",
    });
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:plan-in-review");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:plan-running");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:needs-plan");
  });

  it("rejects a decision whose file_path is outside docs/shopfloor/plans/", () => {
    const badDecision = { ...decision, file_path: "random/path.md" };
    expect(PlanDecision.safeParse(badDecision).success).toBe(false);
  });
});
