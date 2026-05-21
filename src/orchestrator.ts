import { AgentError } from "./agents/adapter.js";
import type { AgentAdapter } from "./agents/adapter.js";
import type { AuditEmitter } from "./audit/events.js";
import type { Config } from "./config/inputs.js";
import type { GitHubAdapter } from "./github/adapter.js";
import { resolveStage, resolveReviewOnly } from "./state/machine.js";
import {
  LABELS,
  LABEL_DEFS,
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
import type { GitOps, StageContext } from "./stages/_shared/context.js";
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
  // Git helpers seeded with the resolved AuthSpec by entry.ts. Plumbed into
  // StageContext so the implement runner can configure the working tree and
  // push the agent's commits. Optional for unit/e2e tests that drive the
  // orchestrator without a real checkout.
  gitOps?: GitOps;
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

  const routingContext = extractRoutingContext(args.event, liveLabels);
  args.audit({
    type: "stage_resolved",
    stage: decision.stage,
    reason: decision.reason ?? "",
    ...(decision.issueNumber !== undefined
      ? { issueNumber: decision.issueNumber }
      : {}),
    eventName: args.event.name,
    ...(routingContext.action !== undefined
      ? { action: routingContext.action }
      : {}),
    ...(routingContext.labelName !== undefined
      ? { labelName: routingContext.labelName }
      : {}),
    ...(routingContext.payloadLabels !== undefined
      ? { payloadLabels: routingContext.payloadLabels }
      : {}),
    ...(liveLabels !== undefined ? { liveLabels } : {}),
  });

  // advanceOnMerge is a pure label-flip transition that the state machine
  // attaches to a stage="none" decision when a Shopfloor stage PR merges.
  // It is owned by the router-side primary App token, requires no agent
  // invocation, mutex, or precheck. In split-runner workflows the resolve
  // job is the only job that runs for merge events (the execute jobs gate
  // on stage != "none"), so the flip must happen here or it is dropped on
  // the floor and the issue strands at <stage>-in-review.
  if (
    decision.stage === "none" &&
    decision.advanceOnMerge !== undefined &&
    decision.issueNumber !== undefined
  ) {
    const advanced = await advanceOnMerge(args.github, args.audit, {
      issueNumber: decision.issueNumber,
      mergedStage: decision.advanceOnMerge.mergedStage,
      prNumber: decision.advanceOnMerge.prNumber,
    });
    return { stage: "none", executed: advanced };
  }

  if (args.config.mode === "resolve") {
    return { stage: decision.stage, executed: false };
  }

  if (
    args.config.mode === "execute" &&
    args.config.stages.length > 0 &&
    decision.stage !== "none" &&
    !args.config.stages.includes(decision.stage as Stage)
  ) {
    return { stage: decision.stage, executed: false };
  }

  if (decision.stage === "none") {
    return { stage: "none", executed: false };
  }

  const stage = decision.stage as Stage;
  let issue = loadIssueFromEvent(args.event, liveLabels);
  const pr = await loadPrForStage(args, decision);
  // Resolve the repo's default branch lazily, only once per execute path.
  // Stage PRs target this branch; assuming "main" silently breaks repos that
  // ship from any other trunk.
  const defaultBranch = await args.github.getDefaultBranch();
  // Provision any missing shopfloor:* labels with their canonical colors and
  // descriptions. Idempotent: only creates labels that don't already exist, so
  // hand-edits and re-runs are both safe.
  const createdLabels = await args.github.bootstrapLabels(LABEL_DEFS);
  if (createdLabels.length > 0) {
    args.audit({ type: "labels_bootstrapped", created: createdLabels });
  }

  // Hydrate the issue from the API when the event payload doesn't carry one
  // (pull_request, pull_request_review). All stages that route from a PR event
  // need ctx.issue: implement re-enters when a reviewer requests changes, and
  // review writes pipeline-state labels (needs-review → review-approved) onto
  // the issue, not the PR. Without hydration, applyReview's labelTarget falls
  // back to the PR number and the issue strands with stale needs-review while
  // review-approved lands on the wrong object.
  if (issue === null && decision.issueNumber !== undefined) {
    const live = await args.github.getIssue(decision.issueNumber);
    issue = {
      number: decision.issueNumber,
      title: live.title,
      body: live.body,
      labels: live.labels.map((l) => l.name),
    };
  }

  const ctx: StageContext = {
    event: args.event.payload,
    repo: args.repo,
    defaultBranch,
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
  if (args.gitOps !== undefined) ctx.gitOps = args.gitOps;

  // In execute mode, the resolve->execute gap can be 30-60s, long enough for
  // labels to flip after the event fired. Fetch live labels from the API so
  // precheck sees current state. v1 commit aaef95f.
  let precheckLabels: Set<string>;
  if (args.config.mode === "execute" && decision.issueNumber !== undefined) {
    const live = await args.github.getIssue(decision.issueNumber);
    precheckLabels = new Set(live.labels.map((l) => l.name));
  } else {
    precheckLabels = new Set(issue?.labels ?? []);
  }

  // A human REQUEST_CHANGES on an impl PR routes the state machine to
  // implement+revisionMode, but the issue still carries shopfloor:needs-review
  // (and possibly shopfloor:review-stuck). Apply the v1 apply-review-revision
  // flip before precheck so the implement preconditions hold and the loop
  // unsticks. The agent path (aggregate-review verdict=REQUEST_CHANGES) writes
  // these labels itself in review/apply.ts; only the human path needs help.
  if (
    stage === "implement" &&
    decision.revisionMode === true &&
    decision.reason === "human_requested_changes" &&
    decision.issueNumber !== undefined
  ) {
    await applyHumanReviewRevision(
      args.github,
      args.audit,
      decision.issueNumber,
      precheckLabels,
    );
    if (ctx.issue) ctx.issue.labels = Array.from(precheckLabels);
  }

  const precheck = precheckStage(stage, precheckLabels);
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

  // Acquire the mutex marker before the stage runs. Every stage has a mutex
  // label (triaging / spec-running / plan-running / implementing / review-
  // running). Update the in-memory issue label snapshot too so apply() guards
  // that read ctx.issue.labels can observe it.
  const mutex = runningLabelFor(stage);
  if (decision.issueNumber !== undefined) {
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
    // already removed it; removeLabel tolerates 404.
    if (decision.issueNumber !== undefined) {
      await args.github.removeLabel(decision.issueNumber, mutex);
    }
  }
  return { stage, executed: true };
}

// Performs the v1 handle-merge transition for the three artifact-producing
// stages. Idempotent: if the downstream label is already present, skips with
// no API writes (handles double-fired close events and workflow races).
// Returns true when any mutation was performed.
async function advanceOnMerge(
  github: GitHubAdapter,
  audit: AuditEmitter,
  args: {
    issueNumber: number;
    mergedStage: "spec" | "plan" | "implement";
    prNumber: number;
  },
): Promise<boolean> {
  const issue = await github.getIssue(args.issueNumber);
  const current = new Set(issue.labels.map((l) => l.name));

  switch (args.mergedStage) {
    case "spec": {
      if (current.has(LABELS.needsPlan)) return false;
      await github.removeLabel(args.issueNumber, LABELS.specInReview);
      await github.addLabel(args.issueNumber, LABELS.needsPlan);
      await github.postIssueComment(
        args.issueNumber,
        `Spec merged in #${args.prNumber}. Moving to planning stage.`,
      );
      audit({
        type: "label_applied",
        issueNumber: args.issueNumber,
        add: [LABELS.needsPlan],
        remove: [LABELS.specInReview],
      });
      return true;
    }
    case "plan": {
      if (current.has(LABELS.needsImpl)) return false;
      await github.removeLabel(args.issueNumber, LABELS.planInReview);
      await github.addLabel(args.issueNumber, LABELS.needsImpl);
      await github.postIssueComment(
        args.issueNumber,
        `Plan merged in #${args.prNumber}. Moving to implementation stage.`,
      );
      audit({
        type: "label_applied",
        issueNumber: args.issueNumber,
        add: [LABELS.needsImpl],
        remove: [LABELS.planInReview],
      });
      return true;
    }
    case "implement": {
      if (current.has(LABELS.done)) return false;
      await github.removeLabel(args.issueNumber, LABELS.implInReview);
      await github.removeLabel(args.issueNumber, LABELS.reviewApproved);
      await github.addLabel(args.issueNumber, LABELS.done);
      await github.postIssueComment(
        args.issueNumber,
        `Implementation merged in #${args.prNumber}. Pipeline complete.`,
      );
      await github.closeIssue(args.issueNumber);
      audit({
        type: "label_applied",
        issueNumber: args.issueNumber,
        add: [LABELS.done],
        remove: [LABELS.implInReview, LABELS.reviewApproved],
      });
      return true;
    }
  }
}

// Mirrors v1's apply-review-revision helper. Run before the implement stage
// when a human reviewer submits REQUEST_CHANGES on an impl PR: the state
// machine has already routed to implement+revisionMode, but the issue still
// has shopfloor:needs-review (and possibly shopfloor:review-stuck), so the
// implement precheck would refuse. Mutates `precheckLabels` so the precheck
// run that follows sees the post-flip state.
async function applyHumanReviewRevision(
  github: GitHubAdapter,
  audit: AuditEmitter,
  issueNumber: number,
  precheckLabels: Set<string>,
): Promise<void> {
  const add: string[] = [];
  const remove: string[] = [];
  if (!precheckLabels.has(LABELS.reviewRequestedChanges)) {
    await github.addLabel(issueNumber, LABELS.reviewRequestedChanges);
    precheckLabels.add(LABELS.reviewRequestedChanges);
    add.push(LABELS.reviewRequestedChanges);
  }
  if (precheckLabels.has(LABELS.needsReview)) {
    await github.removeLabel(issueNumber, LABELS.needsReview);
    precheckLabels.delete(LABELS.needsReview);
    remove.push(LABELS.needsReview);
  }
  if (precheckLabels.has(LABELS.reviewStuck)) {
    await github.removeLabel(issueNumber, LABELS.reviewStuck);
    precheckLabels.delete(LABELS.reviewStuck);
    remove.push(LABELS.reviewStuck);
  }
  if (add.length > 0 || remove.length > 0) {
    audit({ type: "label_applied", issueNumber, add, remove });
  }
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

interface RoutingContext {
  action?: string;
  labelName?: string;
  payloadLabels?: string[];
}

function extractRoutingContext(
  event: { name: string; payload: EventPayload },
  liveLabels: string[] | undefined,
): RoutingContext {
  switch (event.name) {
    case "issues": {
      const p = event.payload as IssuePayload;
      const ctx: RoutingContext = {};
      if (p.action !== undefined) ctx.action = p.action;
      if (p.label?.name !== undefined) ctx.labelName = p.label.name;
      if (p.issue) {
        const payloadLabels = p.issue.labels.map((l) => l.name);
        // Only attach payloadLabels when it differs from liveLabels -- if a
        // route caller already refetched, the two arrays carry the same
        // information and duplicating them costs log bytes for no signal.
        if (
          liveLabels === undefined ||
          !arraysEqual(payloadLabels, liveLabels)
        ) {
          ctx.payloadLabels = payloadLabels;
        }
      }
      return ctx;
    }
    case "pull_request":
    case "pull_request_review": {
      const p = event.payload as PullRequestPayload | PullRequestReviewPayload;
      const ctx: RoutingContext = {};
      if ("action" in p && typeof p.action === "string") ctx.action = p.action;
      if ("label" in p && p.label?.name !== undefined) {
        ctx.labelName = p.label.name;
      }
      return ctx;
    }
    case "issue_comment": {
      const p = event.payload as { action?: string };
      return p.action !== undefined ? { action: p.action } : {};
    }
    default:
      return {};
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
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
      baseRef: data.base.ref,
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
      const revise = labels.has(LABELS.revise);
      if (!needs && !revision && !revise) {
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
