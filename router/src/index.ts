import * as core from "@actions/core";
import { getOctokit, context } from "@actions/github";
import { GitHubAdapter } from "./github";
import type { OctokitLike } from "./types";

import { runBootstrapLabels } from "./helpers/bootstrap-labels";
import { runOpenStagePr } from "./helpers/open-stage-pr";
import { runAdvanceState } from "./helpers/advance-state";
import { runReportFailure } from "./helpers/report-failure";
import { runHandleMerge } from "./helpers/handle-merge";
import { runCreateProgressComment } from "./helpers/create-progress-comment";
import { runFinalizeProgressComment } from "./helpers/finalize-progress-comment";
import { runCheckReviewSkip } from "./helpers/check-review-skip";
import { runAggregateReview } from "./helpers/aggregate-review";
import { runRenderPrompt } from "./helpers/render-prompt";
import { runApplyTriageDecision } from "./helpers/apply-triage-decision";
import { runApplyImplPostwork } from "./helpers/apply-impl-postwork";
import { runPrecheckStage } from "./helpers/precheck-stage";
import { runBuildRevisionContext } from "./helpers/build-revision-context";
import { runRoute } from "./helpers/route";

export async function main(): Promise<void> {
  const helper = core.getInput("helper", { required: false }) || "route";
  const token = core.getInput("github_token", { required: true });
  const octokit = getOctokit(token);
  const adapter = new GitHubAdapter(octokit as unknown as OctokitLike, {
    owner: context.repo.owner,
    repo: context.repo.repo,
  });

  switch (helper) {
    case "route":
      return runRoute(adapter);
    case "bootstrap-labels":
      return runBootstrapLabels(adapter);
    case "open-stage-pr":
      return runOpenStagePr(adapter);
    case "advance-state":
      return runAdvanceState(adapter);
    case "report-failure":
      return runReportFailure(adapter);
    case "handle-merge":
      return runHandleMerge(adapter);
    case "create-progress-comment":
      return runCreateProgressComment(adapter);
    case "finalize-progress-comment":
      return runFinalizeProgressComment(adapter);
    case "check-review-skip":
      return runCheckReviewSkip(adapter);
    case "aggregate-review": {
      // Reviews are posted by a *second* GitHub App whose installation token
      // authenticates as a distinct identity from the primary Shopfloor App
      // that created the PR. Self-reviews (REQUEST_CHANGES / APPROVE on your
      // own PR) are forbidden by the GitHub API, so we route only the
      // createReview call through this secondary adapter. Labels, comments,
      // statuses, and PR body edits continue on the primary adapter.
      const reviewToken = core.getInput("review_github_token") || "";
      const reviewAdapter = reviewToken
        ? new GitHubAdapter(getOctokit(reviewToken) as unknown as OctokitLike, {
            owner: context.repo.owner,
            repo: context.repo.repo,
          })
        : adapter;
      return runAggregateReview(adapter, reviewAdapter);
    }
    case "render-prompt":
      return runRenderPrompt(adapter);
    case "apply-triage-decision":
      return runApplyTriageDecision(adapter);
    case "apply-impl-postwork":
      return runApplyImplPostwork(adapter);
    case "precheck-stage":
      return runPrecheckStage(adapter);
    case "build-revision-context":
      return runBuildRevisionContext(adapter);
    default:
      core.setFailed(`Unknown helper: ${helper}`);
  }
}

if (process.env.GITHUB_ACTIONS === "true") {
  main().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
