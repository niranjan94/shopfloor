import type { Stage, Complexity } from "./labels.js";

export type { Stage, Complexity };

// Re-exported for convenience so callers only need one import.
export type ShopfloorLabel =
  | "shopfloor:triaging"
  | "shopfloor:awaiting-info"
  | "shopfloor:quick"
  | "shopfloor:medium"
  | "shopfloor:large"
  | "shopfloor:needs-spec"
  | "shopfloor:spec-in-review"
  | "shopfloor:needs-plan"
  | "shopfloor:plan-in-review"
  | "shopfloor:needs-impl"
  | "shopfloor:impl-in-review"
  | "shopfloor:needs-review"
  | "shopfloor:review-requested-changes"
  | "shopfloor:review-approved"
  | "shopfloor:review-stuck"
  | "shopfloor:skip-review"
  | "shopfloor:done"
  | "shopfloor:revise"
  | `shopfloor:failed:${"triage" | "spec" | "plan" | "implement" | "review"}`
  | "shopfloor:spec-running"
  | "shopfloor:plan-running"
  | "shopfloor:implementing"
  | "shopfloor:wip";

// RouterDecision.stage uses Stage | "none" because "none" is a "no action"
// sentinel, not a real pipeline stage. "none" is intentionally excluded from
// the Stage type in labels.ts to prevent it from being used in stage-specific
// logic (e.g. runningLabelFor, needsLabelFor).
export interface RouterDecision {
  stage: Stage | "none";
  issueNumber?: number;
  complexity?: Complexity;
  branchName?: string;
  specFilePath?: string;
  planFilePath?: string;
  revisionMode?: boolean;
  reviewIteration?: number;
  implPrNumber?: number;
  // Set when a stage PR was just merged. The orchestrator performs the
  // corresponding label transition (and, for implement, closes the issue)
  // before short-circuiting on stage: "none". v1 wired this via a separate
  // workflow step (handle-merge); v2 keeps it in-process.
  advanceOnMerge?: {
    mergedStage: "spec" | "plan" | "implement";
    prNumber: number;
  };
  reason?: string;
}

export interface IssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    state: "open" | "closed";
    pull_request?: unknown | null;
  };
  label?: { name: string };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestPayload {
  action: string;
  label?: { name: string };
  pull_request: {
    number: number;
    body: string | null;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    labels: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestReviewPayload {
  action: string;
  review: {
    state:
      | "approved"
      | "changes_requested"
      | "commented"
      | "dismissed"
      | "pending";
    body: string | null;
    user: { login: string };
  };
  pull_request: PullRequestPayload["pull_request"];
  repository: { owner: { login: string }; name: string };
}

export type EventPayload =
  | IssuePayload
  | PullRequestPayload
  | PullRequestReviewPayload;

export interface StateContext {
  eventName: string;
  payload: EventPayload;
  shopfloorBotLogin?: string;
  /**
   * Optional gate label. When set, the state machine refuses to enter the pipeline
   * for issues that do not carry this label. Once the issue has any `shopfloor:*`
   * state label, the gate stops applying so iteration continues normally.
   */
  triggerLabel?: string;
  /**
   * Optional live label set for the issue, fetched from the GitHub API at
   * route-run time. When present, the state machine uses this instead of
   * the payload's (event-time) label snapshot so a route job can observe
   * writes made by an earlier group-mate's stage job.
   */
  liveLabels?: string[];
}
