import { describe, expect, it, vi } from "vitest";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import type { Config } from "../../src/config/inputs.js";
import { RUNNERS } from "../../src/runners.js";
import type { StageContext } from "../../src/stages/_shared/context.js";
import { applyTriage } from "../../src/stages/triage/apply.js";
import { runTriage } from "../../src/stages/triage/runner.js";
import type { MockGithub } from "../github/_mock-github.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";

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

interface MakeCtxArgs {
  decision: Record<string, unknown>;
  issueTitle?: string;
  issueBody?: string;
  issueLabels?: string[];
  github?: MockGithub;
}

function makeCtx(args: MakeCtxArgs): StageContext & {
  github: ReturnType<typeof asAdapter>;
  audit: ReturnType<typeof vi.fn>;
  _mockGithub: MockGithub;
} {
  const mg = args.github ?? makeMockGithub();
  const audit = vi.fn();
  const ctx: StageContext = {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    defaultBranch: "main",
    decision: { stage: "triage" },
    issue: {
      number: 7,
      title: args.issueTitle ?? "feat: do the thing",
      body: args.issueBody ?? "we need X",
      labels: args.issueLabels ?? ["shopfloor:triaging"],
    },
    github: asAdapter(mg),
    reviewGithub: null,
    agent: new MockAgentAdapter([
      { matchUserPromptIncludes: "do the thing", decision: args.decision },
    ]),
    audit,
    config: baseConfig,
    runId: "r1",
  };
  return Object.assign(ctx, {
    github: ctx.github,
    audit,
    _mockGithub: mg,
  });
}

describe("runTriage", () => {
  it("returns a parsed decision from the agent", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "spans multiple modules",
      },
    });
    const decision = await runTriage(ctx, { issueComments: "" });
    expect(decision.complexity).toBe("large");
    expect(decision.status).toBe("classified");
    expect(decision.supplied_spec).toBeNull();
  });

  it("injects issueComments into the user prompt", async () => {
    const marker = "MARKER_COMMENT_VISIBLE_TO_TRIAGE_AGENT";
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "trivial",
      },
    });
    // Replace the canned agent with one that only matches when the unique
    // marker string from the comment body appears in the prompt. If the
    // runner drops issueComments on the floor, no canned response matches
    // and MockAgentAdapter throws.
    ctx.agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: marker,
        decision: {
          status: "classified",
          complexity: "quick",
          rationale: "trivial",
        },
      },
    ]);
    const decision = await runTriage(ctx, {
      issueComments: `**@user** (2026-01-01):\n${marker}`,
    });
    expect(decision.status).toBe("classified");
  });
});

describe("RUNNERS.triage", () => {
  it("fetches issue comments and forwards them to the triage agent", async () => {
    const marker = "FORWARDED_COMMENT_MARKER";
    const mg = makeMockGithub();
    mg.listIssueComments.mockResolvedValueOnce([
      {
        user: { login: "niranjan94" },
        created_at: "2026-05-14T00:00:00Z",
        body: `you fake the issue fully ${marker}`,
      },
    ]);
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "trivial",
      },
      github: mg,
    });
    // Only match when the comment's marker reaches the prompt. If RUNNERS
    // doesn't call listIssueComments + forward the result, this throws.
    ctx.agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: marker,
        decision: {
          status: "classified",
          complexity: "quick",
          rationale: "trivial",
        },
      },
    ]);

    await RUNNERS.triage.execute(ctx, { stage: "triage" });

    expect(mg.listIssueComments).toHaveBeenCalledWith(7);
    // applyTriage runs after the agent returns, so reaching this label call
    // proves the prompt match succeeded.
    expect(mg.addLabel).toHaveBeenCalledWith(7, "shopfloor:quick");
  });
});

describe("applyTriage", () => {
  it("classifies large and applies needs-spec + complexity label", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "spans multiple modules",
      },
    });
    const decision = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision, baseBranch: "main" });
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(7, "shopfloor:large");
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:needs-spec",
    );
    expect(ctx._mockGithub.removeLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:triaging",
    );
    expect(ctx._mockGithub.upsertIssueMetadata).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ slug: expect.stringMatching(/do-the-thing/) }),
    );
  });

  it("classifies quick and applies needs-impl", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "single-line fix",
      },
      issueTitle: "fix: typo in readme do the thing",
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision: d, baseBranch: "main" });
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:needs-impl",
    );
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(7, "shopfloor:quick");
  });

  it("posts a clarification comment and applies awaiting-info on needs_clarification", async () => {
    const ctx = makeCtx({
      decision: {
        status: "needs_clarification",
        complexity: "quick",
        rationale: "input shape undefined; ask before triaging do the thing",
        clarifying_questions: ["What is the input shape?"],
      },
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision: d, baseBranch: "main" });
    expect(ctx._mockGithub.postIssueComment).toHaveBeenCalledWith(
      7,
      expect.stringContaining("need more information"),
    );
    expect(ctx._mockGithub.postIssueComment).toHaveBeenCalledWith(
      7,
      expect.stringContaining("What is the input shape?"),
    );
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:awaiting-info",
    );
    // No complexity label applied on clarification path.
    expect(ctx._mockGithub.addLabel).not.toHaveBeenCalledWith(
      7,
      "shopfloor:quick",
    );
  });

  it("promotes quick to medium when a supplied artifact is present", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "do the thing -- spec referenced inline",
        supplied_spec: { source: "path", path: "docs/specs/x.md" },
      },
      issueTitle: "feat: do the thing",
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision: d, baseBranch: "main" });
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:medium",
    );
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:needs-plan",
    );
    expect(ctx._mockGithub.upsertIssueMetadata).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ specPath: "docs/specs/x.md" }),
    );
  });

  it("seeds a spec PR when supplied_spec is by body", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "do the thing -- spec inline",
        supplied_spec: {
          source: "body",
          content: "# Spec\nthe inline spec content",
        },
      },
      issueTitle: "feat: do the thing",
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision: d, baseBranch: "main" });
    // seed-stage-pr calls getRefSha, createRef, putFileContents, openStagePr.
    expect(ctx._mockGithub.getRefSha).toHaveBeenCalledWith("main");
    expect(ctx._mockGithub.createRef).toHaveBeenCalledWith(
      expect.stringMatching(/^shopfloor\/spec\/7-/),
      "base-sha",
    );
    expect(ctx._mockGithub.putFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringMatching(/^docs\/shopfloor\/specs\/7-/),
        content: expect.stringContaining("the inline spec content"),
      }),
    );
    expect(ctx._mockGithub.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "spec", issueNumber: 7 }),
    );
    expect(ctx._mockGithub.addLabel).toHaveBeenCalledWith(
      7,
      "shopfloor:spec-in-review",
    );
  });

  it("refuses to re-triage when an advanced state label is present", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "do the thing",
      },
      issueLabels: ["shopfloor:triaging", "shopfloor:needs-spec"],
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await expect(
      applyTriage(ctx, { decision: d, baseBranch: "main" }),
    ).rejects.toThrow(/needs-spec/);
  });

  it("emits audit events for classified path", async () => {
    const ctx = makeCtx({
      decision: {
        status: "classified",
        complexity: "medium",
        rationale: "do the thing -- cross-file refactor",
      },
    });
    const d = await runTriage(ctx, { issueComments: "" });
    await applyTriage(ctx, { decision: d, baseBranch: "main" });
    const types = ctx.audit.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types).toContain("label_applied");
    expect(types).toContain("stage_decided");
  });
});
