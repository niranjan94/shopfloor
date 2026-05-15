import { describe, expect, it } from "vitest";
import { runOrchestrator } from "../../src/orchestrator.js";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import { asAdapter, makeMockGithub } from "../github/_mock-github.js";
import { baseConfig } from "../_harness/config.js";
import type { AuditEvent } from "../../src/audit/events.js";
import type { EventPayload } from "../../src/state/types.js";

import issueOpenedBare from "./fixtures/issue-opened-bare.json" with { type: "json" };
import issueLabeledNeedsSpec from "./fixtures/issue-labeled-needs-spec.json" with { type: "json" };
import issueLabeledNeedsPlan from "./fixtures/issue-labeled-needs-plan-no-title.json" with { type: "json" };
import issueLabeledNeedsImpl from "./fixtures/issue-labeled-needs-impl.json" with { type: "json" };
import issueClosed from "./fixtures/issue-closed.json" with { type: "json" };
import issueRetrySpec from "./fixtures/issue-unlabeled-failed-spec-with-needs-spec.json" with { type: "json" };
import prReadyImpl from "./fixtures/pr-ready-for-review-impl.json" with { type: "json" };
import prMergedSpec from "../fixtures/events/pr-closed-merged-spec.json" with { type: "json" };
import prReviewChangesRequested from "../fixtures/events/pr-review-submitted-changes-requested.json" with { type: "json" };

type FixturePayload = EventPayload;

function drive(opts: {
  name: string;
  payload: unknown;
  responses?: ConstructorParameters<typeof MockAgentAdapter>[0];
  config?: typeof baseConfig;
}) {
  const audit: AuditEvent[] = [];
  const mg = makeMockGithub();
  const agent = new MockAgentAdapter(opts.responses ?? []);
  return {
    audit,
    mg,
    promise: runOrchestrator({
      event: { name: opts.name, payload: opts.payload as FixturePayload },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: (e) => audit.push(e),
      config: opts.config ?? baseConfig,
      runId: "e2e",
    }),
  };
}

