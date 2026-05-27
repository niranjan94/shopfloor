import { LABELS } from "../../state/labels.js";
import type { StageContext } from "../_shared/context.js";
import type { AggregateOutcome } from "./aggregate.js";

export interface ApplyReviewArgs {
  outcome: AggregateOutcome;
  labelTarget: number;
  workflowRunUrl?: string;
}

const ITERATION_LINE = /Shopfloor-Review-Iteration:\s*\d+/;

function writeIterationToBody(body: string | null, iteration: number): string {
  const baseBody = body ?? "";
  if (!baseBody.match(ITERATION_LINE)) {
    return `${baseBody.trimEnd()}\n\nShopfloor-Review-Iteration: ${iteration}\n`;
  }
  return baseBody.replace(
    ITERATION_LINE,
    `Shopfloor-Review-Iteration: ${iteration}`,
  );
}

export async function applyReview(
  ctx: StageContext,
  args: ApplyReviewArgs,
): Promise<void> {
  if (!ctx.pr) throw new Error("applyReview requires ctx.pr");
  // ctx.reviewGithub identifies a distinct App so GitHub does not reject
  // APPROVE / REQUEST_CHANGES on the bot's own PR. Falling back to ctx.github
  // is fine for COMMENT events but not for verdict events.
  const reviewer = ctx.reviewGithub ?? ctx.github;
  const prNumber = ctx.pr.number;
  const headSha = ctx.pr.headSha;
  const { outcome, labelTarget, workflowRunUrl } = args;

  await ctx.github.setReviewStatus(
    headSha,
    "pending",
    "Shopfloor review: aggregating findings...",
    workflowRunUrl,
  );

  if (outcome.kind === "approve") {
    await reviewer.postReview({
      prNumber,
      commitSha: headSha,
      event: "APPROVE",
      body: outcome.body,
      comments: [],
    });
    await ctx.github.setReviewStatus(
      headSha,
      "success",
      "Shopfloor review passed",
      workflowRunUrl,
    );
    // Shopfloor labels are pipeline-state markers and have no meaning on a
    // human-authored PR routed through reviewOnly mode.
    if (!ctx.reviewOnly) {
      await ctx.github.addLabel(labelTarget, LABELS.reviewApproved);
      await ctx.github.removeLabel(labelTarget, LABELS.needsReview);
      await ctx.github.removeLabel(labelTarget, LABELS.reviewRequestedChanges);
    }
    ctx.audit({
      type: "review_posted",
      prNumber,
      verdict: "approve",
      iteration: 0,
    });
    return;
  }

  if (outcome.kind === "iteration_cap") {
    await ctx.github.addLabel(labelTarget, LABELS.reviewStuck);
    await ctx.github.removeLabel(labelTarget, LABELS.needsReview);
    await ctx.github.removeLabel(labelTarget, LABELS.reviewRequestedChanges);
    await ctx.github.postIssueComment(
      prNumber,
      `Shopfloor agent review has been through ${outcome.maxIterations} iterations without converging. A human should take over this PR. See commit status for the current findings list.`,
    );
    await ctx.github.setReviewStatus(
      headSha,
      "failure",
      `Shopfloor review: iteration cap reached (${outcome.maxIterations})`,
      workflowRunUrl,
    );
    ctx.audit({
      type: "label_applied",
      issueNumber: labelTarget,
      add: [LABELS.reviewStuck],
      remove: [LABELS.needsReview, LABELS.reviewRequestedChanges],
    });
    return;
  }

  // request_changes
  await reviewer.postReview({
    prNumber,
    commitSha: headSha,
    event: "REQUEST_CHANGES",
    body: outcome.body,
    comments: outcome.anchoredComments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.start_line !== undefined ? { start_line: c.start_line } : {}),
      ...(c.start_side !== undefined ? { start_side: c.start_side } : {}),
      body: `[${c.category} / confidence ${c.confidence}]\n\n${c.body}`,
    })),
  });
  const statusDescription = ctx.reviewOnly
    ? "Shopfloor review requested changes"
    : `Shopfloor review requested changes (iteration ${outcome.nextIteration})`;
  await ctx.github.setReviewStatus(
    headSha,
    "failure",
    statusDescription,
    workflowRunUrl,
  );
  // In reviewOnly mode we treat each push as an independent review pass: no
  // Shopfloor labels (the human did not opt into the pipeline), and no
  // iteration counter written into the PR body.
  if (!ctx.reviewOnly) {
    await ctx.github.addLabel(labelTarget, LABELS.reviewRequestedChanges);
    await ctx.github.removeLabel(labelTarget, LABELS.needsReview);
    const newBody = writeIterationToBody(ctx.pr.body, outcome.nextIteration);
    await ctx.github.updatePrBody(prNumber, newBody);
  }
  ctx.audit({
    type: "review_posted",
    prNumber,
    verdict: "request_changes",
    iteration: outcome.nextIteration,
  });
}
