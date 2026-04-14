import * as core from '@actions/core';
import { getOctokit, context } from '@actions/github';
import { resolveStage } from './state';
import { GitHubAdapter } from './github';
import type { OctokitLike } from './types';

import { runBootstrapLabels } from './helpers/bootstrap-labels';
import { runOpenStagePr } from './helpers/open-stage-pr';
import { runAdvanceState } from './helpers/advance-state';
import { runReportFailure } from './helpers/report-failure';
import { runHandleMerge } from './helpers/handle-merge';
import { runCreateProgressComment } from './helpers/create-progress-comment';
import { runFinalizeProgressComment } from './helpers/finalize-progress-comment';
import { runCheckReviewSkip } from './helpers/check-review-skip';
import { runAggregateReview } from './helpers/aggregate-review';
import { runRenderPrompt } from './helpers/render-prompt';
import { runApplyTriageDecision } from './helpers/apply-triage-decision';
import { runApplyImplPostwork } from './helpers/apply-impl-postwork';

async function main(): Promise<void> {
  const helper = core.getInput('helper', { required: false }) || 'route';
  const token = core.getInput('github_token', { required: true });
  const octokit = getOctokit(token);
  const adapter = new GitHubAdapter(octokit as unknown as OctokitLike, {
    owner: context.repo.owner,
    repo: context.repo.repo
  });

  switch (helper) {
    case 'route': {
      const decision = resolveStage({
        eventName: context.eventName,
        payload: context.payload as never
      });
      core.setOutput('stage', decision.stage);
      if (decision.issueNumber !== undefined) {
        core.setOutput('issue_number', String(decision.issueNumber));
      }
      if (decision.complexity) core.setOutput('complexity', decision.complexity);
      if (decision.branchName) core.setOutput('branch_name', decision.branchName);
      if (decision.specFilePath) core.setOutput('spec_file_path', decision.specFilePath);
      if (decision.planFilePath) core.setOutput('plan_file_path', decision.planFilePath);
      if (decision.revisionMode !== undefined) {
        core.setOutput('revision_mode', String(decision.revisionMode));
      }
      if (decision.reviewIteration !== undefined) {
        core.setOutput('review_iteration', String(decision.reviewIteration));
      }
      if (decision.implPrNumber !== undefined) {
        core.setOutput('impl_pr_number', String(decision.implPrNumber));
      }
      if (decision.reason) core.setOutput('reason', decision.reason);
      return;
    }
    case 'bootstrap-labels':
      return runBootstrapLabels(adapter);
    case 'open-stage-pr':
      return runOpenStagePr(adapter);
    case 'advance-state':
      return runAdvanceState(adapter);
    case 'report-failure':
      return runReportFailure(adapter);
    case 'handle-merge':
      return runHandleMerge(adapter);
    case 'create-progress-comment':
      return runCreateProgressComment(adapter);
    case 'finalize-progress-comment':
      return runFinalizeProgressComment(adapter);
    case 'check-review-skip':
      return runCheckReviewSkip(adapter);
    case 'aggregate-review':
      return runAggregateReview(adapter);
    case 'render-prompt':
      return runRenderPrompt(adapter);
    case 'apply-triage-decision':
      return runApplyTriageDecision(adapter);
    case 'apply-impl-postwork':
      return runApplyImplPostwork(adapter);
    default:
      core.setFailed(`Unknown helper: ${helper}`);
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
