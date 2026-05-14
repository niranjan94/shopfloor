import { describe, expect, it, vi } from "vitest";
import { runSpec } from "../../src/stages/spec/runner.js";
import { applySpec } from "../../src/stages/spec/apply.js";
import { SpecDecision } from "../../src/stages/spec/decision.js";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";
import type { MockGithub } from "../github/_mock-github.js";
import type { StageContext } from "../../src/stages/_shared/context.js";
import type { Config } from "../../src/config/inputs.js";

const baseConfig: Config = {
  anthropicApiKey: "x",
  claudeCodeOAuthToken: "",
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

const decision = {
  file_path: "docs/shopfloor/specs/42-do-thing.md",
  spec_markdown:
    "# Spec\n\n## Goals\n\n- a clearly stated outcome the implementation must achieve.\n\n## Design\n\nThe one chosen approach goes here.\n",
  pr_title: "Spec for #42: do the thing",
  pr_body: "Spec summary.\n",
  summary_for_issue_comment: "Drafted a spec.",
};

function makeCtx(mg: MockGithub) {
  const audit = vi.fn();
  const ctx: StageContext = {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    decision: { stage: "spec" },
    issue: {
      number: 42,
      title: "do thing",
      body: "...",
      labels: ["shopfloor:spec-running", "shopfloor:needs-spec"],
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

describe("runSpec", () => {
  it("returns a parsed SpecDecision", async () => {
    const mg = makeMockGithub();
    const { ctx } = makeCtx(mg);
    const result = await runSpec(ctx, {
      branchName: "shopfloor/spec/42-do-the-thing",
      specFilePath: "docs/shopfloor/specs/42-do-the-thing.md",
      revisionBlock: "",
      issueComments: "do the thing",
      triageRationale: "large feature",
    });
    expect(result.file_path).toMatch(/^docs\/shopfloor\/specs\//);
  });
});

describe("applySpec", () => {
  it("commits markdown, opens a non-draft PR, upserts specPath, flips labels", async () => {
    const mg = makeMockGithub();
    mg.openStagePr.mockResolvedValue({ number: 125, url: "https://x/pr/125" });
    const { ctx } = makeCtx(mg);
    const result = await applySpec(ctx, {
      decision,
      branchName: "shopfloor/spec/42-do-the-thing",
      baseBranch: "main",
    });
    expect(result.prNumber).toBe(125);
    expect(mg.putFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/shopfloor/specs/42-do-thing.md",
        branch: "shopfloor/spec/42-do-the-thing",
        content: expect.stringContaining("Goals"),
      }),
    );
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "spec", draft: false }),
    );
    expect(mg.upsertIssueMetadata).toHaveBeenCalledWith(42, {
      specPath: "docs/shopfloor/specs/42-do-thing.md",
    });
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:spec-in-review");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:spec-running");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:needs-spec");
  });

  it("rejects a decision whose file_path is outside docs/shopfloor/specs/", () => {
    const bad = { ...decision, file_path: "docs/random.md" };
    expect(SpecDecision.safeParse(bad).success).toBe(false);
  });
});
