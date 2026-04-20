import * as core from "@actions/core";
import { context } from "@actions/github";
import { parsePrMetadata, resolveReviewOnly, resolveStage } from "../state";
import type { GitHubAdapter } from "../github";
import type { IssuePayload, PullRequestPayload, RouterDecision } from "../types";

export async function runRoute(adapter: GitHubAdapter): Promise<void> {
  const triggerLabel = core.getInput("trigger_label") || undefined;
  const reviewOnly = core.getInput("review_only") === "true";

  let liveLabels: string[] | undefined;
  if (!reviewOnly && context.eventName === "issues") {
    const payload = context.payload as unknown as IssuePayload;
    if (payload.issue?.number !== undefined) {
      try {
        const issue = await adapter.getIssue(payload.issue.number);
        liveLabels = issue.labels.map((l) => l.name);
      } catch (err) {
        core.warning(
          `route: live label fetch failed, falling back to payload snapshot: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  let decision: RouterDecision = reviewOnly
    ? resolveReviewOnly(context.payload as unknown as PullRequestPayload)
    : resolveStage({
        eventName: context.eventName,
        payload: context.payload as never,
        triggerLabel,
        liveLabels,
      });

  // The unlabeled(shopfloor:review-stuck) path on an issue event cannot know
  // the impl PR number or the current review iteration from the payload
  // alone. Enrich the decision by looking up the open impl PR for this issue
  // and parsing its metadata. If no matching impl PR exists (already merged,
  // closed, or branch renamed), downgrade to a no-op so the review matrix
  // doesn't try to check out refs/pull//head.
  if (
    decision.stage === "review" &&
    decision.reason === "review_stuck_removed_force_review" &&
    decision.implPrNumber === undefined &&
    decision.issueNumber !== undefined
  ) {
    try {
      const pr = await adapter.findOpenImplPrForIssue(decision.issueNumber);
      if (pr) {
        const meta = parsePrMetadata(pr.body);
        decision = {
          ...decision,
          implPrNumber: pr.number,
          reviewIteration: meta?.reviewIteration ?? 0,
        };
      } else {
        decision = {
          stage: "none",
          issueNumber: decision.issueNumber,
          reason: "review_stuck_removed_no_open_impl_pr",
        };
      }
    } catch (err) {
      core.warning(
        `route: review-stuck impl PR lookup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      decision = {
        stage: "none",
        issueNumber: decision.issueNumber,
        reason: "review_stuck_removed_lookup_failed",
      };
    }
  }

  core.setOutput("stage", decision.stage);
  if (decision.issueNumber !== undefined) {
    core.setOutput("issue_number", String(decision.issueNumber));
  }
  if (decision.complexity) core.setOutput("complexity", decision.complexity);
  if (decision.branchName) core.setOutput("branch_name", decision.branchName);
  if (decision.specFilePath) {
    core.setOutput("spec_file_path", decision.specFilePath);
  }
  if (decision.planFilePath) {
    core.setOutput("plan_file_path", decision.planFilePath);
  }
  if (decision.revisionMode !== undefined) {
    core.setOutput("revision_mode", String(decision.revisionMode));
  }
  if (decision.reviewIteration !== undefined) {
    core.setOutput("review_iteration", String(decision.reviewIteration));
  }
  if (decision.implPrNumber !== undefined) {
    core.setOutput("impl_pr_number", String(decision.implPrNumber));
  }
  if (decision.reason) core.setOutput("reason", decision.reason);
}
