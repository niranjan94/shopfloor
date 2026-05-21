import type { Complexity } from "./labels.js";
import {
  parsePrMetadata,
  parseIssueMetadata,
  parseStageBranchRef,
  branchSlug,
} from "./metadata.js";
import type {
  IssuePayload,
  PullRequestPayload,
  PullRequestReviewPayload,
  RouterDecision,
  StateContext,
} from "./types.js";

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
  // transient mutex markers (spec 5.4)
  "shopfloor:spec-running",
  "shopfloor:plan-running",
  "shopfloor:implementing",
  "shopfloor:review-running",
]);

const COMPLEXITY_LABELS: Record<string, Complexity> = {
  "shopfloor:quick": "quick",
  "shopfloor:medium": "medium",
  "shopfloor:large": "large",
};

export function resolveStage(ctx: StateContext): RouterDecision {
  switch (ctx.eventName) {
    case "issues":
      return resolveIssueEvent(
        ctx.payload as IssuePayload,
        ctx.triggerLabel,
        ctx.liveLabels,
      );
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

// Inlined from router/src/helpers/resolve-artifact-paths.ts (22 lines).
// Only used by computeStageFromLabels and not shared elsewhere in v2.
const CANONICAL_SPEC_DIR = "docs/shopfloor/specs";
const CANONICAL_PLAN_DIR = "docs/shopfloor/plans";

function resolveArtifactPaths(
  issueNumber: number,
  slug: string,
  metadata: { specPath?: string; planPath?: string } | null,
): { specFilePath: string; planFilePath: string } {
  return {
    specFilePath:
      metadata?.specPath ?? `${CANONICAL_SPEC_DIR}/${issueNumber}-${slug}.md`,
    planFilePath:
      metadata?.planPath ?? `${CANONICAL_PLAN_DIR}/${issueNumber}-${slug}.md`,
  };
}

export function computeStageFromLabels(
  labels: Set<string>,
  issue: { number: number; title: string; body: string | null },
): RouterDecision | null {
  const issueNumber = issue.number;
  // Prefer the slug persisted in the issue body metadata block so title
  // renames after triage don't strand later stages against file paths that
  // no longer exist. Fall back to deriving from the title for legacy issues
  // whose metadata block has not yet been written.
  const metadata = parseIssueMetadata(issue.body);
  const slug = metadata?.slug ?? branchSlug(issue.title);
  const { specFilePath, planFilePath } = resolveArtifactPaths(
    issueNumber,
    slug,
    metadata,
  );
  const complexity = complexityOf(labels);
  if (labels.has("shopfloor:needs-spec")) {
    return {
      stage: "spec",
      issueNumber,
      ...(complexity !== undefined ? { complexity } : {}),
      branchName: `shopfloor/spec/${issueNumber}-${slug}`,
      specFilePath,
    };
  }
  if (labels.has("shopfloor:needs-plan")) {
    return {
      stage: "plan",
      issueNumber,
      ...(complexity !== undefined ? { complexity } : {}),
      branchName: `shopfloor/plan/${issueNumber}-${slug}`,
      specFilePath,
      planFilePath,
    };
  }
  if (labels.has("shopfloor:needs-impl")) {
    return {
      stage: "implement",
      issueNumber,
      ...(complexity !== undefined ? { complexity } : {}),
      branchName: `shopfloor/impl/${issueNumber}-${slug}`,
      specFilePath,
      planFilePath,
    };
  }
  return null;
}

function resolveIssueEvent(
  payload: IssuePayload,
  triggerLabel?: string,
  liveLabels?: string[],
): RouterDecision {
  const labels = liveLabels
    ? new Set(liveLabels)
    : issueLabelSet(payload.issue);
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
    // Review is driven by impl-PR events (synchronize / ready_for_review),
    // not issue events. Removing shopfloor:failed:review clears the
    // failed-label gate so the next push to the impl PR can retrigger
    // review naturally; there is no issue-side action to take here. The
    // descriptive reason makes this visible in router logs and matches the
    // retry instructions surfaced by report-failure for stage=review.
    if (failedStage === "review" && labels.has("shopfloor:needs-review")) {
      return {
        stage: "none",
        issueNumber,
        reason: "retry_review_cleared_awaiting_next_push",
      };
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
    // Review PRs don't have a merge-driven transition: the review stage's
    // verdict already advanced state. Only the three artifact-producing stages
    // need the merge-time label flip.
    if (
      meta.stage === "spec" ||
      meta.stage === "plan" ||
      meta.stage === "implement"
    ) {
      return {
        stage: "none",
        issueNumber: meta.issueNumber,
        advanceOnMerge: { mergedStage: meta.stage, prNumber: pr.number },
        reason: `pr_merged_${meta.stage}_triggered_label_flip`,
      };
    }
    return {
      stage: "none",
      issueNumber: meta.issueNumber,
      reason: `pr_merged_${meta.stage}_no_transition`,
    };
  }

  if (payload.action === "closed") {
    return { stage: "none", reason: "pr_closed_not_merged_ignored" };
  }

  // WIP label removal on an impl PR triggers review -- the non-draft
  // equivalent of ready_for_review. Non-WIP unlabeled events fall
  // through to the catch-all and return stage: "none".
  if (
    payload.action === "unlabeled" &&
    payload.label?.name === "shopfloor:wip" &&
    meta.stage === "implement"
  ) {
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

  // `synchronize` fires on every push to the impl branch (first impl run and
  // every subsequent revision). `ready_for_review` fires once when the impl
  // job un-drafts the PR after its final post-agent push: the initial
  // synchronize arrives while the PR is still a draft (and is correctly
  // ignored below), so ready_for_review is the event that actually promotes
  // the first-iteration impl run into review.
  if (
    (payload.action === "synchronize" ||
      payload.action === "ready_for_review") &&
    meta.stage === "implement"
  ) {
    const labels = prLabelSet(pr);
    if (labels.has("shopfloor:skip-review")) {
      return { stage: "none", reason: "skip_review_label_present" };
    }
    if (pr.draft) return { stage: "none", reason: "pr_is_draft" };
    if (labels.has("shopfloor:wip"))
      return { stage: "none", reason: "pr_has_wip_label" };
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
    // v2: parseStageBranchRef is single-arg; check parsed.stage === "impl"
    const parsed = parseStageBranchRef(pr.head.ref);
    if (!parsed || parsed.stage !== "impl") {
      return {
        stage: "none",
        issueNumber: meta.issueNumber,
        reason: "impl_revision_unparseable_branch_ref",
      };
    }
    return {
      stage: "implement",
      issueNumber: meta.issueNumber,
      revisionMode: true,
      reviewIteration: meta.reviewIteration,
      branchName: pr.head.ref,
      implPrNumber: pr.number,
      specFilePath: `docs/shopfloor/specs/${parsed.issueNumber}-${parsed.slug}.md`,
      planFilePath: `docs/shopfloor/plans/${parsed.issueNumber}-${parsed.slug}.md`,
      reason: isShopfloorReview
        ? "agent_requested_changes"
        : "human_requested_changes",
    };
  }

  // Spec and plan PRs go through human review. A REQUEST_CHANGES here means
  // the human wants the agent to rewrite the design artifact. Recover the
  // branch name and the canonical spec/plan file path from the PR's head
  // ref so the downstream stage has everything it needs to upsert the
  // existing PR instead of opening a new one. Fail closed on unparseable
  // refs the same way the implement branch does.
  if (meta.stage === "spec" || meta.stage === "plan") {
    // v2: parseStageBranchRef is single-arg; check parsed.stage matches meta.stage
    const parsed = parseStageBranchRef(pr.head.ref);
    if (!parsed || parsed.stage !== meta.stage) {
      return {
        stage: "none",
        issueNumber: meta.issueNumber,
        reason: `${meta.stage}_revision_unparseable_branch_ref`,
      };
    }
    const specFilePath = `docs/shopfloor/specs/${parsed.issueNumber}-${parsed.slug}.md`;
    const planFilePath = `docs/shopfloor/plans/${parsed.issueNumber}-${parsed.slug}.md`;
    return {
      stage: meta.stage,
      issueNumber: meta.issueNumber,
      revisionMode: true,
      branchName: pr.head.ref,
      specFilePath,
      ...(meta.stage === "plan" ? { planFilePath } : {}),
      reason: isShopfloorReview
        ? "agent_requested_changes"
        : "human_requested_changes",
    };
  }

  return {
    stage: meta.stage,
    issueNumber: meta.issueNumber,
    revisionMode: true,
  };
}

export function resolveReviewOnly(payload: PullRequestPayload): RouterDecision {
  const pr = payload.pull_request;

  // PRs authored by the full Shopfloor pipeline carry metadata. Let the
  // full pipeline handle them; this workflow is for human-author PRs only.
  const meta = parsePrMetadata(pr.body);
  if (meta) {
    return {
      stage: "none",
      reason: "pr_has_shopfloor_metadata_use_full_pipeline",
    };
  }

  if (pr.state === "closed") {
    return { stage: "none", reason: "pr_is_closed" };
  }
  if (pr.draft) {
    return { stage: "none", reason: "pr_is_draft" };
  }
  if (prLabelSet(pr).has("shopfloor:skip-review")) {
    return { stage: "none", reason: "skip_review_label_present" };
  }

  // First review cycle starts at 0; subsequent runs read the footer that
  // aggregate-review appends on the first REQUEST_CHANGES.
  const iterMatch = pr.body?.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  const reviewIteration = iterMatch ? Number(iterMatch[1]) : 0;

  return {
    stage: "review",
    implPrNumber: pr.number,
    reviewIteration,
  };
}
