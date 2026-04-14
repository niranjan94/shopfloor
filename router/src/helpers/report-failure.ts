import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export interface ReportFailureParams {
  issueNumber: number;
  stage: 'triage' | 'spec' | 'plan' | 'implement' | 'review';
  runUrl: string;
  targetPrNumber?: number;
}

export async function reportFailure(
  adapter: GitHubAdapter,
  params: ReportFailureParams
): Promise<void> {
  const target = params.targetPrNumber ?? params.issueNumber;
  const body = [
    `**Shopfloor stage \`${params.stage}\` failed.**`,
    '',
    `See the [workflow run](${params.runUrl}) for details.`,
    '',
    `You can retry by removing the \`shopfloor:failed:${params.stage}\` label.`
  ].join('\n');
  await adapter.postIssueComment(target, body);
  await adapter.addLabel(params.issueNumber, `shopfloor:failed:${params.stage}`);
}

export async function runReportFailure(adapter: GitHubAdapter): Promise<void> {
  await reportFailure(adapter, {
    issueNumber: Number(core.getInput('issue_number', { required: true })),
    stage: core.getInput('stage', { required: true }) as ReportFailureParams['stage'],
    runUrl: core.getInput('run_url', { required: true }),
    targetPrNumber: core.getInput('target_pr_number')
      ? Number(core.getInput('target_pr_number'))
      : undefined
  });
}
