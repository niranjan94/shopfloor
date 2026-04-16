import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export interface ReportFailureParams {
  issueNumber: number;
  stage: "triage" | "spec" | "plan" | "implement" | "review";
  runUrl: string;
  targetPrNumber?: number;
}

export async function reportFailure(
  adapter: GitHubAdapter,
  params: ReportFailureParams,
): Promise<void> {
  const target = params.targetPrNumber ?? params.issueNumber;
  const retryInstructions =
    params.stage === "review"
      ? // Review is driven by pull_request events, not issue events. Just
        // removing the label does not re-run the review aggregator on its
        // own; the user needs to either push a new commit (which re-fires
        // review via synchronize) or re-run the failed jobs from the
        // workflow run page.
        [
          `You can retry by removing the \`shopfloor:failed:${params.stage}\` label and then either:`,
          `- pushing a new commit to the impl PR, or`,
          `- re-running the failed jobs from the [workflow run](${params.runUrl}).`,
        ].join("\n")
      : `You can retry by removing the \`shopfloor:failed:${params.stage}\` label.`;
  const body = [
    `**Shopfloor stage \`${params.stage}\` failed.**`,
    "",
    `See the [workflow run](${params.runUrl}) for details.`,
    "",
    retryInstructions,
  ].join("\n");
  await adapter.postIssueComment(target, body);
  await adapter.addLabel(
    params.issueNumber,
    `shopfloor:failed:${params.stage}`,
  );
  // Clear the transient mutex marker for the failed stage so that removing
  // the shopfloor:failed:* label can actually retry. Without this, the next
  // run's precheck would see the marker still present and skip. removeLabel
  // is a no-op when the label is already absent, which is the common case
  // when the marker was cleared by the stage's postwork step before the
  // agent step failed.
  const mutexMarkers: Record<string, string> = {
    triage: "shopfloor:triaging",
    spec: "shopfloor:spec-running",
    plan: "shopfloor:plan-running",
    implement: "shopfloor:implementing",
  };
  const marker = mutexMarkers[params.stage];
  if (marker) {
    try {
      await adapter.removeLabel(params.issueNumber, marker);
    } catch (err) {
      core.warning(
        `report-failure: failed to clear ${marker} marker: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function runReportFailure(adapter: GitHubAdapter): Promise<void> {
  await reportFailure(adapter, {
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    stage: core.getInput("stage", {
      required: true,
    }) as ReportFailureParams["stage"],
    runUrl: core.getInput("run_url", { required: true }),
    targetPrNumber: core.getInput("target_pr_number")
      ? Number(core.getInput("target_pr_number"))
      : undefined,
  });
}
