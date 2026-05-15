import type { Stage } from "./state/labels.js";
import type { RouterDecision } from "./state/types.js";
import type { StageContext } from "./stages/_shared/context.js";
import { parseIssueMetadata } from "./state/metadata.js";

import { runTriage } from "./stages/triage/runner.js";
import { applyTriage } from "./stages/triage/apply.js";

import { runSpec } from "./stages/spec/runner.js";
import { applySpec } from "./stages/spec/apply.js";

import { runPlan } from "./stages/plan/runner.js";
import { applyPlan } from "./stages/plan/apply.js";

import { runImplement } from "./stages/implement/runner.js";
import { applyImplement } from "./stages/implement/apply.js";
import { createProgressComment } from "./stages/_shared/progress-comment.js";

import { runReview } from "./stages/review/runner.js";
import { applyReview } from "./stages/review/apply.js";
import { aggregateFindings } from "./stages/review/aggregate.js";

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

      const decision = await runImplement(ctx, {
        progressCommentId,
        branchName,
        specFilePath,
        planFilePath,
        bashAllowlist: "",
        revisionBlock,
        issueComments,
      });
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

      const labelTarget = ctx.issue?.number ?? ctx.pr.number;
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
