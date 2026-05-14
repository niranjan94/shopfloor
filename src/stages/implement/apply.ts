import type { StageContext } from "../_shared/context.js";
import type { ImplementDecision } from "./decision.js";
import { LABELS } from "../../state/labels.js";
import { finalizeProgressComment } from "../_shared/progress-comment.js";
import { checkReviewSkip } from "../_shared/check-review-skip.js";

export interface ApplyImplementArgs {
  decision: ImplementDecision;
  progressCommentId: number;
  branchName: string;
  baseBranch: string;
}

const ITERATION_LINE = /Shopfloor-Review-Iteration:\s*(\d+)/;

function parseIterationFromBody(body: string | null | undefined): number {
  if (!body) return 0;
  const m = body.match(ITERATION_LINE);
  if (!m || !m[1]) return 0;
  return Number(m[1]);
}

function buildImplPrBody(
  agentBody: string,
  issueNumber: number,
  reviewIteration: number,
): string {
  return `${agentBody.trimEnd()}\n\n---\nShopfloor-Issue: #${issueNumber}\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: ${reviewIteration}\n`;
}

export interface ApplyImplementResult {
  prNumber: number;
  url: string;
  nextLabel: typeof LABELS.needsReview | typeof LABELS.implInReview;
  skipReason?: string;
}

export async function applyImplement(
  ctx: StageContext,
  args: ApplyImplementArgs,
): Promise<ApplyImplementResult> {
  if (!ctx.issue) throw new Error("applyImplement requires ctx.issue");
  const { decision, progressCommentId, branchName, baseBranch } = args;
  const issueNumber = ctx.issue.number;

  // Pre-condition: the orchestrator set shopfloor:implementing before
  // invoking the impl agent. Refuse to finalize if the marker is missing.
  if (!ctx.issue.labels.includes(LABELS.implementing)) {
    throw new Error(
      `applyImplement: refusing to finalize implement for issue #${issueNumber}: shopfloor:implementing marker is not present.`,
    );
  }

  // Open (or upsert) the impl PR as a draft. The agent has already pushed
  // commits to branchName by this point. preserveBodyIfExists is true on the
  // openStagePr adapter call so an in-flight review-iteration footer is not
  // clobbered; we then update title+body explicitly here.
  const opened = await ctx.github.openStagePr({
    base: baseBranch,
    head: branchName,
    title: decision.pr_title,
    body: decision.pr_body,
    stage: "implement",
    issueNumber,
    draft: true,
    preserveBodyIfExists: true,
  });

  // Re-read so we can preserve the review iteration counter.
  const existingPr = await ctx.github.getPr(opened.number);
  const reviewIteration = parseIterationFromBody(existingPr.body);
  const bodyWithFooter = buildImplPrBody(
    decision.pr_body,
    issueNumber,
    reviewIteration,
  );
  await ctx.github.updatePr(opened.number, {
    title: decision.pr_title,
    body: bodyWithFooter,
  });

  // Finalize the progress comment with the agent's structured summary.
  const finalBody = renderFinalProgress(decision);
  await finalizeProgressComment(
    ctx.github,
    progressCommentId,
    "success",
    finalBody,
  );

  // Flip the draft to ready so the review stage can fire.
  await ctx.github.markPullRequestReadyForReview(opened.number);

  // Decide next label: review-skip checks (draft, wip, skip-review, doc-only,
  // already-reviewed) short-circuit to impl-in-review. Also short-circuit
  // when no separate review App is configured -- routing to needs-review
  // would strand the issue because the review stage cannot post.
  const hasReviewApp = ctx.reviewGithub !== null;
  const skip = hasReviewApp
    ? await checkReviewSkip(ctx.github, opened.number)
    : { skip: true, reason: "no_review_app_configured" };
  const nextLabel = skip.skip ? LABELS.implInReview : LABELS.needsReview;

  await ctx.github.addLabel(issueNumber, nextLabel);
  await ctx.github.removeLabel(issueNumber, LABELS.needsImpl);
  await ctx.github.removeLabel(issueNumber, LABELS.implementing);
  await ctx.github.removeLabel(issueNumber, LABELS.reviewRequestedChanges);
  // A new impl run produces a new head SHA, so any prior review-approved
  // label is stale. Strip it so downstream consumers see the correct state.
  if (nextLabel === LABELS.needsReview) {
    await ctx.github.removeLabel(issueNumber, LABELS.reviewApproved);
  }

  ctx.audit({ type: "pr_opened", stage: "implement", prNumber: opened.number });
  ctx.audit({
    type: "label_applied",
    issueNumber,
    add: [nextLabel],
    remove: [
      LABELS.needsImpl,
      LABELS.implementing,
      LABELS.reviewRequestedChanges,
      ...(nextLabel === LABELS.needsReview ? [LABELS.reviewApproved] : []),
    ],
  });
  ctx.audit({
    type: "stage_decided",
    stage: "implement",
    decision,
    tokensUsed: 0,
    costUsd: 0,
  });

  return {
    prNumber: opened.number,
    url: opened.url,
    nextLabel,
    ...(skip.reason ? { skipReason: skip.reason } : {}),
  };
}

function renderFinalProgress(d: ImplementDecision): string {
  const lines = [
    d.summary_for_issue_comment,
    "",
    "### Files changed",
    ...d.changed_files.map((f) => `- \`${f}\``),
  ];
  return lines.join("\n");
}
