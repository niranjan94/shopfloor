import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { branchSlug } from "../state";
import { advanceState } from "./advance-state";
import { upsertIssueMetadata } from "./upsert-issue-metadata";
import { validateOverridePath } from "./resolve-artifact-paths";
import { seedStagePr } from "./seed-stage-pr";

export interface SuppliedArtifact {
  source: "body" | "path";
  path?: string;
  content?: string;
}

interface TriageOutput {
  status: "classified" | "needs_clarification";
  complexity: "quick" | "medium" | "large";
  rationale: string;
  clarifying_questions: string[];
  supplied_spec?: SuppliedArtifact | null;
  supplied_plan?: SuppliedArtifact | null;
}

function validateSupplied(
  label: string,
  supplied: unknown,
): SuppliedArtifact | null {
  if (supplied === undefined || supplied === null) return null;
  const s = supplied as Partial<SuppliedArtifact>;
  if (s.source !== "body" && s.source !== "path") {
    throw new Error(
      `apply-triage-decision: ${label}.source must be 'body' or 'path'`,
    );
  }
  if (s.source === "path" && !s.path) {
    throw new Error(
      `apply-triage-decision: ${label}.path is required when source='path'`,
    );
  }
  if (s.source === "body" && !s.content) {
    throw new Error(
      `apply-triage-decision: ${label}.content is required when source='body'`,
    );
  }
  return { source: s.source, path: s.path, content: s.content };
}

const NEXT_STAGE_LABEL: Record<TriageOutput["complexity"], string> = {
  quick: "shopfloor:needs-impl",
  medium: "shopfloor:needs-plan",
  large: "shopfloor:needs-spec",
};

export interface ApplyTriageParams {
  issueNumber: number;
  decision: TriageOutput;
}

const UNEXPECTED_TRIAGE_LABELS = [
  "shopfloor:needs-spec",
  "shopfloor:spec-in-review",
  "shopfloor:needs-plan",
  "shopfloor:plan-in-review",
  "shopfloor:needs-impl",
  "shopfloor:impl-in-review",
  "shopfloor:needs-review",
  "shopfloor:review-requested-changes",
  "shopfloor:review-approved",
  "shopfloor:review-stuck",
  "shopfloor:done",
];

