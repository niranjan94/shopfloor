import type {
  Complexity,
  IssuePayload,
  PullRequestPayload,
  PullRequestReviewPayload,
  PrMetadata,
  RouterDecision,
  StateContext,
} from "./types";

const STATE_LABELS = new Set<string>([
  "shopfloor:triaging",
  "shopfloor:awaiting-info",
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
]);

const COMPLEXITY_LABELS: Record<string, Complexity> = {
  "shopfloor:quick": "quick",
  "shopfloor:medium": "medium",
  "shopfloor:large": "large",
};

export function resolveStage(ctx: StateContext): RouterDecision {
  switch (ctx.eventName) {
    case "issues":
      return resolveIssueEvent(ctx.payload as IssuePayload, ctx.triggerLabel);
    case "issue_comment":
      return { stage: "none", reason: "issue_comment_no_action_v0_1" };
    case "pull_request":
      return resolvePullRequestEvent(ctx.payload as PullRequestPayload);
    case "pull_request_review":
      return resolvePullRequestReviewEvent(
        ctx.payload as PullRequestReviewPayload,
        ctx.shopfloorBotLogin,
      );
    case "pull_request_review_comment":
      return { stage: "none", reason: "review_comment_not_a_trigger_v0_1" };
    default:
      return { stage: "none", reason: `unhandled_event:${ctx.eventName}` };
  }
}

function issueLabelSet(issue: {
  labels: Array<{ name: string }>;
}): Set<string> {
  return new Set(issue.labels.map((l) => l.name));
}

function prLabelSet(pr: { labels: Array<{ name: string }> }): Set<string> {
  return new Set(pr.labels.map((l) => l.name));
}

function stateLabel(labels: Set<string>): string | null {
  for (const l of labels) if (STATE_LABELS.has(l)) return l;
  return null;
}

function complexityOf(labels: Set<string>): Complexity | undefined {
  for (const [l, c] of Object.entries(COMPLEXITY_LABELS))
    if (labels.has(l)) return c;
  return undefined;
}

function parsePrMetadata(body: string | null): PrMetadata | null {
  if (!body) return null;
  const issueMatch = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  const stageMatch = body.match(
    /Shopfloor-Stage:\s*(spec|plan|implement|review)/,
  );
  const iterMatch = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  if (!issueMatch || !stageMatch) return null;
  return {
    issueNumber: Number(issueMatch[1]),
    stage: stageMatch[1] as PrMetadata["stage"],
    reviewIteration: iterMatch ? Number(iterMatch[1]) : 0,
  };
}

function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);
}

const ADVANCEMENT_STATE_LABELS = new Set<string>([
  "shopfloor:needs-spec",
  "shopfloor:needs-plan",
  "shopfloor:needs-impl",
]);

const FAILED_LABEL_PREFIX = "shopfloor:failed:";

function failedLabel(labels: Set<string>): string | null {
  for (const l of labels) if (l.startsWith(FAILED_LABEL_PREFIX)) return l;
  return null;
}

