import type { StageContext } from "../_shared/context.js";
import type { SuppliedArtifact, TriageDecision } from "./decision.js";
import { LABELS, complexityLabel } from "../../state/labels.js";
import { branchSlug } from "../../state/metadata.js";
import { seedStagePr, validateOverridePath } from "../_shared/seed-stage-pr.js";

const NEXT_STAGE_LABEL: Record<TriageDecision["complexity"], string> = {
  quick: LABELS.needsImpl,
  medium: LABELS.needsPlan,
  large: LABELS.needsSpec,
};

const UNEXPECTED_TRIAGE_LABELS: string[] = [
  LABELS.needsSpec,
  LABELS.specInReview,
  LABELS.needsPlan,
  LABELS.planInReview,
  LABELS.needsImpl,
  LABELS.implInReview,
  LABELS.needsReview,
  LABELS.reviewRequestedChanges,
  LABELS.reviewApproved,
  LABELS.reviewStuck,
  LABELS.done,
];

export interface ApplyTriageArgs {
  decision: TriageDecision;
  baseBranch: string;
}

export async function applyTriage(
  ctx: StageContext,
  args: ApplyTriageArgs,
): Promise<void> {
  if (!ctx.issue) throw new Error("applyTriage requires ctx.issue");
  const { decision, baseBranch } = args;
  const issueNumber = ctx.issue.number;

  const current = new Set(ctx.issue.labels);
  for (const l of UNEXPECTED_TRIAGE_LABELS) {
    if (current.has(l)) {
      throw new Error(
        `applyTriage: refusing to re-triage issue #${issueNumber}: unexpected state label '${l}' is already present.`,
      );
    }
  }

  if (decision.status === "needs_clarification") {
    const questionsBlock = decision.clarifying_questions
      .map((q) => `- ${q}`)
      .join("\n");
    const body = [
      "**Shopfloor triage: need more information.**",
      "",
      decision.rationale,
      "",
      "**Please answer the following before I proceed:**",
      questionsBlock,
      "",
      "Remove the `shopfloor:awaiting-info` label once you have updated the issue body or added answers in comments.",
    ].join("\n");
    await ctx.github.postIssueComment(issueNumber, body);
    if (current.has(LABELS.triaging)) {
      await ctx.github.removeLabel(issueNumber, LABELS.triaging);
    }
    if (current.has(LABELS.revise)) {
      await ctx.github.removeLabel(issueNumber, LABELS.revise);
    }
    await ctx.github.addLabel(issueNumber, LABELS.awaitingInfo);
    ctx.audit({
      type: "label_applied",
      issueNumber,
      add: [LABELS.awaitingInfo],
      remove: current.has(LABELS.triaging) ? [LABELS.triaging] : [],
    });
    ctx.audit({
      type: "stage_decided",
      stage: "triage",
      decision,
      tokensUsed: 0,
      costUsd: 0,
    });
    return;
  }

  // Slug is derived in apply (not by the agent) so the user can edit the
  // issue title freely between triage runs without locking in a stale slug.
  const slug = branchSlug(ctx.issue.title);

  // Quick complexity skips spec+plan, but if the user supplied either, we
  // must route through the plan-aware implement flow, so promote.
  const suppliedSpec = decision.supplied_spec;
  const suppliedPlan = decision.supplied_plan;
  const anySupplied = suppliedSpec !== null || suppliedPlan !== null;
  const effectiveComplexity =
    anySupplied && decision.complexity === "quick"
      ? "medium"
      : decision.complexity;

  const metadataUpdates: {
    slug: string;
    specPath?: string;
    planPath?: string;
  } = { slug };
  if (suppliedSpec?.source === "path" && suppliedSpec.path) {
    validateOverridePath(suppliedSpec.path);
    metadataUpdates.specPath = suppliedSpec.path;
  }
  if (suppliedPlan?.source === "path" && suppliedPlan.path) {
    validateOverridePath(suppliedPlan.path);
    metadataUpdates.planPath = suppliedPlan.path;
  }
  await ctx.github.upsertIssueMetadata(issueNumber, metadataUpdates);

  let seededStage: "spec" | "plan" | null = null;
  if (suppliedSpec?.source === "body" && suppliedSpec.content) {
    await seedStagePr(ctx.github, {
      issueNumber,
      slug,
      stage: "spec",
      content: suppliedSpec.content,
      baseBranch,
      prTitle: `Seed spec for #${issueNumber}: ${ctx.issue.title}`,
      prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
    });
    seededStage = "spec";
  }
  if (suppliedPlan?.source === "body" && suppliedPlan.content) {
    await seedStagePr(ctx.github, {
      issueNumber,
      slug,
      stage: "plan",
      content: suppliedPlan.content,
      baseBranch,
      prTitle: `Seed plan for #${issueNumber}: ${ctx.issue.title}`,
      prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
    });
    seededStage = "plan";
  }

  const nextStateLabel = pickNextLabel(
    seededStage,
    suppliedSpec,
    suppliedPlan,
    effectiveComplexity,
  );

  const promotedNote =
    anySupplied && decision.complexity === "quick"
      ? ` (promoted from \`quick\` because supplied artifacts require the plan-aware flow)`
      : "";
  const body = [
    `**Shopfloor triage: classified as \`${effectiveComplexity}\`.**${promotedNote}`,
    "",
    decision.rationale,
  ].join("\n");
  await ctx.github.postIssueComment(issueNumber, body);

  const removeLabels = [
    LABELS.triaging,
    LABELS.awaitingInfo,
    LABELS.revise,
  ].filter((l) => current.has(l));
  const addLabels = [complexityLabel(effectiveComplexity), nextStateLabel];
  for (const l of removeLabels) await ctx.github.removeLabel(issueNumber, l);
  for (const l of addLabels) await ctx.github.addLabel(issueNumber, l);

  ctx.audit({
    type: "label_applied",
    issueNumber,
    add: addLabels,
    remove: removeLabels,
  });
  ctx.audit({
    type: "stage_decided",
    stage: "triage",
    decision,
    tokensUsed: 0,
    costUsd: 0,
  });
}

function pickNextLabel(
  seededStage: "spec" | "plan" | null,
  suppliedSpec: SuppliedArtifact | null,
  suppliedPlan: SuppliedArtifact | null,
  effectiveComplexity: TriageDecision["complexity"],
): string {
  if (seededStage === "spec") return LABELS.specInReview;
  if (seededStage === "plan") return LABELS.planInReview;
  if (suppliedPlan?.source === "path") return LABELS.needsImpl;
  if (suppliedSpec?.source === "path") return LABELS.needsPlan;
  return NEXT_STAGE_LABEL[effectiveComplexity];
}