describe("orchestrator e2e against v1 fixtures", () => {
  it("issues.opened with no labels routes to triage and applies large-complexity", async () => {
    const { audit, mg, promise } = drive({
      name: "issues",
      payload: issueOpenedBare,
      responses: [
        {
          matchUserPromptIncludes: "OAuth login via GitHub App",
          decision: {
            status: "classified",
            complexity: "large",
            rationale:
              "OAuth login spans authentication, app permissions, and session lifecycle. This warrants a spec to lock in the design first.",
            clarifying_questions: [],
            supplied_spec: null,
            supplied_plan: null,
          },
        },
      ],
    });
    await promise;
    expect(audit.map((e) => e.type)).toContain("stage_decided");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:needs-spec");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:large");
  });

  it("issue.labeled(needs-spec) drives the spec stage", async () => {
    const { audit, mg, promise } = drive({
      name: "issues",
      payload: issueLabeledNeedsSpec,
      responses: [
        {
          matchUserPromptIncludes: "OAuth login via GitHub App",
          decision: {
            file_path: "docs/shopfloor/specs/42-add-github-oauth-login.md",
            spec_markdown:
              "# Spec\n\n## Goals\n\n- ship OAuth login that satisfies user expectations.\n\n## Design\n\nThe one chosen approach.\n",
            pr_title: "Spec for #42: Add GitHub OAuth login",
            pr_body: "Spec summary.",
            summary_for_issue_comment: "Drafted spec.",
          },
        },
      ],
    });
    await promise;
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "spec", draft: false }),
    );
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:spec-in-review");
    expect(audit.map((e) => e.type)).toContain("pr_opened");
  });

  it("issue.labeled(needs-plan) drives the plan stage", async () => {
    const { audit, mg, promise } = drive({
      name: "issues",
      payload: issueLabeledNeedsPlan,
      responses: [
        {
          matchUserPromptIncludes: "Auth is broken",
          decision: {
            file_path: "docs/shopfloor/plans/42-add-github-oauth-login.md",
            plan_markdown:
              "# Plan\n\n## Task 1\n\nDo a clearly-named first thing.\n",
            pr_title: "Plan for #42",
            pr_body: "Plan summary.",
            summary_for_issue_comment: "Drafted plan.",
          },
        },
      ],
    });
    await promise;
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "plan", draft: false }),
    );
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:plan-in-review");
    expect(audit.map((e) => e.type)).toContain("pr_opened");
  });

  it("issue.labeled(needs-impl) drives the implement stage", async () => {
    const mg = makeMockGithub();
    // After markPullRequestReadyForReview the impl PR is non-draft. Default
    // mock returns undefined for getPr so we set a baseline.
    mg.getPr.mockResolvedValue({
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "abc" },
      body: "Shopfloor-Review-Iteration: 0",
    });
    // Pre-populate ctx.issue.labels with implementing marker so applyImplement passes.
    // applyImplement reads ctx.issue.labels — but the orchestrator builds labels
    // from the event payload, which carries shopfloor:needs-impl + shopfloor:large.
    // We need shopfloor:implementing too. The orchestrator adds it via addLabel
    // before invoking the stage handler; but ctx.issue.labels is captured from
    // the payload snapshot. So we must inject it via the payload labels.
    const audit: AuditEvent[] = [];
    await runOrchestrator({
      event: { name: "issues", payload: issueLabeledNeedsImpl as never },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([
        {
          matchUserPromptIncludes: "Need foo.",
          decision: {
            pr_title: "feat(foo): add foo",
            pr_body: "Implementation body.",
            summary_for_issue_comment: "Implementation complete.",
            changed_files: ["src/foo.ts"],
          },
        },
      ]),
      audit: (e) => audit.push(e),
      config: baseConfig,
      runId: "e2e-impl",
    });
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "implement", draft: true }),
    );
    expect(mg.markPullRequestReadyForReview).toHaveBeenCalled();
  });

  it("issue.closed → stage_resolved=none, no mutations", async () => {
    const { audit, mg, promise } = drive({
      name: "issues",
      payload: issueClosed,
    });
    await promise;
    const types = audit.map((e) => e.type);
    expect(types).toEqual(["stage_resolved"]);
    expect(mg.addLabel).not.toHaveBeenCalled();
  });

  it("unlabel(shopfloor:failed:spec) with needs-spec label re-enters spec", async () => {
    const { audit, mg, promise } = drive({
      name: "issues",
      payload: issueRetrySpec,
      responses: [
        {
          matchUserPromptIncludes: "OAuth login via GitHub App",
          decision: {
            file_path: "docs/shopfloor/specs/42-add-github-oauth-login.md",
            spec_markdown:
              "# Spec\n\n## Goals\n\n- redrafted goal.\n\n## Design\n\nApproach.\n",
            pr_title: "Spec for #42 (retry)",
            pr_body: "Retry spec.",
            summary_for_issue_comment: "Spec redrafted.",
          },
        },
      ],
    });
    await promise;
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "spec" }),
    );
    expect(audit.map((e) => e.type)).toContain("pr_opened");
  });

  it("spec PR merged advances issue to needs-plan and posts comment", async () => {
    const audit: AuditEvent[] = [];
    const mg = makeMockGithub();
    mg.getIssue.mockResolvedValue({
      labels: [{ name: "shopfloor:spec-in-review" }],
      state: "open",
      title: "x",
      body: null,
    });
    await runOrchestrator({
      event: { name: "pull_request", payload: prMergedSpec as never },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit: (e) => audit.push(e),
      config: baseConfig,
      runId: "e2e-merge-spec",
    });
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:spec-in-review");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:needs-plan");
    expect(mg.postIssueComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Moving to planning stage"),
    );
    expect(audit.map((e) => e.type)).toContain("label_applied");
  });

  it("merge transition is idempotent when the downstream label is already present", async () => {
    const mg = makeMockGithub();
    mg.getIssue.mockResolvedValue({
      labels: [{ name: "shopfloor:needs-plan" }],
      state: "open",
      title: "x",
      body: null,
    });
    await runOrchestrator({
      event: { name: "pull_request", payload: prMergedSpec as never },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit: () => {},
      config: baseConfig,
      runId: "e2e-merge-spec-idempotent",
    });
    expect(mg.removeLabel).not.toHaveBeenCalled();
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.postIssueComment).not.toHaveBeenCalled();
  });

  it("human REQUEST_CHANGES on impl PR flips labels and runs the implement stage", async () => {
    const audit: AuditEvent[] = [];
    const mg = makeMockGithub();
    // Live issue has needs-review (mid-review state) plus a stale review-stuck
    // marker left over from an earlier iteration cap-out. The flip should
    // remove both and add review-requested-changes before precheck.
    mg.getIssue.mockResolvedValue({
      labels: [
        { name: "shopfloor:needs-review" },
        { name: "shopfloor:review-stuck" },
      ],
      state: "open",
      title: "Add GitHub OAuth login",
      body: "OAuth login via GitHub App.",
    });
    mg.getPr.mockResolvedValue({
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "abc" },
      base: { ref: "main" },
      body: "Shopfloor-Review-Iteration: 0",
    });
    await runOrchestrator({
      event: {
        name: "pull_request_review",
        payload: prReviewChangesRequested as never,
      },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([
        {
          matchUserPromptIncludes: "OAuth login via GitHub App",
          decision: {
            pr_title: "fix(auth): address review feedback",
            pr_body: "Revised.",
            summary_for_issue_comment: "Revision complete.",
            changed_files: ["src/auth.ts"],
          },
        },
      ]),
      audit: (e) => audit.push(e),
      config: baseConfig,
      runId: "e2e-human-revrev",
    });
    expect(mg.addLabel).toHaveBeenCalledWith(
      42,
      "shopfloor:review-requested-changes",
    );
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:needs-review");
    expect(mg.removeLabel).toHaveBeenCalledWith(42, "shopfloor:review-stuck");
    // Implement stage actually ran (would have thrown if ctx.issue wasn't
    // hydrated from the API).
    expect(mg.openStagePr).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "implement" }),
    );
  });

  it("reviewOnly=true on a human PR (no Shopfloor metadata) routes to review", async () => {
    const mg = makeMockGithub();
    mg.listChangedFilePatches.mockResolvedValue([
      {
        filename: "src/auth.ts",
        patch: "@@ -1,0 +1,1 @@\n+const x = 1;",
        status: "added",
      },
    ]);
    const humanPrEvent = {
      action: "opened",
      pull_request: {
        number: 7,
        body: "Plain human PR body — no Shopfloor metadata.",
        state: "open" as const,
        draft: false,
        merged: false,
        head: {
          ref: "feature/foo",
          sha: "deadbeef00000000000000000000000000000000",
        },
        base: { ref: "main", sha: "1111111111111111111111111111111111111111" },
        labels: [],
      },
      repository: { owner: { login: "octo" }, name: "demo" },
    };
    const cleanLens = {
      verdict: "clean",
      summary: "No issues found.",
      comments: [],
    };
    const audit: AuditEvent[] = [];
    await runOrchestrator({
      event: { name: "pull_request", payload: humanPrEvent as never },
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([
        { matchUserPromptIncludes: "src/auth.ts", decision: cleanLens },
      ]),
      audit: (e) => audit.push(e),
      config: baseConfig,
      runId: "review-only",
      reviewOnly: true,
    });
    const resolved = audit.find((e) => e.type === "stage_resolved");
    expect(resolved?.stage).toBe("review");
    expect(audit.some((e) => e.type === "review_posted")).toBe(true);
    // Review-only mode is stateless: no Shopfloor labels and no PR body
    // mutation on a human-authored PR.
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.removeLabel).not.toHaveBeenCalled();
    expect(mg.updatePrBody).not.toHaveBeenCalled();
  });

  it("pull_request.ready_for_review on impl PR routes to review and approves when all lenses clean", async () => {
    const mg = makeMockGithub();
    mg.getPr.mockResolvedValue({
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "abc" },
      body: "Shopfloor-Review-Iteration: 0",
    });
    mg.listChangedFilePatches.mockResolvedValue([
      {
        filename: "src/auth.ts",
        patch: "@@ -1,0 +1,1 @@\n+const x = 1;",
        status: "added",
      },
    ]);
    const cleanLens = {
      verdict: "clean",
      summary: "No issues found.",
      comments: [],
    };
    const audit: AuditEvent[] = [];
    await runOrchestrator({
      event: { name: "pull_request", payload: prReadyImpl as never },
      repo: { owner: "niranjan94", name: "shopfloor" },
      github: asAdapter(mg),
      reviewGithub: asAdapter(makeMockGithub()),
      agent: new MockAgentAdapter([
        { matchUserPromptIncludes: "src/auth.ts", decision: cleanLens },
      ]),
      audit: (e) => audit.push(e),
      config: baseConfig,
      runId: "e2e-review",
    });
    const verdict = audit.find((e) => e.type === "review_posted");
    expect(verdict).toBeDefined();
    if (verdict && verdict.type === "review_posted") {
      expect(verdict.verdict).toBe("approve");
    }
  });
});
