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
