import { AgentError } from "./agents/adapter.js";
import type { AgentAdapter } from "./agents/adapter.js";
import type { AuditEmitter } from "./audit/events.js";
import type { Config } from "./config/inputs.js";
import type { GitHubAdapter } from "./github/adapter.js";
import { resolveStage, resolveReviewOnly } from "./state/machine.js";
import {
  LABELS,
  failedLabelFor,
  runningLabelFor,
  type Stage,
} from "./state/labels.js";
import type {
  EventPayload,
  IssuePayload,
  PullRequestPayload,
  PullRequestReviewPayload,
  RouterDecision,
} from "./state/types.js";
import type { StageContext } from "./stages/_shared/context.js";
import { RUNNERS } from "./runners.js";

export interface OrchestratorResult {
  stage: Stage | "none";
  executed: boolean;
}

export interface OrchestratorArgs {
  event: { name: string; payload: EventPayload };
  repo: { owner: string; name: string };
  github: GitHubAdapter;
  reviewGithub: GitHubAdapter | null;
  agent: AgentAdapter;
  audit: AuditEmitter;
  config: Config;
  runId: string;
  shopfloorBotLogin?: string;
  // When true, route pull_request events via resolveReviewOnly() instead of
  // resolveStage(). Used by the review-only caller workflow (e.g.
  // dogfood-review.yml) to add agent review on human-authored PRs that
  // carry no Shopfloor metadata. No-op for non-pull_request events.
  reviewOnly?: boolean;
}

const TRIAGE_BLOCKING_STATE_LABELS = new Set<string>([
  LABELS.triaging,
  LABELS.needsSpec,
  LABELS.needsPlan,
  LABELS.needsImpl,
  LABELS.implInReview,
  LABELS.needsReview,
  LABELS.reviewRequestedChanges,
  LABELS.reviewApproved,
  LABELS.reviewStuck,
  LABELS.done,
  LABELS.complexityQuick,
  LABELS.complexityMedium,
  LABELS.complexityLarge,
]);

export async function runOrchestrator(
  args: OrchestratorArgs,
): Promise<OrchestratorResult> {
  const liveLabels = extractEventLabels(args.event);
  const triggerLabel = args.config.triggerLabel ?? undefined;

  const decision =
    args.reviewOnly && args.event.name === "pull_request"
      ? resolveReviewOnly(args.event.payload as PullRequestPayload)
      : resolveStage({
          eventName: args.event.name,
          payload: args.event.payload,
          ...(triggerLabel !== undefined ? { triggerLabel } : {}),
          ...(liveLabels !== undefined ? { liveLabels } : {}),
          ...(args.shopfloorBotLogin !== undefined
            ? { shopfloorBotLogin: args.shopfloorBotLogin }
            : {}),
        });

  args.audit({
    type: "stage_resolved",
    stage: decision.stage,
    reason: decision.reason ?? "",
    ...(decision.issueNumber !== undefined
      ? { issueNumber: decision.issueNumber }
      : {}),
  });

  if (decision.stage === "none") {
    return { stage: "none", executed: false };
  }

  const stage = decision.stage as Stage;
  const issue = loadIssueFromEvent(args.event, liveLabels);
  const pr = await loadPrForStage(args, decision);

  const ctx: StageContext = {
    event: args.event.payload,
    repo: args.repo,
    decision,
    github: args.github,
    reviewGithub: args.reviewGithub,
    agent: args.agent,
    audit: args.audit,
    config: args.config,
    runId: args.runId,
  };
  if (issue !== null) ctx.issue = issue;
  if (pr !== null) ctx.pr = pr;
  if (args.reviewOnly === true) ctx.reviewOnly = true;

  const precheck = precheckStage(stage, new Set(issue?.labels ?? []));
  if (!precheck.ok) {
    args.audit({ type: "precheck_failed", stage, reason: precheck.reason });
    return { stage, executed: false };
  }

  args.audit({
    type: "stage_started",
    stage,
    model: modelForStage(stage, args.config),
    runId: args.runId,
  });

  // Acquire the mutex marker before the stage runs. Triage has no mutex
  // label; spec/plan/implement/review do. Update the in-memory issue label
  // snapshot too so apply() guards that read ctx.issue.labels can observe it.
  const mutex = mutexLabelFor(stage);
  if (mutex && decision.issueNumber !== undefined) {
    await args.github.addLabel(decision.issueNumber, mutex);
    if (ctx.issue && !ctx.issue.labels.includes(mutex)) {
      ctx.issue.labels.push(mutex);
    }
  }

  try {
    await RUNNERS[stage].execute(ctx, decision);
  } catch (err) {
    await reportFailure(ctx, stage, err);
    throw err;
  } finally {
    // Release the mutex even on failure. The stage's own apply() may have
    // already removed it; replaceLabels' remove-then-add tolerates 404.
    if (mutex && decision.issueNumber !== undefined) {
      await args.github.removeLabel(decision.issueNumber, mutex);
    }
  }
  return { stage, executed: true };
}

function mutexLabelFor(stage: Stage): string | null {
  // runningLabelFor throws for triage; we want null instead.
  if (stage === "triage") return null;
  return runningLabelFor(stage);
}

function modelForStage(stage: Stage, cfg: Config): string {
  switch (stage) {
    case "triage":
      return cfg.triageModel;
    case "spec":
      return cfg.specModel;
    case "plan":
      return cfg.planModel;
    case "implement":
      return cfg.implModel;
    case "review":
      return cfg.reviewModels.compliance;
  }
}

