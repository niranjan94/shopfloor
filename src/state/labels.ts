export const STAGES = [
  "triage",
  "spec",
  "plan",
  "implement",
  "review",
] as const;
export type Stage = (typeof STAGES)[number];

export const COMPLEXITIES = ["quick", "medium", "large"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const LABELS = {
  // state labels
  triaging: "shopfloor:triaging",
  awaitingInfo: "shopfloor:awaiting-info",
  needsSpec: "shopfloor:needs-spec",
  specInReview: "shopfloor:spec-in-review",
  needsPlan: "shopfloor:needs-plan",
  planInReview: "shopfloor:plan-in-review",
  needsImpl: "shopfloor:needs-impl",
  implInReview: "shopfloor:impl-in-review",
  needsReview: "shopfloor:needs-review",
  reviewRequestedChanges: "shopfloor:review-requested-changes",
  reviewApproved: "shopfloor:review-approved",
  reviewStuck: "shopfloor:review-stuck",
  done: "shopfloor:done",
  revise: "shopfloor:revise",
  // mutex markers
  specRunning: "shopfloor:spec-running",
  planRunning: "shopfloor:plan-running",
  implementing: "shopfloor:implementing",
  reviewRunning: "shopfloor:review-running",
  // complexity
  complexityQuick: "shopfloor:quick",
  complexityMedium: "shopfloor:medium",
  complexityLarge: "shopfloor:large",
  // user-set behavior modifiers
  skipReview: "shopfloor:skip-review",
  wip: "shopfloor:wip",
} as const;

const RUNNING_LABELS = new Set<string>([
  LABELS.specRunning,
  LABELS.planRunning,
  LABELS.implementing,
  LABELS.reviewRunning,
]);

const RUNNING_LABEL_FOR: Record<Stage, string | null> = {
  triage: null,
  spec: LABELS.specRunning,
  plan: LABELS.planRunning,
  implement: LABELS.implementing,
  review: LABELS.reviewRunning,
};

export function isShopfloorLabel(name: string): boolean {
  return name.startsWith("shopfloor:");
}

export function isRunningLabel(name: string): boolean {
  return RUNNING_LABELS.has(name);
}

export function isFailedLabel(name: string): boolean {
  return name.startsWith("shopfloor:failed:");
}

export function failedLabelFor(stage: Stage): string {
  return `shopfloor:failed:${stage}`;
}

export function runningLabelFor(stage: Stage): string {
  const v = RUNNING_LABEL_FOR[stage];
  if (!v) throw new Error(`no mutex label for stage: ${stage}`);
  return v;
}

export function complexityLabel(c: Complexity): string {
  return `shopfloor:${c}`;
}

export function needsLabelFor(
  stage: Exclude<Stage, "triage" | "review">,
): string {
  const map: Record<Exclude<Stage, "triage" | "review">, string> = {
    spec: LABELS.needsSpec,
    plan: LABELS.needsPlan,
    implement: LABELS.needsImpl,
  };
  return map[stage];
}

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

// Canonical color palette. State labels share a cool blue, complexity labels
// share a per-bucket color, transient markers are amber, terminal failures and
// stuck states are red, success is green. Bootstrap-labels reads this list and
// creates any that don't already exist on the repo.
export const LABEL_DEFS: LabelDef[] = [
  {
    name: LABELS.triaging,
    color: "fbca04",
    description: "Shopfloor triage agent is evaluating this issue.",
  },
  {
    name: LABELS.awaitingInfo,
    color: "d93f0b",
    description:
      "Shopfloor is waiting for the issue author to answer clarifying questions.",
  },
  {
    name: LABELS.complexityQuick,
    color: "0e8a16",
    description: "Classified as a quick fix (straight to implementation).",
  },
  {
    name: LABELS.complexityMedium,
    color: "1d76db",
    description: "Classified as medium (skip spec, go to plan).",
  },
  {
    name: LABELS.complexityLarge,
    color: "5319e7",
    description: "Classified as large (full spec, plan, impl flow).",
  },
  {
    name: LABELS.needsSpec,
    color: "a2eeef",
    description: "Ready for the spec agent.",
  },
  {
    name: LABELS.specInReview,
    color: "a2eeef",
    description: "Spec PR awaiting human review.",
  },
  {
    name: LABELS.needsPlan,
    color: "a2eeef",
    description: "Ready for the plan agent.",
  },
  {
    name: LABELS.planInReview,
    color: "a2eeef",
    description: "Plan PR awaiting human review.",
  },
  {
    name: LABELS.needsImpl,
    color: "a2eeef",
    description: "Ready for the implementation agent.",
  },
  {
    name: LABELS.needsReview,
    color: "a2eeef",
    description: "Implementation complete, agent review queued.",
  },
  {
    name: LABELS.reviewRequestedChanges,
    color: "e99695",
    description: "Agent review requested changes; impl will re-run.",
  },
  {
    name: LABELS.reviewApproved,
    color: "0e8a16",
    description: "Agent review passed; ready for human merge.",
  },
  {
    name: LABELS.reviewStuck,
    color: "b60205",
    description: "Review loop exceeded iteration cap; needs human.",
  },
  {
    name: LABELS.implInReview,
    color: "a2eeef",
    description: "Impl PR awaiting human review (skip-review case).",
  },
  {
    name: LABELS.skipReview,
    color: "ededed",
    description: "Bypass the agent review stage for this ticket.",
  },
  {
    name: LABELS.done,
    color: "0e8a16",
    description: "Implementation merged. Pipeline complete.",
  },
  {
    name: LABELS.revise,
    color: "ededed",
    description: "Manual trigger to re-run the current stage.",
  },
  {
    name: failedLabelFor("triage"),
    color: "b60205",
    description: "Triage stage failed.",
  },
  {
    name: failedLabelFor("spec"),
    color: "b60205",
    description: "Spec stage failed.",
  },
  {
    name: failedLabelFor("plan"),
    color: "b60205",
    description: "Plan stage failed.",
  },
  {
    name: failedLabelFor("implement"),
    color: "b60205",
    description: "Implementation stage failed.",
  },
  {
    name: failedLabelFor("review"),
    color: "b60205",
    description: "Review stage failed.",
  },
  {
    name: LABELS.specRunning,
    color: "fbca04",
    description:
      "Transient marker: a spec stage job is actively running for this issue. Removed automatically when the stage completes.",
  },
  {
    name: LABELS.planRunning,
    color: "fbca04",
    description:
      "Transient marker: a plan stage job is actively running for this issue. Removed automatically when the stage completes.",
  },
  {
    name: LABELS.implementing,
    color: "fbca04",
    description:
      "Transient marker: an implement stage job is actively running for this issue. Removed automatically when the stage completes. If this label is stuck after a crash, remove it manually to unblock retries.",
  },
  {
    name: LABELS.reviewRunning,
    color: "fbca04",
    description:
      "Transient marker: a review stage job is actively running for this issue. Removed automatically when the stage completes.",
  },
  {
    name: LABELS.wip,
    color: "fbca04",
    description:
      "Implementation in progress. Suppresses review triggers until removed.",
  },
];