export async function applyTriageDecision(
  adapter: GitHubAdapter,
  params: ApplyTriageParams,
): Promise<void> {
  const { issueNumber, decision } = params;

  const issue = await adapter.getIssue(issueNumber);
  const current = new Set(
    (issue.labels as Array<{ name: string }>).map((l) => l.name),
  );
  for (const l of UNEXPECTED_TRIAGE_LABELS) {
    if (current.has(l)) {
      throw new Error(
        `apply-triage-decision: refusing to re-triage issue #${issueNumber}: unexpected state label '${l}' is already present.`,
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
    await adapter.postIssueComment(issueNumber, body);
    // Every triage run (first-time, failed-triage retry, and re-triage from
    // awaiting-info) is preceded by the workflow's "Mark triage as running"
    // advance-state step, so shopfloor:triaging is normally present here.
    // The .has() guard is kept so this helper stays safe if that step is
    // ever re-ordered or removed.
    const fromLabels = current.has("shopfloor:triaging")
      ? ["shopfloor:triaging"]
      : [];
    await advanceState(adapter, issueNumber, fromLabels, [
      "shopfloor:awaiting-info",
    ]);
    return;
  }

  // Persist the slug exactly once, on the classified decision, so later
  // stages read it back instead of re-deriving it from the title (which the
  // user can freely edit mid-pipeline). The needs_clarification branch
  // above does NOT write: the title may still change before the eventual
  // classified re-triage, and writing early would lock in a stale slug.
  const slug = branchSlug(issue.title);

  // Quick complexity uses the implement-quick prompt, which does not expect
  // any spec or plan file to exist. If the user supplied an artifact, the
  // plan-aware implement prompt is the correct surface, so promote.
  const suppliedSpec = decision.supplied_spec ?? null;
  const suppliedPlan = decision.supplied_plan ?? null;
  const anySupplied = suppliedSpec !== null || suppliedPlan !== null;
  const effectiveComplexity =
    anySupplied && decision.complexity === "quick"
      ? "medium"
      : decision.complexity;

  const metadataUpdates: Record<string, string> = { slug };
  if (suppliedSpec?.source === "path" && suppliedSpec.path) {
    validateOverridePath(suppliedSpec.path);
    metadataUpdates.specPath = suppliedSpec.path;
  }
  if (suppliedPlan?.source === "path" && suppliedPlan.path) {
    validateOverridePath(suppliedPlan.path);
    metadataUpdates.planPath = suppliedPlan.path;
  }
  const newBody = upsertIssueMetadata(issue.body, metadataUpdates);
  if (newBody !== issue.body) {
    await adapter.updateIssueBody(issueNumber, newBody);
  }

  // Open seed PR(s) for body-supplied artifacts. Spec and plan are exclusive
  // here: the triage prompt rejects combos that would seed both stages at
  // once, so seededStage is set at most once.
  let seededStage: "spec" | "plan" | null = null;
  if (suppliedSpec?.source === "body" && suppliedSpec.content) {
    await seedStagePr(adapter, {
      issueNumber,
      slug,
      stage: "spec",
      content: suppliedSpec.content,
      baseBranch: "main",
      prTitle: `Seed spec for #${issueNumber}: ${issue.title}`,
      prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
    });
    seededStage = "spec";
  }
  if (suppliedPlan?.source === "body" && suppliedPlan.content) {
    await seedStagePr(adapter, {
      issueNumber,
      slug,
      stage: "plan",
      content: suppliedPlan.content,
      baseBranch: "main",
      prTitle: `Seed plan for #${issueNumber}: ${issue.title}`,
      prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
    });
    seededStage = "plan";
  }

  let nextStateLabel: string;
  if (seededStage === "spec") {
    nextStateLabel = "shopfloor:spec-in-review";
  } else if (seededStage === "plan") {
    nextStateLabel = "shopfloor:plan-in-review";
  } else if (suppliedPlan?.source === "path") {
    nextStateLabel = "shopfloor:needs-impl";
  } else if (suppliedSpec?.source === "path") {
    nextStateLabel = "shopfloor:needs-plan";
  } else {
    nextStateLabel = NEXT_STAGE_LABEL[effectiveComplexity];
  }

  const promotedNote =
    anySupplied && decision.complexity === "quick"
      ? ` (promoted from \`quick\` because supplied artifacts require the plan-aware flow)`
      : "";
  const body = [
    `**Shopfloor triage: classified as \`${effectiveComplexity}\`.**${promotedNote}`,
    "",
    decision.rationale,
  ].join("\n");
  await adapter.postIssueComment(issueNumber, body);
  // Same filter: only remove the transient triage labels that are actually
  // present. First-time triage has neither; a classified re-triage from the
  // awaiting-info state has only awaiting-info.
  const fromLabels = ["shopfloor:triaging", "shopfloor:awaiting-info"].filter(
    (l) => current.has(l),
  );
  await advanceState(adapter, issueNumber, fromLabels, [
    `shopfloor:${effectiveComplexity}`,
    nextStateLabel,
  ]);
}

export async function runApplyTriageDecision(
  adapter: GitHubAdapter,
): Promise<void> {
  const issueNumber = Number(core.getInput("issue_number", { required: true }));
  const decisionJson = core.getInput("decision_json", { required: true });
  let decision: TriageOutput;
  try {
    decision = JSON.parse(decisionJson) as TriageOutput;
  } catch (err) {
    throw new Error(
      `apply-triage-decision: failed to parse decision_json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    decision.status !== "classified" &&
    decision.status !== "needs_clarification"
  ) {
    throw new Error(
      `apply-triage-decision: invalid status '${decision.status}'`,
    );
  }
  decision.supplied_spec = validateSupplied(
    "supplied_spec",
    decision.supplied_spec,
  );
  decision.supplied_plan = validateSupplied(
    "supplied_plan",
    decision.supplied_plan,
  );
  await applyTriageDecision(adapter, { issueNumber, decision });
}