function computeStageFromLabels(
  labels: Set<string>,
  issue: { number: number; title: string },
): RouterDecision | null {
  const issueNumber = issue.number;
  if (labels.has("shopfloor:needs-spec")) {
    return {
      stage: "spec",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/spec/${issueNumber}-${branchSlug(issue.title)}`,
    };
  }
  if (labels.has("shopfloor:needs-plan")) {
    return {
      stage: "plan",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/plan/${issueNumber}-${branchSlug(issue.title)}`,
      specFilePath: `docs/shopfloor/specs/${issueNumber}-${branchSlug(issue.title)}.md`,
    };
  }
  if (labels.has("shopfloor:needs-impl")) {
    return {
      stage: "implement",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/impl/${issueNumber}-${branchSlug(issue.title)}`,
      specFilePath: `docs/shopfloor/specs/${issueNumber}-${branchSlug(issue.title)}.md`,
      planFilePath: `docs/shopfloor/plans/${issueNumber}-${branchSlug(issue.title)}.md`,
    };
  }
  return null;
}

function resolveIssueEvent(
  payload: IssuePayload,
  triggerLabel?: string,
): RouterDecision {
  const labels = issueLabelSet(payload.issue);
  const issueNumber = payload.issue.number;
  const hasStateLabel = stateLabel(labels) !== null;

  if (payload.issue.state === "closed") {
    return { stage: "none", issueNumber, reason: "issue_closed_aborted" };
  }

  if (payload.issue.pull_request) {
    return { stage: "none", reason: "issue_event_is_actually_a_pr" };
  }

  // Retry-from-failure: removing a shopfloor:failed:<stage> label is the explicit
  // human signal to retry that stage. This must run BEFORE the failed-label gate
  // below, because by the time this event fires, the failed label is already gone
  // from issue.labels and we need the payload.label.name to know which stage to retry.
  if (
    payload.action === "unlabeled" &&
    payload.label?.name?.startsWith(FAILED_LABEL_PREFIX)
  ) {
    const failedStage = payload.label.name.slice(FAILED_LABEL_PREFIX.length);
    const retryReason = `retry_after_${payload.label.name}_removed`;
    // If the pipeline had already progressed past triage before the failure, remaining
    // state labels (needs-spec/plan/impl) tell us where to resume.
    const derived = computeStageFromLabels(labels, payload.issue);
    if (derived) {
      return { ...derived, reason: retryReason };
    }
    if (failedStage === "triage") {
      return { stage: "triage", issueNumber, reason: retryReason };
    }
    return {
      stage: "none",
      issueNumber,
      reason: `retry_${failedStage}_no_state_label_present`,
    };
  }

  // Failed-label gate: any issue carrying shopfloor:failed:* is parked until a
  // human removes that label. This prevents the second run of a double-fired event
  // (opened + labeled on the same open) from re-triggering triage after the first
  // run already recorded a failure.
  const blockingFailed = failedLabel(labels);
  if (blockingFailed) {
    return {
      stage: "none",
      issueNumber,
      reason: `blocked_by_${blockingFailed}`,
    };
  }

  if (
    payload.action === "unlabeled" &&
    payload.label?.name === "shopfloor:review-stuck"
  ) {
    return {
      stage: "review",
      issueNumber,
      reason: "review_stuck_removed_force_review",
    };
  }

  // Trigger-label gating: when a trigger label is configured, we only let issues
  // enter the pipeline if they carry it. Issues already mid-pipeline (identified by
  // any shopfloor:* state label) are grandfathered in so removing the trigger label
  // later does not strand in-flight work.
  if (
    triggerLabel &&
    triggerLabel.length > 0 &&
    !labels.has(triggerLabel) &&
    !hasStateLabel
  ) {
    return { stage: "none", issueNumber, reason: "trigger_label_absent" };
  }

  if (
    payload.action === "unlabeled" &&
    payload.label?.name === "shopfloor:awaiting-info"
  ) {
    return {
      stage: "triage",
      issueNumber,
      reason: "re_triage_after_clarification",
    };
  }

  // When a trigger label is configured, opening an issue with that label already
  // present fires BOTH an 'opened' event and a 'labeled' event. We treat the
  // 'labeled' event as the single source of truth for entry and suppress 'opened'
  // to avoid double-triggering triage. If the trigger label is absent, the gate
  // above already returned; this branch only runs when the label IS present.
  if (payload.action === "opened" && triggerLabel && triggerLabel.length > 0) {
    return {
      stage: "none",
      issueNumber,
      reason: "opened_deferred_to_labeled_event",
    };
  }

  if (payload.action === "opened" && !hasStateLabel) {
    return { stage: "triage", issueNumber };
  }

  // When a trigger label is configured, adding it to a previously-ignored issue
  // (or opening an issue with it already present) enters the pipeline at triage.
  if (
    triggerLabel &&
    triggerLabel.length > 0 &&
    payload.action === "labeled" &&
    payload.label?.name === triggerLabel &&
    !hasStateLabel
  ) {
    return { stage: "triage", issueNumber, reason: "trigger_label_added" };
  }

  // State-label advancement: only fire when the event is a 'labeled' action AND the
  // label that was just added is one of the advancement state labels. This prevents
  // incidental events (edited, assigned, unrelated labels, queued re-runs of earlier
  // events) from re-entering spec/plan/implement for an already-advanced issue.
  if (
    payload.action === "labeled" &&
    payload.label?.name &&
    ADVANCEMENT_STATE_LABELS.has(payload.label.name)
  ) {
    const derived = computeStageFromLabels(labels, payload.issue);
    if (derived) return derived;
  }

  if (labels.has("shopfloor:awaiting-info")) {
    return { stage: "none", issueNumber, reason: "awaiting_info_paused" };
  }

  return { stage: "none", issueNumber, reason: "no_matching_label_rule" };
}

function resolvePullRequestEvent(payload: PullRequestPayload): RouterDecision {
  const pr = payload.pull_request;
  const meta = parsePrMetadata(pr.body);
  if (!meta) return { stage: "none", reason: "pr_has_no_shopfloor_metadata" };

  if (payload.action === "closed" && pr.merged) {
    return {
      stage: "none",
      reason: `pr_merged_${meta.stage}_triggered_label_flip`,
    };
  }

  if (payload.action === "closed") {
    return { stage: "none", reason: "pr_closed_not_merged_ignored" };
  }

  if (payload.action === "synchronize" && meta.stage === "implement") {
    const labels = prLabelSet(pr);
    if (labels.has("shopfloor:skip-review")) {
      return { stage: "none", reason: "skip_review_label_present" };
    }
    if (pr.draft) return { stage: "none", reason: "pr_is_draft" };
    if (pr.state === "closed") return { stage: "none", reason: "pr_is_closed" };
    return {
      stage: "review",
      issueNumber: meta.issueNumber,
      implPrNumber: pr.number,
      reviewIteration: meta.reviewIteration,
    };
  }

  return {
    stage: "none",
    reason: `pr_action_${payload.action}_on_${meta.stage}_no_action`,
  };
}

function resolvePullRequestReviewEvent(
  payload: PullRequestReviewPayload,
  shopfloorBotLogin?: string,
): RouterDecision {
  const pr = payload.pull_request;
  const meta = parsePrMetadata(pr.body);
  if (!meta) return { stage: "none", reason: "pr_has_no_shopfloor_metadata" };

  if (payload.action !== "submitted") {
    return { stage: "none", reason: `review_action_${payload.action}_ignored` };
  }

  if (payload.review.state !== "changes_requested") {
    return {
      stage: "none",
      reason: `review_state_${payload.review.state}_no_action`,
    };
  }

  const isShopfloorReview =
    shopfloorBotLogin !== undefined &&
    payload.review.user.login === shopfloorBotLogin;

  if (meta.stage === "implement") {
    return {
      stage: "implement",
      issueNumber: meta.issueNumber,
      revisionMode: true,
      reviewIteration: meta.reviewIteration,
      reason: isShopfloorReview
        ? "agent_requested_changes"
        : "human_requested_changes",
    };
  }

  return {
    stage: meta.stage as RouterDecision["stage"],
    issueNumber: meta.issueNumber,
    revisionMode: true,
  };
}
