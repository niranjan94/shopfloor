import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export type PrecheckStage =
  | "triage"
  | "spec"
  | "plan"
  | "implement"
  | "review-aggregator"
  | "handle-merge";

export interface PrecheckParams {
  stage: PrecheckStage;
  issueNumber: number;
  /** For review-aggregator only: the PR head SHA the matrix analysed. */
  analysedSha?: string;
  /** For review-aggregator only: PR number to read head sha from. */
  prNumber?: number;
  /** For handle-merge only: the merged stage (spec|plan|implement). */
  mergedStage?: "spec" | "plan" | "implement";
}

export interface PrecheckResult {
  skip: boolean;
  reason: string;
}

const TRIAGE_BLOCKING_STATE_LABELS = new Set<string>([
  "shopfloor:needs-spec",
  "shopfloor:needs-plan",
  "shopfloor:needs-impl",
  "shopfloor:impl-in-review",
  "shopfloor:needs-review",
  "shopfloor:review-requested-changes",
  "shopfloor:review-approved",
  "shopfloor:review-stuck",
  "shopfloor:done",
  "shopfloor:quick",
  "shopfloor:medium",
  "shopfloor:large",
]);

export async function precheckStage(
  adapter: GitHubAdapter,
  params: PrecheckParams,
): Promise<PrecheckResult> {
  let labels: Set<string>;
  try {
    const issue = await adapter.getIssue(params.issueNumber);
    labels = new Set(issue.labels.map((l) => l.name));
  } catch (err) {
    // Fail-open on transient read errors. In-helper assertions will catch
    // any truly stale mutation downstream.
    core.warning(
      `precheck-stage: issue read failed for ${params.issueNumber}, falling back to skip=false: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { skip: false, reason: "precheck_read_error_fail_open" };
  }

  switch (params.stage) {
    case "triage": {
      for (const l of TRIAGE_BLOCKING_STATE_LABELS) {
        if (labels.has(l)) {
          return {
            skip: true,
            reason: `triage_already_completed_state_label_${l}_present`,
          };
        }
      }
      return { skip: false, reason: "triage_preconditions_hold" };
    }
    case "spec": {
      if (!labels.has("shopfloor:needs-spec")) {
        return { skip: true, reason: "spec_needs_spec_label_absent" };
      }
      if (labels.has("shopfloor:spec-running")) {
        return { skip: true, reason: "spec_already_in_progress" };
      }
      return { skip: false, reason: "spec_preconditions_hold" };
    }
    case "plan": {
      if (!labels.has("shopfloor:needs-plan")) {
        return { skip: true, reason: "plan_needs_plan_label_absent" };
      }
      if (labels.has("shopfloor:plan-running")) {
        return { skip: true, reason: "plan_already_in_progress" };
      }
      return { skip: false, reason: "plan_preconditions_hold" };
    }
    case "implement": {
      const needsImpl = labels.has("shopfloor:needs-impl");
      const revisionMode = labels.has("shopfloor:review-requested-changes");
      if (!needsImpl && !revisionMode) {
        return {
          skip: true,
          reason: "implement_neither_needs_impl_nor_revision_label_present",
        };
      }
      if (labels.has("shopfloor:implementing")) {
        return { skip: true, reason: "implement_already_in_progress" };
      }
      return { skip: false, reason: "implement_preconditions_hold" };
    }
    case "review-aggregator": {
      if (!labels.has("shopfloor:needs-review")) {
        return { skip: true, reason: "review_needs_review_label_absent" };
      }
      if (params.analysedSha && params.prNumber !== undefined) {
        try {
          const pr = await adapter.getPr(params.prNumber);
          if (pr.head.sha !== params.analysedSha) {
            return {
              skip: true,
              reason: `review_head_sha_drift_expected_${params.analysedSha.slice(0, 7)}_got_${pr.head.sha.slice(0, 7)}`,
            };
          }
        } catch (err) {
          core.warning(
            `precheck-stage: review PR fetch failed, falling open: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return { skip: false, reason: "precheck_pr_read_error_fail_open" };
        }
      }
      return { skip: false, reason: "review_preconditions_hold" };
    }
    case "handle-merge": {
      switch (params.mergedStage) {
        case "spec":
          if (labels.has("shopfloor:needs-plan")) {
            return {
              skip: true,
              reason: "handle_merge_spec_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_spec_preconditions_hold",
          };
        case "plan":
          if (labels.has("shopfloor:needs-impl")) {
            return {
              skip: true,
              reason: "handle_merge_plan_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_plan_preconditions_hold",
          };
        case "implement":
          if (labels.has("shopfloor:done")) {
            return {
              skip: true,
              reason: "handle_merge_impl_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_impl_preconditions_hold",
          };
        default:
          return {
            skip: true,
            reason: `handle_merge_unknown_merged_stage_${params.mergedStage}`,
          };
      }
    }
  }
}

export async function runPrecheckStage(
  adapter: GitHubAdapter,
): Promise<void> {
  const stage = core.getInput("stage", { required: true }) as PrecheckStage;
  const issueNumber = Number(
    core.getInput("issue_number", { required: true }),
  );
  const analysedSha = core.getInput("analysed_sha") || undefined;
  const prNumberInput = core.getInput("pr_number");
  const prNumber = prNumberInput ? Number(prNumberInput) : undefined;
  const mergedStageInput = core.getInput("merged_stage");
  const mergedStage = mergedStageInput
    ? (mergedStageInput as "spec" | "plan" | "implement")
    : undefined;

  const result = await precheckStage(adapter, {
    stage,
    issueNumber,
    analysedSha,
    prNumber,
    mergedStage,
  });

  core.setOutput("skip", result.skip ? "true" : "false");
  core.setOutput("reason", result.reason);
  if (result.skip) {
    core.notice(`precheck-stage: skipping ${stage} - ${result.reason}`);
  } else {
    core.info(`precheck-stage: ${stage} preconditions hold - ${result.reason}`);
  }
}
