import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { advanceState } from "./advance-state";

export interface HandleMergeParams {
  issueNumber: number;
  mergedStage: "spec" | "plan" | "implement";
  prNumber: number;
}

export async function handleMerge(
  adapter: GitHubAdapter,
  params: HandleMergeParams,
): Promise<void> {
  const issue = await adapter.getIssue(params.issueNumber);
  const current = new Set(
    (issue.labels as Array<{ name: string }>).map((l) => l.name),
  );
  const alreadyApplied =
    (params.mergedStage === "spec" && current.has("shopfloor:needs-plan")) ||
    (params.mergedStage === "plan" && current.has("shopfloor:needs-impl")) ||
    (params.mergedStage === "implement" && current.has("shopfloor:done"));
  if (alreadyApplied) {
    core.info(
      `handle-merge: ${params.mergedStage} transition already applied for issue #${params.issueNumber}, exiting no-op`,
    );
    return;
  }

  switch (params.mergedStage) {
    case "spec":
      await advanceState(
        adapter,
        params.issueNumber,
        ["shopfloor:spec-in-review"],
        ["shopfloor:needs-plan"],
      );
      await adapter.postIssueComment(
        params.issueNumber,
        `Spec merged in #${params.prNumber}. Moving to planning stage.`,
      );
      return;
    case "plan":
      await advanceState(
        adapter,
        params.issueNumber,
        ["shopfloor:plan-in-review"],
        ["shopfloor:needs-impl"],
      );
      await adapter.postIssueComment(
        params.issueNumber,
        `Plan merged in #${params.prNumber}. Moving to implementation stage.`,
      );
      return;
    case "implement":
      await advanceState(
        adapter,
        params.issueNumber,
        ["shopfloor:impl-in-review", "shopfloor:review-approved"],
        ["shopfloor:done"],
      );
      await adapter.postIssueComment(
        params.issueNumber,
        `Implementation merged in #${params.prNumber}. Pipeline complete.`,
      );
      await adapter.closeIssue(params.issueNumber);
      return;
  }
}

export async function runHandleMerge(adapter: GitHubAdapter): Promise<void> {
  await handleMerge(adapter, {
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    mergedStage: core.getInput("merged_stage", {
      required: true,
    }) as HandleMergeParams["mergedStage"],
    prNumber: Number(core.getInput("pr_number", { required: true })),
  });
}
