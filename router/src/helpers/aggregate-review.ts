import * as core from "@actions/core";
import type { GitHubAdapter, ReviewComment } from "../github";

interface ReviewerOutput {
  verdict: "clean" | "issues_found";
  summary: string;
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
    body: string;
    confidence: number;
    category: "compliance" | "bug" | "security" | "smell";
  }>;
}

export interface AggregateReviewParams {
  /**
   * When omitted, every label operation below targets the PR number. Used by
   * shopfloor-review.yml on human-authored PRs that have no linked Shopfloor
   * issue. Present in the full pipeline so labels continue to land on the
   * origin issue.
   */
  issueNumber?: number;
  prNumber: number;
  confidenceThreshold: number;
  maxIterations: number;
  reviewerOutputs: Record<
    "compliance" | "bugs" | "security" | "smells",
    string
  >;
  workflowRunUrl?: string;
  analysedSha?: string;
}

const SHOPFLOOR_REVIEW_MARKER = "<!-- shopfloor-review -->";

function parseReviewer(raw: string): ReviewerOutput | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewerOutput;
    if (parsed.verdict !== "clean" && parsed.verdict !== "issues_found")
      return null;
    if (!Array.isArray(parsed.comments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tokenOverlap(a: string, b: string): number {
  const aSet = new Set(
    a.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean),
  );
  const bSet = new Set(
    b.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean),
  );
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const t of aSet) if (bSet.has(t)) intersection++;
  return intersection / Math.min(aSet.size, bSet.size);
}

function dedupeComments(
  all: ReviewerOutput["comments"],
): ReviewerOutput["comments"] {
  const keepers: ReviewerOutput["comments"] = [];
  for (const c of all) {
    const duplicate = keepers.find(
      (k) =>
        k.path === c.path &&
        k.line === c.line &&
        k.side === c.side &&
        tokenOverlap(k.body, c.body) >= 0.75,
    );
    if (duplicate) {
      if (c.confidence > duplicate.confidence) {
        const idx = keepers.indexOf(duplicate);
        keepers[idx] = c;
      }
      continue;
    }
    keepers.push(c);
  }
  return keepers;
}

