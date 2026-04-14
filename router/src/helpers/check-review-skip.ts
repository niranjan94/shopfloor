import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export interface CheckReviewSkipResult {
  skip: boolean;
  reason?: string;
}

function parseIssueNumberFromBody(body: string | null): number | null {
  if (!body) return null;
  const m = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function checkReviewSkip(
  adapter: GitHubAdapter,
  prNumber: number,
): Promise<CheckReviewSkipResult> {
  const pr = await adapter.getPr(prNumber);
  if (pr.state === "closed") return { skip: true, reason: "pr_closed" };
  if (pr.draft) return { skip: true, reason: "pr_draft" };
  if (pr.labels.some((l) => l.name === "shopfloor:skip-review")) {
    return { skip: true, reason: "skip_review_label_pr" };
  }

  const originIssueNumber = parseIssueNumberFromBody(pr.body ?? null);
  if (originIssueNumber !== null) {
    const issue = await adapter.getIssue(originIssueNumber);
    if (issue.state === "closed")
      return { skip: true, reason: "origin_issue_closed" };
    if (issue.labels.some((l) => l.name === "shopfloor:skip-review")) {
      return { skip: true, reason: "skip_review_label_issue" };
    }
  }

  const files = await adapter.listChangedFiles(prNumber);
  if (files.length === 0) return { skip: true, reason: "no_changed_files" };
  if (files.every((f) => f.startsWith("docs/shopfloor/"))) {
    return { skip: true, reason: "only_shopfloor_docs" };
  }

  const reviews = await adapter.getPrReviewsAtSha(prNumber, pr.head.sha);
  const hasShopfloorReview = reviews.some((r) =>
    r.body.startsWith("<!-- shopfloor-review -->"),
  );
  if (hasShopfloorReview)
    return { skip: true, reason: "already_reviewed_at_sha" };

  return { skip: false };
}

export async function runCheckReviewSkip(
  adapter: GitHubAdapter,
): Promise<void> {
  const prNumber = Number(core.getInput("pr_number", { required: true }));
  const result = await checkReviewSkip(adapter, prNumber);
  core.setOutput("skip", String(result.skip));
  if (result.reason) core.setOutput("reason", result.reason);
}
