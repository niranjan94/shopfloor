import type { StageContext } from "../_shared/context.js";
import type { PlanDecision } from "./decision.js";
import { LABELS } from "../../state/labels.js";

export interface ApplyPlanArgs {
  decision: PlanDecision;
  branchName: string;
  baseBranch: string;
}

export interface ApplyPlanResult {
  prNumber: number;
  url: string;
}

export async function applyPlan(
  ctx: StageContext,
  args: ApplyPlanArgs,
): Promise<ApplyPlanResult> {
  if (!ctx.issue) throw new Error("applyPlan requires ctx.issue");
  const { decision, branchName, baseBranch } = args;
  const issueNumber = ctx.issue.number;

  // Ensure the branch exists (revision flows may reuse it).
  const baseSha = await ctx.github.getRefSha(baseBranch);
  const created = await ctx.github.createRef(branchName, baseSha);
  const existingSha = created
    ? null
    : await ctx.github.getFileSha(decision.file_path, branchName);

  await ctx.github.putFileContents({
    path: decision.file_path,
    branch: branchName,
    message: `docs(plan): add plan for #${issueNumber}`,
    content: decision.plan_markdown,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const pr = await ctx.github.openStagePr({
    base: baseBranch,
    head: branchName,
    title: decision.pr_title,
    body: decision.pr_body,
    stage: "plan",
    issueNumber,
    draft: false,
  });

  await ctx.github.postIssueComment(
    issueNumber,
    decision.summary_for_issue_comment,
  );

  await ctx.github.upsertIssueMetadata(issueNumber, {
    planPath: decision.file_path,
  });

  await ctx.github.addLabel(issueNumber, LABELS.planInReview);
  await ctx.github.removeLabel(issueNumber, LABELS.planRunning);
  await ctx.github.removeLabel(issueNumber, LABELS.needsPlan);

  ctx.audit({ type: "pr_opened", stage: "plan", prNumber: pr.number });
  ctx.audit({
    type: "label_applied",
    issueNumber,
    add: [LABELS.planInReview],
    remove: [LABELS.planRunning, LABELS.needsPlan],
  });
  ctx.audit({
    type: "stage_decided",
    stage: "plan",
    decision,
    tokensUsed: 0,
    costUsd: 0,
  });

  return { prNumber: pr.number, url: pr.url };
}
