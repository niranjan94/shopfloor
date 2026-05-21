import type { StageContext } from "../_shared/context.js";
import type { SpecDecision } from "./decision.js";
import { LABELS } from "../../state/labels.js";

export interface ApplySpecArgs {
  decision: SpecDecision;
  branchName: string;
  baseBranch: string;
}

export interface ApplySpecResult {
  prNumber: number;
  url: string;
}

export async function applySpec(
  ctx: StageContext,
  args: ApplySpecArgs,
): Promise<ApplySpecResult> {
  if (!ctx.issue) throw new Error("applySpec requires ctx.issue");
  const { decision, branchName, baseBranch } = args;
  const issueNumber = ctx.issue.number;

  const baseSha = await ctx.github.getRefSha(baseBranch);
  const created = await ctx.github.createRef(branchName, baseSha);
  const existingSha = created
    ? null
    : await ctx.github.getFileSha(decision.file_path, branchName);

  await ctx.github.putFileContents({
    path: decision.file_path,
    branch: branchName,
    message: `docs(spec): add spec for #${issueNumber}`,
    content: decision.spec_markdown,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const pr = await ctx.github.openStagePr({
    base: baseBranch,
    head: branchName,
    title: decision.pr_title,
    body: decision.pr_body,
    stage: "spec",
    issueNumber,
    draft: false,
  });

  await ctx.github.postIssueComment(
    issueNumber,
    decision.summary_for_issue_comment,
  );

  await ctx.github.upsertIssueMetadata(issueNumber, {
    specPath: decision.file_path,
  });

  await ctx.github.addLabel(issueNumber, LABELS.specInReview);
  await ctx.github.removeLabel(issueNumber, LABELS.specRunning);
  await ctx.github.removeLabel(issueNumber, LABELS.needsSpec);
  await ctx.github.removeLabel(issueNumber, LABELS.revise);

  ctx.audit({ type: "pr_opened", stage: "spec", prNumber: pr.number });
  ctx.audit({
    type: "label_applied",
    issueNumber,
    add: [LABELS.specInReview],
    remove: [LABELS.specRunning, LABELS.needsSpec],
  });
  ctx.audit({
    type: "stage_decided",
    stage: "spec",
    decision,
    tokensUsed: 0,
    costUsd: 0,
  });

  return { prNumber: pr.number, url: pr.url };
}