function parseIterationFromBody(body: string | null): number {
  if (!body) return 0;
  const m = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

// For full-pipeline PRs apply-impl-postwork always inserts the footer before
// any review runs, so this stays a no-op there. For review-only PRs the
// footer is inserted on the first REQUEST_CHANGES and bumped on subsequent
// iterations.
function writeIterationToBody(body: string | null, iteration: number): string {
  const baseBody = body ?? "";
  if (!baseBody.match(/Shopfloor-Review-Iteration:\s*\d+/)) {
    return `${baseBody.trimEnd()}\n\nShopfloor-Review-Iteration: ${iteration}\n`;
  }
  return baseBody.replace(
    /Shopfloor-Review-Iteration:\s*\d+/,
    `Shopfloor-Review-Iteration: ${iteration}`,
  );
}

export async function aggregateReview(
  adapter: GitHubAdapter,
  params: AggregateReviewParams,
  reviewAdapter: GitHubAdapter = adapter,
): Promise<void> {
  const outputs = {
    compliance: parseReviewer(params.reviewerOutputs.compliance),
    bugs: parseReviewer(params.reviewerOutputs.bugs),
    security: parseReviewer(params.reviewerOutputs.security),
    smells: parseReviewer(params.reviewerOutputs.smells),
  };
  const labelTarget = params.issueNumber ?? params.prNumber;
  const parsed = Object.values(outputs).filter(
    (v): v is ReviewerOutput => v !== null,
  );
  const successfulCells = parsed.length;

  const pr = await adapter.getPr(params.prNumber);
  const headSha = pr.head.sha;
  const currentIteration = parseIterationFromBody(pr.body ?? null);

  if (params.analysedSha && params.analysedSha !== headSha) {
    core.notice(
      `aggregateReview: PR #${params.prNumber} head sha drifted (analysed ${params.analysedSha}, current ${headSha}); exiting no-op.`,
    );
    return;
  }

  await adapter.setReviewStatus(
    headSha,
    "pending",
    "Shopfloor review: aggregating findings...",
    params.workflowRunUrl,
  );

  const SOURCE_CATEGORY: Record<string, string> = {
    compliance: "compliance",
    bugs: "bug",
    security: "security",
    smells: "smell",
  };
  for (const [source, out] of Object.entries(outputs)) {
    if (!out) continue;
    const expected = SOURCE_CATEGORY[source];
    const outOfScope = out.comments.filter((c) => c.category !== expected);
    if (outOfScope.length > 0) {
      core.warning(
        `aggregateReview: ${source} reviewer returned ${outOfScope.length} out-of-scope comment(s) (expected category '${expected}')`,
      );
    }
  }

  const allComments = parsed.flatMap((r) => r.comments);
  const deduped = dedupeComments(allComments);
  const filtered = deduped.filter(
    (c) => c.confidence >= params.confidenceThreshold,
  );

  const allClean =
    parsed.every((r) => r.verdict === "clean") && filtered.length === 0;

  if (allClean) {
    const body = `${SHOPFLOOR_REVIEW_MARKER}\n**Shopfloor agent review: clean** across ${successfulCells}/4 reviewers.\n\n${parsed
      .map((r) => `- ${r.summary}`)
      .join("\n")}`;
    await reviewAdapter.postReview({
      prNumber: params.prNumber,
      commitSha: headSha,
      event: "APPROVE",
      body,
      comments: [],
    });
    await adapter.setReviewStatus(
      headSha,
      "success",
      "Shopfloor review passed",
      params.workflowRunUrl,
    );
    await adapter.addLabel(labelTarget, "shopfloor:review-approved");
    await adapter.removeLabel(labelTarget, "shopfloor:needs-review");
    await adapter.removeLabel(
      labelTarget,
      "shopfloor:review-requested-changes",
    );
    return;
  }

  const nextIteration = currentIteration + 1;
  if (nextIteration > params.maxIterations) {
    await adapter.addLabel(labelTarget, "shopfloor:review-stuck");
    await adapter.removeLabel(labelTarget, "shopfloor:needs-review");
    await adapter.removeLabel(
      labelTarget,
      "shopfloor:review-requested-changes",
    );
    await adapter.postIssueComment(
      params.prNumber,
      `Shopfloor agent review has been through ${params.maxIterations} iterations without converging. A human should take over this PR. See commit status for the current findings list.`,
    );
    await adapter.setReviewStatus(
      headSha,
      "failure",
      `Shopfloor review: iteration cap reached (${params.maxIterations})`,
      params.workflowRunUrl,
    );
    return;
  }

  const reviewBody = [
    SHOPFLOOR_REVIEW_MARKER,
    `**Shopfloor agent review: changes requested** (iteration ${nextIteration}/${params.maxIterations}).`,
    "",
    parsed.map((r) => `- ${r.summary}`).join("\n"),
  ].join("\n");

  const batchedComments: ReviewComment[] = filtered.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    start_line: c.start_line,
    start_side: c.start_side,
    body: `[${c.category} / confidence ${c.confidence}]\n\n${c.body}`,
  }));

  await reviewAdapter.postReview({
    prNumber: params.prNumber,
    commitSha: headSha,
    event: "REQUEST_CHANGES",
    body: reviewBody,
    comments: batchedComments,
  });
  await adapter.setReviewStatus(
    headSha,
    "failure",
    `Shopfloor review requested changes (iteration ${nextIteration})`,
    params.workflowRunUrl,
  );
  await adapter.addLabel(labelTarget, "shopfloor:review-requested-changes");
  await adapter.removeLabel(labelTarget, "shopfloor:needs-review");

  const newBody = writeIterationToBody(pr.body ?? null, nextIteration);
  await adapter.updatePrBody(params.prNumber, newBody);
}

export async function runAggregateReview(
  adapter: GitHubAdapter,
  reviewAdapter: GitHubAdapter = adapter,
): Promise<void> {
  const issueNumberInput = core.getInput("issue_number");
  const params: AggregateReviewParams = {
    ...(issueNumberInput ? { issueNumber: Number(issueNumberInput) } : {}),
    prNumber: Number(core.getInput("pr_number", { required: true })),
    confidenceThreshold: Number(core.getInput("confidence_threshold") || 80),
    maxIterations: Number(core.getInput("max_iterations") || 3),
    reviewerOutputs: {
      compliance: core.getInput("compliance_output") || "",
      bugs: core.getInput("bugs_output") || "",
      security: core.getInput("security_output") || "",
      smells: core.getInput("smells_output") || "",
    },
    workflowRunUrl: core.getInput("workflow_run_url") || undefined,
    analysedSha: core.getInput("analysed_sha") || undefined,
  };
  await aggregateReview(adapter, params, reviewAdapter);
}
