import { writeFileSync } from "node:fs";
import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { renderPrompt } from "../prompt-render";
import { resolvePromptFile } from "./render-prompt";

export type RevisionStage = "spec" | "plan" | "implement";

export interface BuildRevisionContextParams {
  stage: RevisionStage;
  issueNumber: number;
  prNumber: number;
  branchName: string;
  specFilePath: string;
  planFilePath: string;
  progressCommentId: string;
  bashAllowlist: string;
  repoOwner: string;
  repoName: string;
  outputPath: string;
  promptFragmentPath: string;
}

function parseIterationFromBody(body: string | null): number {
  if (!body) return 0;
  const m = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

function formatIssueComments(
  comments: Array<{
    user: { login: string } | null;
    created_at: string;
    body: string | null;
  }>,
): string {
  if (comments.length === 0) return "";
  return comments
    .map(
      (c) =>
        `**@${c.user?.login ?? "unknown"}** (${c.created_at}):\n${c.body ?? ""}`,
    )
    .join("\n\n---\n\n");
}

export async function buildRevisionContext(
  adapter: GitHubAdapter,
  params: BuildRevisionContextParams,
): Promise<void> {
  const issue = await adapter.getIssue(params.issueNumber);
  const pr = await adapter.getPr(params.prNumber);
  const reviews = await adapter.listPrReviews(params.prNumber);

  const requestChangesReviews = reviews
    .filter((r) => r.state === "changes_requested")
    .sort((a, b) => {
      const aTime = a.submitted_at ?? "";
      const bTime = b.submitted_at ?? "";
      const cmp = bTime.localeCompare(aTime);
      return cmp !== 0 ? cmp : b.id - a.id;
    });

  if (requestChangesReviews.length === 0) {
    throw new Error(
      `build-revision-context: PR #${params.prNumber} has no REQUEST_CHANGES review. The router decided this was a revision run but the review system has nothing for the agent to address. This indicates a wiring bug between aggregate-review and the impl job.`,
    );
  }

  const latest = requestChangesReviews[0];

  const allReviewComments = await adapter.listPrReviewComments(params.prNumber);
  const filtered = allReviewComments
    .filter((c) => c.pull_request_review_id === latest.id)
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.start_line,
      start_side: c.start_side,
      body: c.body,
    }));

  let issueComments = "";
  try {
    const fetched = await adapter.listIssueComments(params.issueNumber);
    issueComments = formatIssueComments(fetched);
  } catch (err) {
    core.warning(
      `build-revision-context: failed to fetch issue comments for #${params.issueNumber}, falling back to empty: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const iterationCount = parseIterationFromBody(pr.body);
  const reviewCommentsJson = JSON.stringify(filtered);

  const fragmentVars: Record<string, string> = {
    review_comments_json: reviewCommentsJson,
    iteration_count: String(iterationCount),
    spec_file_path: params.specFilePath,
    plan_file_path: params.planFilePath,
  };

  const fragmentPath = resolvePromptFile(params.promptFragmentPath);
  const revisionBlock = renderPrompt(fragmentPath, fragmentVars);

  const common: Record<string, string> = {
    issue_number: String(params.issueNumber),
    issue_title: issue.title,
    issue_body: issue.body ?? "",
    issue_comments: issueComments,
    branch_name: params.branchName,
    repo_owner: params.repoOwner,
    repo_name: params.repoName,
    revision_block: revisionBlock,
  };

  let contextOut: Record<string, string>;
  switch (params.stage) {
    case "spec":
      contextOut = {
        ...common,
        triage_rationale: "",
        spec_file_path: params.specFilePath,
      };
      break;
    case "plan":
      contextOut = {
        ...common,
        plan_file_path: params.planFilePath,
        spec_file_path: params.specFilePath,
      };
      break;
    case "implement":
      contextOut = {
        ...common,
        spec_file_path: params.specFilePath,
        plan_file_path: params.planFilePath,
        progress_comment_id: params.progressCommentId,
        review_comments_json: reviewCommentsJson,
        iteration_count: String(iterationCount),
        bash_allowlist: params.bashAllowlist,
      };
      break;
  }

  writeFileSync(params.outputPath, JSON.stringify(contextOut));
  core.setOutput("path", params.outputPath);
}

export async function runBuildRevisionContext(
  adapter: GitHubAdapter,
): Promise<void> {
  const stage = (core.getInput("stage") || "implement") as RevisionStage;
  await buildRevisionContext(adapter, {
    stage,
    issueNumber: Number(core.getInput("issue_number", { required: true })),
    prNumber: Number(core.getInput("pr_number", { required: true })),
    branchName: core.getInput("branch_name", { required: true }),
    specFilePath: core.getInput("spec_file_path") || "",
    planFilePath: core.getInput("plan_file_path") || "",
    progressCommentId: core.getInput("progress_comment_id") || "",
    bashAllowlist: core.getInput("bash_allowlist") || "",
    repoOwner: core.getInput("repo_owner", { required: true }),
    repoName: core.getInput("repo_name", { required: true }),
    outputPath: core.getInput("output_path", { required: true }),
    promptFragmentPath:
      core.getInput("prompt_fragment_path") ||
      `prompts/${stage}-revision-fragment.md`,
  });
}
