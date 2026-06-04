import * as core from "@actions/core";
import type { StageContext } from "./stages/_shared/context.js";
import { createProgressComment } from "./stages/_shared/progress-comment.js";
import { applyImplement } from "./stages/implement/apply.js";
import { runImplement } from "./stages/implement/runner.js";
import { applyPlan } from "./stages/plan/apply.js";
import { runPlan } from "./stages/plan/runner.js";
import { aggregateFindings } from "./stages/review/aggregate.js";
import { applyReview } from "./stages/review/apply.js";
import { runReview } from "./stages/review/runner.js";
import { applySpec } from "./stages/spec/apply.js";
import { runSpec } from "./stages/spec/runner.js";
import { applyTriage } from "./stages/triage/apply.js";
import { runTriage } from "./stages/triage/runner.js";
import type { Stage } from "./state/labels.js";
import { parseIssueMetadata } from "./state/metadata.js";
import type { RouterDecision } from "./state/types.js";

const CONFIDENCE_THRESHOLD = 60;

// Each stage handler assembles its own extras (revision context, progress
// comment, PR/file lookups) so the orchestrator stays generic. Returning the
// stage name is purely informational for audit logs.
export interface StageHandler {
  execute(ctx: StageContext, decision: RouterDecision): Promise<void>;
}

async function buildSpecRevisionBlock(
  ctx: StageContext,
  branchName: string,
): Promise<string> {
  if (!ctx.issue) return "";
  const open = await ctx.github.findOpenPrByHead(branchName);
  if (!open) return "";
  const reviews = await ctx.github.listPrReviews(open.number);
  const requestChanges = reviews
    .filter((r) => r.state === "changes_requested")
    .sort((a, b) => {
      const aT = a.submitted_at ?? "";
      const bT = b.submitted_at ?? "";
      const cmp = bT.localeCompare(aT);
      return cmp !== 0 ? cmp : b.id - a.id;
    });
  if (requestChanges.length === 0) return "";
  const latest = requestChanges[0]!;
  return [
    "## Revision feedback",
    "",
    "The previous PR for this stage was reviewed and the reviewer requested",
    "changes. Address the following before resubmitting:",
    "",
    latest.body || "(no summary)",
  ].join("\n");
}

async function formatIssueComments(
  ctx: StageContext,
  issueNumber: number,
): Promise<string> {
  const comments = await ctx.github.listIssueComments(issueNumber);
  if (comments.length === 0) return "";
  return comments
    .map(
      (c) =>
        `**@${c.user?.login ?? "unknown"}** (${c.created_at}):\n${c.body ?? ""}`,
    )
    .join("\n\n---\n\n");
}

