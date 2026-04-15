import * as core from "@actions/core";
import { context } from "@actions/github";
import { resolveStage } from "../state";
import type { GitHubAdapter } from "../github";
import type { IssuePayload } from "../types";

export async function runRoute(adapter: GitHubAdapter): Promise<void> {
  const triggerLabel = core.getInput("trigger_label") || undefined;

  let liveLabels: string[] | undefined;
  if (context.eventName === "issues") {
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

  const decision = resolveStage({
    eventName: context.eventName,
    payload: context.payload as never,
    triggerLabel,
    liveLabels,
  });

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