function extractEventLabels(event: {
  name: string;
  payload: EventPayload;
}): string[] | undefined {
  switch (event.name) {
    case "issues": {
      const p = event.payload as IssuePayload;
      if (!p.issue) return undefined;
      return p.issue.labels.map((l) => l.name);
    }
    case "pull_request":
    case "pull_request_review": {
      const p = event.payload as PullRequestPayload | PullRequestReviewPayload;
      if (!p.pull_request) return undefined;
      return p.pull_request.labels.map((l) => l.name);
    }
    default:
      return undefined;
  }
}

interface IssueContext {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
}

interface PrContext {
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
}

function loadIssueFromEvent(
  event: { name: string; payload: EventPayload },
  liveLabels: string[] | undefined,
): IssueContext | null {
  if (event.name !== "issues") return null;
  const p = event.payload as IssuePayload;
  if (!p.issue) return null;
  return {
    number: p.issue.number,
    title: p.issue.title,
    body: p.issue.body,
    labels: liveLabels ?? p.issue.labels.map((l) => l.name),
  };
}

async function loadPrForStage(
  args: OrchestratorArgs,
  decision: RouterDecision,
): Promise<PrContext | null> {
  // Prefer the event payload when available -- it carries head/base SHAs at
  // the moment the event fired, which is exactly what review needs to anchor
  // against.
  if (
    args.event.name === "pull_request" ||
    args.event.name === "pull_request_review"
  ) {
    const p = args.event.payload as
      | PullRequestPayload
      | PullRequestReviewPayload;
    if (p.pull_request) {
      return {
        number: p.pull_request.number,
        title: "",
        body: p.pull_request.body,
        headRef: p.pull_request.head.ref,
        headSha: p.pull_request.head.sha,
        baseRef: p.pull_request.base.ref,
      };
    }
  }
  // Issue-side events that route to review (e.g. unlabel(review-stuck))
  // identify the impl PR via decision.implPrNumber; pull it via the API.
  if (decision.stage === "review" && decision.implPrNumber !== undefined) {
    const data = await args.github.getPr(decision.implPrNumber);
    return {
      number: decision.implPrNumber,
      title: "",
      body: data.body,
      headRef: "",
      headSha: data.head.sha,
      baseRef: "main",
    };
  }
  return null;
}

interface PrecheckResult {
  ok: boolean;
  reason: string;
}

// Ported from router/src/helpers/precheck-stage.ts. Catches stale events that
// the state machine would otherwise route to a stage whose preconditions have
// already been cleared by an earlier run.
function precheckStage(stage: Stage, labels: Set<string>): PrecheckResult {
  switch (stage) {
    case "triage": {
      for (const l of TRIAGE_BLOCKING_STATE_LABELS) {
        if (labels.has(l)) {
          return {
            ok: false,
            reason: `triage_already_completed_state_label_${l}_present`,
          };
        }
      }
      return { ok: true, reason: "triage_preconditions_hold" };
    }
    case "spec": {
      const needs = labels.has(LABELS.needsSpec);
      const inReview = labels.has(LABELS.specInReview);
      if (!needs && !inReview) {
        return {
          ok: false,
          reason: "spec_neither_needs_spec_nor_in_review_label_present",
        };
      }
      if (labels.has(LABELS.specRunning)) {
        return { ok: false, reason: "spec_already_in_progress" };
      }
      return { ok: true, reason: "spec_preconditions_hold" };
    }
    case "plan": {
      const needs = labels.has(LABELS.needsPlan);
      const inReview = labels.has(LABELS.planInReview);
      if (!needs && !inReview) {
        return {
          ok: false,
          reason: "plan_neither_needs_plan_nor_in_review_label_present",
        };
      }
      if (labels.has(LABELS.planRunning)) {
        return { ok: false, reason: "plan_already_in_progress" };
      }
      return { ok: true, reason: "plan_preconditions_hold" };
    }
    case "implement": {
      const needs = labels.has(LABELS.needsImpl);
      const revision = labels.has(LABELS.reviewRequestedChanges);
      if (!needs && !revision) {
        return {
          ok: false,
          reason: "implement_neither_needs_impl_nor_revision_label_present",
        };
      }
      if (labels.has(LABELS.implementing)) {
        return { ok: false, reason: "implement_already_in_progress" };
      }
      return { ok: true, reason: "implement_preconditions_hold" };
    }
    case "review": {
      // Review preconditions are validated by the state machine on every
      // synchronize/ready_for_review event; the orchestrator does not gate.
      return { ok: true, reason: "review_preconditions_hold" };
    }
  }
}

async function reportFailure(
  ctx: StageContext,
  stage: Stage,
  err: unknown,
): Promise<void> {
  const kind = err instanceof AgentError ? err.kind : "internal";
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.issue) {
    await ctx.github.addLabel(ctx.issue.number, failedLabelFor(stage));
    await ctx.github.postIssueComment(
      ctx.issue.number,
      formatFailureComment(stage, kind, message, ctx.runId),
    );
  }
  ctx.audit({ type: "stage_failed", stage, error: { kind, message } });
}

function formatFailureComment(
  stage: Stage,
  kind: string,
  message: string,
  runId: string,
): string {
  return [
    `## Shopfloor ${stage} failure`,
    "",
    `**Kind:** \`${kind}\``,
    `**Run:** \`${runId}\``,
    "",
    "```",
    message.slice(0, 4000),
    "```",
    "",
    `Remove the \`shopfloor:failed:${stage}\` label to retry.`,
  ].join("\n");
}
