import { LABELS } from "../../state/labels.js";
import type { StageContext } from "../_shared/context.js";
import type { AggregateOutcome } from "./aggregate.js";
import { inlineCommentHeader } from "./format.js";

export interface ApplyReviewArgs {
  outcome: AggregateOutcome;
  labelTarget: number;
  workflowRunUrl?: string;
}

const ITERATION_LINE = /Shopfloor-Review-Iteration:\s*\d+/;
const ERROR_COUNT_LINE = /\n?Shopfloor-Review-Error-Count:\s*\d+/g;

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

// The consecutive-error counter is a footer line that only the errored path
// writes. A review that actually completes (clean or with findings) proves the
// CLI works, so strip the line to reset the count for any future transient run.
function stripErrorCountLine(body: string | null): string {
  return (body ?? "").replace(ERROR_COUNT_LINE, "");
}

function writeErrorCountToBody(body: string | null, count: number): string {
  return `${stripErrorCountLine(body).trimEnd()}\n\nShopfloor-Review-Error-Count: ${count}\n`;
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
      // A clean approval proves the CLI works, so reset any consecutive-error
      // counter (only rewrite the body when one is actually present).
      if (ctx.pr.body?.includes("Shopfloor-Review-Error-Count")) {
        await ctx.github.updatePrBody(
          prNumber,
          stripErrorCountLine(ctx.pr.body),
        );
      }
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

  if (outcome.kind === "errored") {
    // No verdict was produced: every reviewer failed before inspecting the
    // diff. Always post a non-blocking COMMENT (no distinct review App needed);
    // this is an operational failure, not a code verdict.
    await ctx.github.postReview({
      prNumber,
      commitSha: headSha,
      event: "COMMENT",
      body: outcome.body,
      comments: [],
    });

    // reviewOnly: stateless per-push review, so never persist a counter or
    // touch labels. Each push is reviewed fresh.
    if (ctx.reviewOnly) {
      await ctx.github.setReviewStatus(
        headSha,
        "error",
        "Shopfloor review could not complete (infrastructure error)",
        workflowRunUrl,
      );
      ctx.audit({
        type: "review_posted",
        prNumber,
        verdict: "errored",
        iteration: 0,
      });
      return;
    }

    if (outcome.escalate) {
      // Persistent infrastructure failure: stop retrying silently and page a
      // human, mirroring the iteration-cap backstop.
      await ctx.github.addLabel(labelTarget, LABELS.reviewStuck);
      await ctx.github.removeLabel(labelTarget, LABELS.needsReview);
      await ctx.github.postIssueComment(
        prNumber,
        `Shopfloor agent review could not complete after ${outcome.errorCount} consecutive attempts (infrastructure failures). A human should take over this PR. See commit status for the latest failure detail.`,
      );
      await ctx.github.setReviewStatus(
        headSha,
        "error",
        `Shopfloor review could not complete after ${outcome.errorCount} attempts`,
        workflowRunUrl,
      );
      ctx.audit({
        type: "label_applied",
        issueNumber: labelTarget,
        add: [LABELS.reviewStuck],
        remove: [LABELS.needsReview],
      });
      return;
    }

    // Below the threshold: persist the incremented count so a subsequent run
    // can escalate, and leave the verdict labels untouched so a re-trigger
    // re-reviews rather than the PR being parked as request-changes.
    await ctx.github.setReviewStatus(
      headSha,
      "error",
      "Shopfloor review could not complete (infrastructure error)",
      workflowRunUrl,
    );
    await ctx.github.updatePrBody(
      prNumber,
      writeErrorCountToBody(ctx.pr.body, outcome.errorCount),
    );
    ctx.audit({
      type: "review_posted",
      prNumber,
      verdict: "errored",
      iteration: 0,
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
      body: `${inlineCommentHeader(c.category, c.confidence)}\n\n${c.body}`,
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
    // A completed review proves the CLI works, so reset any consecutive-error
    // counter while writing the iteration line.
    const newBody = writeIterationToBody(
      stripErrorCountLine(ctx.pr.body),
      outcome.nextIteration,
    );
    await ctx.github.updatePrBody(prNumber, newBody);
  }
  ctx.audit({
    type: "review_posted",
    prNumber,
    verdict: "request_changes",
    iteration: outcome.nextIteration,
  });
}