export const RUNNERS: Record<Stage, StageHandler> = {
  triage: {
    async execute(ctx) {
      if (!ctx.issue) throw new Error("triage stage requires ctx.issue");
      const issueComments = await formatIssueComments(ctx, ctx.issue.number);
      const decision = await runTriage(ctx, { issueComments });
      await applyTriage(ctx, { decision, baseBranch: ctx.defaultBranch });
    },
  },

  spec: {
    async execute(ctx, routed) {
      if (!ctx.issue) throw new Error("spec stage requires ctx.issue");
      const branchName = routed.branchName;
      const specFilePath = routed.specFilePath;
      if (!branchName || !specFilePath) {
        throw new Error("spec stage requires branchName and specFilePath");
      }
      const metadata = parseIssueMetadata(ctx.issue.body);
      const triageRationale = metadata?.slug ?? "";
      const issueComments = await formatIssueComments(ctx, ctx.issue.number);
      const revisionBlock = routed.revisionMode
        ? await buildSpecRevisionBlock(ctx, branchName)
        : "";
      const decision = await runSpec(ctx, {
        branchName,
        specFilePath,
        revisionBlock,
        issueComments,
        triageRationale,
      });
      await applySpec(ctx, {
        decision,
        branchName,
        baseBranch: ctx.defaultBranch,
      });
    },
  },

  plan: {
    async execute(ctx, routed) {
      if (!ctx.issue) throw new Error("plan stage requires ctx.issue");
      const branchName = routed.branchName;
      const specFilePath = routed.specFilePath ?? "";
      const planFilePath = routed.planFilePath;
      if (!branchName || !planFilePath) {
        throw new Error("plan stage requires branchName and planFilePath");
      }
      const issueComments = await formatIssueComments(ctx, ctx.issue.number);
      const revisionBlock = routed.revisionMode
        ? await buildSpecRevisionBlock(ctx, branchName)
        : "";
      const decision = await runPlan(ctx, {
        branchName,
        planFilePath,
        specFilePath,
        revisionBlock,
        issueComments,
      });
      await applyPlan(ctx, {
        decision,
        branchName,
        baseBranch: ctx.defaultBranch,
      });
    },
  },

  implement: {
    async execute(ctx, routed) {
      if (!ctx.issue) throw new Error("implement stage requires ctx.issue");
      const branchName = routed.branchName;
      const specFilePath = routed.specFilePath ?? "";
      const planFilePath = routed.planFilePath ?? "";
      if (!branchName) {
        throw new Error("implement stage requires branchName");
      }

      // Find or create the impl PR shell so we can pin the progress comment to
      // it. The PR is created by applyImplement at the end; we use a placeholder
      // PR number sourced from an existing open impl PR (revision mode) or the
      // issue number (first run) so the comment has a target.
      const existing = await ctx.github.findOpenImplPrForIssue(
        ctx.issue.number,
      );
      const commentTarget = existing?.number ?? ctx.issue.number;
      const progressCommentId = await createProgressComment(
        ctx.github,
        commentTarget,
      );

      const revisionBlock =
        routed.revisionMode && routed.implPrNumber
          ? await buildSpecRevisionBlock(ctx, branchName)
          : "";
      const issueComments = await formatIssueComments(ctx, ctx.issue.number);

      // Configure the local working tree before the agent runs. First runs get
      // a fresh branch off the default-branch HEAD that actions/checkout left
      // in place; revision runs fetch the prior iteration's branch so the
      // agent inherits the previous round's working tree. Done after the
      // progress comment is created so we don't strand the orchestrator with
      // a half-written comment when git fails.
      if (ctx.gitOps) {
        await ctx.gitOps.prepareImplCheckout({
          branchName,
          baseBranch: ctx.defaultBranch,
          revisionMode: routed.revisionMode === true,
        });
      } else {
        core.warning(
          "Shopfloor implement stage ran without gitOps configured; the agent's commits will not be pushed and openStagePr will fail because the branch does not exist on origin. Wire OrchestratorArgs.gitOps in production callers.",
        );
      }

      const decision = await runImplement(ctx, {
        progressCommentId,
        branchName,
        specFilePath,
        planFilePath,
        bashAllowlist: "",
        revisionBlock,
        issueComments,
      });

      // Push the agent's commits to origin before opening the PR. The router
      // (not the agent) owns the network path; the agent is explicitly denied
      // `git push` in src/agents/claude.ts so a malformed run cannot publish
      // to the remote. Performing the push here, after the agent finishes
      // cleanly, also means the resulting push event is attributed to the
      // App identity so downstream review workflows trigger.
      if (ctx.gitOps) {
        await ctx.gitOps.pushImplCommits({ branchName });
      }

      await applyImplement(ctx, {
        decision,
        progressCommentId,
        branchName,
        baseBranch: ctx.defaultBranch,
      });
    },
  },

  review: {
    async execute(ctx, routed) {
      if (!ctx.pr) throw new Error("review stage requires ctx.pr");
      // In reviewOnly mode the PR is human-authored and Shopfloor acts as a
      // stateless reviewer: no iteration counter is persisted, every push
      // gets a fresh review, and the iteration cap never fires.
      const iteration = ctx.reviewOnly ? 0 : (routed.reviewIteration ?? 0);
      const maxIterations = ctx.reviewOnly
        ? Number.POSITIVE_INFINITY
        : ctx.config.maxReviewIterations;
      // Provision origin/<base> so the lenses can run `git diff origin/<base>
      // HEAD`. The review checkout is a shallow `pull/N/merge` commit with no
      // base tracking ref and `persist-credentials: false`, so without this
      // the agents cannot fetch or name the base and burn turns flailing
      // through failing git commands. A fetch hiccup degrades the diff but
      // should not fail an entire PR check, so we warn and continue.
      if (ctx.gitOps) {
        try {
          await ctx.gitOps.prepareReviewBase({ baseRef: ctx.pr.baseRef });
        } catch (err) {
          core.warning(
            `Shopfloor review could not fetch base ref '${ctx.pr.baseRef}'; lenses may be unable to diff. ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const patches = await ctx.github.listChangedFilePatches(ctx.pr.number);
      const changedFiles = patches.map((p) => p.filename);

      const planFileContents = routed.planFilePath
        ? await readFileSafe(ctx, routed.planFilePath, ctx.pr.baseRef)
        : "";
      const issueBody = ctx.issue?.body ?? "";

      const previousReviewComments = await ctx.github.listPrReviewComments(
        ctx.pr.number,
      );
      const previousReviewCommentsJson = JSON.stringify(
        previousReviewComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      );

      const outcomes = await runReview(ctx, {
        iteration,
        baseRef: ctx.pr.baseRef,
        changedFiles,
        planFileContents,
        issueBody,
        previousReviewCommentsJson,
      });

      const aggregate = aggregateFindings({
        outcomes,
        patches: patches.map((p) => ({
          filename: p.filename,
          ...(p.patch !== undefined ? { patch: p.patch } : {}),
          status: p.status,
        })),
        currentIteration: iteration,
        maxIterations,
        confidenceThreshold: CONFIDENCE_THRESHOLD,
      });

      // Pipeline mode (Shopfloor-authored impl PRs) writes pipeline-state
      // labels onto the issue, not the PR. The orchestrator hydrates ctx.issue
      // from the PR footer's Shopfloor-Issue: #N before dispatching; if it is
      // still null here, something upstream is broken and we want to fail
      // loud rather than silently retarget the PR. reviewOnly mode (human-
      // authored PRs through dogfood-review.yml) writes no labels at all, so
      // labelTarget is never read in that path; we pass the PR number as an
      // unused placeholder to satisfy the ApplyReviewArgs contract.
      let labelTarget: number;
      if (ctx.reviewOnly) {
        labelTarget = ctx.pr.number;
      } else {
        if (!ctx.issue) {
          throw new Error(
            "review stage requires ctx.issue in pipeline mode; orchestrator hydration must populate it from the PR footer's Shopfloor-Issue: #N",
          );
        }
        labelTarget = ctx.issue.number;
      }
      await applyReview(ctx, { outcome: aggregate, labelTarget });
    },
  },
};

async function readFileSafe(
  ctx: StageContext,
  path: string,
  branch: string,
): Promise<string> {
  try {
    const sha = await ctx.github.getFileSha(path, branch);
    if (!sha) return "";
    return "";
  } catch {
    return "";
  }
}
