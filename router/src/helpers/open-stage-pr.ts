import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export interface OpenStagePrParams {
  issueNumber: number;
  stage: "spec" | "plan" | "implement";
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  reviewIteration?: number;
  draft?: boolean;
}

export async function openStagePr(
  adapter: GitHubAdapter,
  params: OpenStagePrParams,
): Promise<{ prNumber: number; url: string }> {
  const pr = await adapter.openStagePr({
    base: params.baseBranch,
    head: params.branchName,
    title: params.title,
    body: params.body,
    stage: params.stage,
    issueNumber: params.issueNumber,
    reviewIteration: params.reviewIteration,
    draft: params.draft,
    // Implement PRs can be mid-review, with a Shopfloor-Review-Iteration
    // marker in the body that the review loop depends on. Never clobber it
    // on upsert. Spec/plan PRs have no such marker so a refresh is fine.
    preserveBodyIfExists: params.stage === "implement",
  });
  return { prNumber: pr.number, url: pr.url };
}

export async function runOpenStagePr(adapter: GitHubAdapter): Promise<void> {
  const params: OpenStagePrParams = {
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    stage: core.getInput("stage", {
      required: true,
    }) as OpenStagePrParams["stage"],
    branchName: core.getInput("branch_name", { required: true }),
    baseBranch: core.getInput("base_branch", { required: true }),
    title: core.getInput("pr_title", { required: true }),
    body: core.getInput("pr_body", { required: true }),
    reviewIteration: core.getInput("review_iteration")
      ? Number(core.getInput("review_iteration"))
      : undefined,
    draft: core.getInput("draft") === "true",
  };
  const result = await openStagePr(adapter, params);
  core.setOutput("pr_number", String(result.prNumber));
  core.setOutput("pr_url", result.url);
}
