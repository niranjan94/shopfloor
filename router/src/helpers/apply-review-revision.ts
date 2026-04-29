import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export interface ApplyReviewRevisionParams {
  issueNumber: number;
}

// Mirrors the terminal label flip aggregate-review.ts performs when the agent
// reviewer requests changes, but for the path where a human reviewer leaves a
// CHANGES_REQUESTED review directly on the impl PR. Without this, the impl
// precheck refuses to run because neither shopfloor:needs-impl nor
// shopfloor:review-requested-changes is present on the issue. Also clears
// shopfloor:review-stuck so a human review acts as the unstick signal when the
// agent loop has already given up.
export async function applyReviewRevision(
  adapter: GitHubAdapter,
  params: ApplyReviewRevisionParams,
): Promise<void> {
  await adapter.addLabel(
    params.issueNumber,
    "shopfloor:review-requested-changes",
  );
  await adapter.removeLabel(params.issueNumber, "shopfloor:needs-review");
  await adapter.removeLabel(params.issueNumber, "shopfloor:review-stuck");
}

export async function runApplyReviewRevision(
  adapter: GitHubAdapter,
): Promise<void> {
  const issueNumber = Number(core.getInput("issue_number", { required: true }));
  await applyReviewRevision(adapter, { issueNumber });
}
