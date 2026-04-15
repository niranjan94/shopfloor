import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { checkReviewSkip } from "./check-review-skip";

export interface ApplyImplPostworkParams {
  issueNumber: number;
  prNumber: number;
  prTitle: string;
  prBody: string;
  /**
   * Whether the caller has a secondary review GitHub App configured. When
   * false, every review-stage job is gated off in the workflow, so routing an
   * impl PR to shopfloor:needs-review would strand the issue in permanent
   * review purgatory. Short-circuit to shopfloor:impl-in-review instead.
   */
  hasReviewApp: boolean;
}

function parseIterationFromBody(body: string | null): number {
  if (!body) return 0;
  const m = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

function buildImplPrBody(
  agentBody: string,
  issueNumber: number,
  reviewIteration: number,
): string {
  return `${agentBody.trimEnd()}\n\n---\nShopfloor-Issue: #${issueNumber}\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: ${reviewIteration}\n`;
}

export async function applyImplPostwork(
  adapter: GitHubAdapter,
  params: ApplyImplPostworkParams,
): Promise<{
  nextLabel: "shopfloor:needs-review" | "shopfloor:impl-in-review";
  skipReason?: string;
}> {
  const issue = await adapter.getIssue(params.issueNumber);
  const current = new Set(
    (issue.labels as Array<{ name: string }>).map((l) => l.name),
  );
  if (!current.has("shopfloor:implementing")) {
    throw new Error(
      `apply-impl-postwork: refusing to finalize implement for issue #${params.issueNumber}: shopfloor:implementing marker is not present. Either the impl job did not add it (wiring bug) or a crash left the issue in an ambiguous state.`,
    );
  }

  // Preserve the review iteration counter so aggregate-review's writeIterationToBody can find and bump it.
  const existingPr = await adapter.getPr(params.prNumber);
  const reviewIteration = parseIterationFromBody(existingPr.body);
  const bodyWithFooter = buildImplPrBody(
    params.prBody,
    params.issueNumber,
    reviewIteration,
  );

  await adapter.updatePr(params.prNumber, {
    title: params.prTitle,
    body: bodyWithFooter,
  });

  const skip = params.hasReviewApp
    ? await checkReviewSkip(adapter, params.prNumber)
    : { skip: true, reason: "no_review_app_configured" };
  const nextLabel = skip.skip
    ? "shopfloor:impl-in-review"
    : "shopfloor:needs-review";

  await adapter.addLabel(params.issueNumber, nextLabel);
  await adapter.removeLabel(params.issueNumber, "shopfloor:needs-impl");
  await adapter.removeLabel(params.issueNumber, "shopfloor:implementing");
  await adapter.removeLabel(
    params.issueNumber,
    "shopfloor:review-requested-changes",
  );

  return { nextLabel, skipReason: skip.reason };
}

export async function runApplyImplPostwork(
  adapter: GitHubAdapter,
): Promise<void> {
  const hasReviewApp = core.getInput("has_review_app") === "true";
  const result = await applyImplPostwork(adapter, {
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    prNumber: Number(core.getInput("pr_number", { required: true })),
    prTitle: core.getInput("pr_title", { required: true }),
    prBody: core.getInput("pr_body", { required: true }),
    hasReviewApp,
  });
  if (!hasReviewApp) {
    core.warning(
      "apply-impl-postwork: no secondary review GitHub App configured (SHOPFLOOR_GITHUB_APP_REVIEW_*). Skipping agent review and marking PR impl-in-review for direct human review. See docs/troubleshooting for how to enable agent review.",
    );
  }
  core.setOutput("next_label", result.nextLabel);
  if (result.skipReason) core.setOutput("skip_reason", result.skipReason);
}
