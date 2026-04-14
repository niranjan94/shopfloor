import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';
import { advanceState } from './advance-state';

interface TriageOutput {
  status: 'classified' | 'needs_clarification';
  complexity: 'quick' | 'medium' | 'large';
  rationale: string;
  clarifying_questions: string[];
}

const NEXT_STAGE_LABEL: Record<TriageOutput['complexity'], string> = {
  quick: 'shopfloor:needs-impl',
  medium: 'shopfloor:needs-plan',
  large: 'shopfloor:needs-spec'
};

export interface ApplyTriageParams {
  issueNumber: number;
  decision: TriageOutput;
}

export async function applyTriageDecision(
  adapter: GitHubAdapter,
  params: ApplyTriageParams
): Promise<void> {
  const { issueNumber, decision } = params;

  if (decision.status === 'needs_clarification') {
    const questionsBlock = decision.clarifying_questions.map((q) => `- ${q}`).join('\n');
    const body = [
      '**Shopfloor triage: need more information.**',
      '',
      decision.rationale,
      '',
      '**Please answer the following before I proceed:**',
      questionsBlock,
      '',
      'Remove the `shopfloor:awaiting-info` label once you have updated the issue body or added answers in comments.'
    ].join('\n');
    await adapter.postIssueComment(issueNumber, body);
    await advanceState(adapter, issueNumber, ['shopfloor:triaging'], ['shopfloor:awaiting-info']);
    return;
  }

  const nextStageLabel = NEXT_STAGE_LABEL[decision.complexity];
  const body = [
    `**Shopfloor triage: classified as \`${decision.complexity}\`.**`,
    '',
    decision.rationale
  ].join('\n');
  await adapter.postIssueComment(issueNumber, body);
  await advanceState(
    adapter,
    issueNumber,
    ['shopfloor:triaging', 'shopfloor:awaiting-info'],
    [`shopfloor:${decision.complexity}`, nextStageLabel]
  );
}

export async function runApplyTriageDecision(adapter: GitHubAdapter): Promise<void> {
  const issueNumber = Number(core.getInput('issue_number', { required: true }));
  const decisionJson = core.getInput('decision_json', { required: true });
  let decision: TriageOutput;
  try {
    decision = JSON.parse(decisionJson) as TriageOutput;
  } catch (err) {
    throw new Error(
      `apply-triage-decision: failed to parse decision_json: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (decision.status !== 'classified' && decision.status !== 'needs_clarification') {
    throw new Error(`apply-triage-decision: invalid status '${decision.status}'`);
  }
  await applyTriageDecision(adapter, { issueNumber, decision });
}
