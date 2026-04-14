import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { checkReviewSkip } from "./check-review-skip";

export interface ApplyImplPostworkParams {
  issueNumber: number;
  prNumber: number;
  prTitle: string;
  prBody: string;
}

export async function applyImplPostwork(
  adapter: GitHubAdapter,
  params: ApplyImplPostworkParams,
): Promise<{
  nextLabel: "shopfloor:needs-review" | "shopfloor:impl-in-review";
  skipReason?: string;
}> {
  await adapter.updatePr(params.prNumber, {
    title: params.prTitle,
    body: params.prBody,
  });

  const skip = await checkReviewSkip(adapter, params.prNumber);
  const nextLabel = skip.skip
    ? "shopfloor:impl-in-review"
    : "shopfloor:needs-review";

  await adapter.addLabel(params.issueNumber, nextLabel);
  await adapter.removeLabel(params.issueNumber, "shopfloor:needs-impl");
  await adapter.removeLabel(
    params.issueNumber,
    "shopfloor:review-requested-changes",
  );

  return { nextLabel, skipReason: skip.reason };
}

export async function runApplyImplPostwork(
  adapter: GitHubAdapter,
): Promise<void> {
  const result = await applyImplPostwork(adapter, {
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    prNumber: Number(core.getInput("pr_number", { required: true })),
    prTitle: core.getInput("pr_title", { required: true }),
    prBody: core.getInput("pr_body", { required: true }),
  });
  core.setOutput("next_label", result.nextLabel);
  if (result.skipReason) core.setOutput("skip_reason", result.skipReason);
}
