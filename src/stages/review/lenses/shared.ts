import { renderTemplate } from "../../_shared/prompts.js";
import type { StageContext } from "../../_shared/context.js";

export interface LensRunnerArgs {
  iteration: number;
  baseRef: string;
  changedFiles: string[];
  planFileContents: string;
  issueBody: string;
  previousReviewCommentsJson: string;
}

export function renderLensUserPrompt(
  tpl: string,
  ctx: StageContext,
  args: LensRunnerArgs,
): string {
  if (!ctx.pr) {
    throw new Error("review lens requires ctx.pr");
  }
  return renderTemplate(tpl, {
    repo_owner: ctx.repo.owner,
    repo_name: ctx.repo.name,
    pr_number: ctx.pr.number,
    pr_title: ctx.pr.title,
    pr_body: ctx.pr.body ?? "",
    iteration_count: args.iteration,
    base_ref: args.baseRef,
    changed_files: JSON.stringify(args.changedFiles),
    plan_file_contents: args.planFileContents,
    issue_body: args.issueBody,
    previous_review_comments_json: args.previousReviewCommentsJson,
  });
}
