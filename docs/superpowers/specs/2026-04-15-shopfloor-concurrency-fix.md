# Shopfloor concurrency and staleness fix

**Status:** Draft, pending review
**Date:** 2026-04-15
**Author:** Drafted collaboratively with Claude (Opus 4.6)
**Supersedes:** N/A (targeted fix on top of the v0.1 design)

## 1. Overview

Shopfloor's reusable workflow currently serializes every webhook event for a given issue/PR via a single workflow-level `concurrency:` group with `cancel-in-progress: false`. When an issue receives a burst of webhook events faster than the queue can process them, the middle events are silently dropped. One of those dropped events can be the `labeled` event that advances the pipeline to the next stage, which strands the issue indefinitely.

This spec proposes a four-layer fix. Two layers are correctness (the pipeline must behave right under all event orderings) and two layers are optimisation (the pipeline must not waste runner capacity doing no-op work):

1. **Correctness — per-stage concurrency.** Replace workflow-level concurrency with per-stage concurrency groups on mutating jobs only. No-op routes no longer occupy any queue slot, so they cannot preempt a real advancement event.
2. **Optimisation — router re-fetches live issue labels.** The `route` helper reads current labels from the GitHub API instead of trusting the event-time payload snapshot. Under limited-capacity custom runners, route jobs are effectively serialized by the runner pool, so a later route run can observe an earlier route run's dispatched stage job's writes and bail out without dispatching a duplicate stage job. Pure load-shedding; not required for correctness.
3. **Correctness — `precheck-stage` helper.** A new router helper runs as the first step of every mutating stage job and verifies stage preconditions against fresh API state before any expensive work happens. This runs AFTER the concurrency queue has serialized the job, so it can observe prior group-mates' writes that Layer 2 cannot. This is the backstop that guarantees no duplicate work on stale queued decisions.
4. **Correctness — transient `shopfloor:*-running` mutex marker labels.** Long-running stages write a marker label immediately after precheck passes and remove it on completion. A second queued advancement event whose precheck would otherwise pass sees the marker and bails out.

The spec also fixes a latent bug in `resolvePullRequestEvent` (missing `issueNumber` on merge events) and a group-sharing requirement between `handle-merge` and `implement` that the current design does not satisfy.

## 2. Problem statement

### 2.1 The observed failure

On a real dogfood run, the following sequence occurred after the `triage` job completed for an issue:

1. `apply-triage-decision` posted a comment on the issue (`issue_comment.created` webhook).
2. `apply-triage-decision` added `shopfloor:quick` (`issues.labeled` webhook).
3. `apply-triage-decision` added `shopfloor:needs-impl` (`issues.labeled` webhook).

All three events arrived at GitHub's concurrency queue within roughly one second. The workflow-level concurrency group `shopfloor-<N>` with `cancel-in-progress: false` keeps at most one run queued. When event 3 arrived while event 2 was still queued, one of the queued events was preempted. In this instance it was the `needs-impl` labeled event — the advancement trigger. The issue was left carrying the `shopfloor:needs-impl` label with no `implement` job ever started. Hard stall; manual intervention required.

### 2.2 Why the queue drops events

From the GitHub Actions docs:

> When concurrency is specified at the workflow level and `cancel-in-progress: false`, any subsequent runs that are queued up will wait until the currently running job is complete, and then run in the order they were queued. However, only the most recently queued workflow run will be preserved. Any previously pending runs in the queue will be canceled.

So the queue holds exactly one slot. Under Shopfloor's current configuration, every webhook event for an issue — including events whose `route` job would have resolved `stage=none` — occupies that slot and can preempt a real advancement event.

### 2.3 Why the stalled state is sticky

`computeStageFromLabels` in `router/src/state.ts` only fires advancement stages (`spec`, `plan`, `implement`) from a `labeled` event whose `payload.label.name` matches an advancement label. If the advancement `labeled` event is dropped, no subsequent unrelated event will re-trigger the advancement — the label is on the issue, but nothing reads it as a "new" transition. Pipeline stays parked.

## 3. Goals and non-goals

### Goals

- **No dropped advancement events.** A burst of webhooks for the same issue must not silently preempt the critical advancement label event.
- **No duplicate work on stale queued decisions.** A job that was routed based on a now-stale view of issue labels must detect staleness before running any agent and exit as a clean no-op.
- **No races between cross-stage mutations on the same issue.** A `handle-merge` job that flips labels must not overlap with an `implement` revision that is actively pushing commits.
- **Cost-neutral in the common case.** The extra API call(s) the fix introduces must be cheap (≤ 2 calls per route/job) and add negligible billable minutes.
- **No change in observable user behaviour** beyond the bug being fixed. Existing fixtures, prompts, and helper contracts stay intact where possible.

### Non-goals

- Rewriting the state machine's event routing. `resolveStage` keeps its shape.
- Introducing a persistent lock service (database, Redis, etc.). Everything stays on labels and native GitHub Actions features.
- Cross-issue serialization. The fix only protects within a single issue.
- Retrying dropped non-advancement events. No-op events that are dropped are still silently lost, because they were no-ops anyway.
- Handling pathological sequences where a human is manually flipping `shopfloor:*` labels mid-run. The state machine already makes no guarantees about that.

## 4. Root cause analysis

### 4.1 Workflow-level concurrency is too broad

The current group `shopfloor-${{ github.event.issue.number || github.event.pull_request.number }}` captures every event for every stage. Events that the state machine resolves to `stage=none` (e.g., a `shopfloor:quick` label flip, an `issue_comment.created`) still acquire the group and still compete for the one-slot queue with real advancement events. Narrowing the group to only cover mutating stage jobs lets no-op events sidestep the queue entirely.

### 4.2 Payload label snapshots are event-time, not current

`resolveIssueEvent` reads `payload.issue.labels`, which is the label set as of the moment GitHub emitted the webhook. If two `labeled` events fire close together, each event's payload is a snapshot that may be missing labels the other just added. For the specific scenario in §2.1, the `needs-impl` labeled event's payload correctly includes `shopfloor:quick` (it was added first), so routing is correct on live reads. The problem is not wrong-order reads — it is that once any event is enqueued behind another, its routing decision is frozen and cannot refresh as new state accumulates.

### 4.3 Routing decisions are not re-validated at job start

Under the new per-stage concurrency shape (§5.1), `route` job A and `route` job B for the same issue will run in parallel. Both read labels, both see "no state label", both resolve `stage=triage`. `triage` job A enters the per-stage group, runs to completion, and writes advancement labels. `triage` job B is still queued in the group with its original routing decision — which is now stale. When B dequeues, it blindly runs the triage agent against an already-triaged issue.

The GitHub Actions platform has no mechanism to re-evaluate a queued job's decision at dequeue time. We have to do that check ourselves as the first real step of the job.

### 4.4 `resolvePullRequestEvent` drops `issueNumber` on merge

Orthogonal bug surfaced while designing the fix. On `pull_request.closed merged=true`, `resolvePullRequestEvent` returns:

```ts
return {
  stage: "none",
  reason: `pr_merged_${meta.stage}_triggered_label_flip`,
};
```

There is no `issueNumber` populated. The downstream `handle-merge` job reads `needs.route.outputs.issue_number` and gets an empty string. Under workflow-level concurrency this was harmless (the group keyed on PR number, not issue number). Under per-stage concurrency, a group name like `shopfloor-handle-merge-${{ needs.route.outputs.issue_number }}` resolves to `shopfloor-handle-merge-` — a single global group that serializes every handle-merge for every issue in the repository. Must fix `resolvePullRequestEvent` to populate `issueNumber` from `parsePrMetadata(pr.body).issueNumber` in the merge branch.

### 4.5 Author's mistaken assumption about the old group

While reviewing the old workflow-level concurrency, it turned out `shopfloor-${{ github.event.issue.number || github.event.pull_request.number }}` keyed on **PR number** for `pull_request` events, not the linked issue number. So the merge of spec PR #57 for issue #42 ran under group `shopfloor-57`, while triage for issue #42 ran under group `shopfloor-42`. These were never in the same group under the old design. The belief that workflow-level concurrency was providing strong cross-stage serialization for an issue was wrong. Any claim in this spec that the old design "protected X" that relied on cross-event grouping should be measured against this.

## 5. Design

The fix is four cooperating layers with two distinct jobs:

- **Correctness layers (§5.1, §5.3, §5.4)** must be in place for the pipeline to behave right. Removing any of them leaves a race or a silent-drop hole.
- **Optimisation layers (§5.2)** reduce wasted work under capacity-constrained runners. They are not required for correctness and could be dropped on GitHub-hosted infrastructure without affecting behaviour; on custom runner pools with limited concurrent capacity, they meaningfully reduce the number of runner slots burned doing no-op work.

Keep this split in mind when reading the rest of the section — it affects priorities during review and future refactors. If a layer is labelled "optimisation", deleting it should not cause a regression in a correctness-only test suite; if a layer is labelled "correctness", deleting it should immediately make a test fail.

### 5.1 Layer 1 — Per-stage concurrency groups (correctness)

Remove the workflow-level `concurrency:` block. Add per-job `concurrency:` to each mutating stage job:

```yaml
triage:
  needs: route
  if: needs.route.outputs.stage == 'triage'
  concurrency:
    group: shopfloor-triage-${{ needs.route.outputs.issue_number }}
    cancel-in-progress: false
  ...
```

Jobs that get per-stage groups:

- `triage` → `shopfloor-triage-<issue_number>`
- `spec` → `shopfloor-spec-<issue_number>`
- `plan` → `shopfloor-plan-<issue_number>`
- `implement` → `shopfloor-implement-<issue_number>`
- `review-aggregator` → `shopfloor-review-<issue_number>` (shared with `implement` for revision loops — see §5.1.1)
- `handle-merge` → `shopfloor-implement-<issue_number>` (shared with `implement` — see §5.1.2)

Jobs that run un-grouped:

- `route` — pure read, no mutations, runs on every event.
- `review-skip-check` — pure read.
- `review-compliance`, `review-bugs`, `review-security`, `review-smells` — pure read (emit JSON, no writes).

Rationale: no-op routes no longer occupy any concurrency slot, so they cannot preempt advancement events. Mutating stages still serialize within their own groups, so they cannot race each other within a stage.

#### 5.1.1 `review-aggregator` shares the implement group

The review aggregator writes labels (`shopfloor:review-requested-changes`, `shopfloor:review-approved`) and posts the agent review. These writes interleave dangerously with a concurrent `implement` revision run, because a revision reads `shopfloor:review-requested-changes` to enter revision mode. Placing the aggregator in the same group as `implement` (`shopfloor-implement-<issue_number>`) serializes the "review → revise" handoff: aggregator finishes and releases the group, then `implement` acquires it. The aggregator's own concurrency concern (two iterations' aggregators overlapping) is also solved by this.

#### 5.1.2 `handle-merge` shares the implement group

Scenario: a reviewer posts `REQUEST_CHANGES` (queues an `implement` revision), then a human force-merges the impl PR before the revision starts. With separate groups, both `handle-merge` and `implement` run in parallel: `handle-merge` flips `impl-in-review → done` and closes the issue while `implement` is mid-run writing commits and progress comments to a now-closed target. Placing `handle-merge` in `shopfloor-implement-<issue_number>` serializes them: whichever one acquires the group first runs to completion, the other dequeues and its precheck (§5.3) sees the state change and exits cleanly.

### 5.2 Layer 2 — Router re-fetches live labels (optimisation, not correctness)

Change `resolveIssueEvent` and its callers so that the label set consumed by the state machine is read from the GitHub API at route-run time, not from `payload.issue.labels`. Specifically:

- In `runRoute` in `router/src/index.ts`, after receiving the event payload, call `adapter.getIssue(payload.issue.number)` (for issue events) or `adapter.getPr(payload.pull_request.number)` followed by issue-derivation (for PR events) to fetch the current label set.
- Pass those live labels into `resolveStage` via a new optional field on `StateContext` (e.g., `liveLabels?: string[]`).
- `resolveIssueEvent` prefers `liveLabels` when present, falls back to `payload.issue.labels` when absent (keeps tests and the pure state machine usable without the adapter).

The `payload.label.name` field — which carries "which label was JUST added" — is event-authoritative and is NOT re-fetched. It stays the trigger gate for `ADVANCEMENT_STATE_LABELS` matching.

#### 5.2.1 Why this layer is optimisation, not correctness

Under GitHub-hosted runners with effectively unlimited parallel capacity, every route job for a burst of events runs in parallel, within milliseconds of each other. None of them can observe writes from the others because none of the stage jobs have even been dispatched yet. The payload snapshot and a live re-fetch return the same labels in this case, so Layer 2 changes nothing. Layer 3 (§5.3) catches the staleness when the queued stage jobs eventually dequeue.

So on default GitHub infrastructure, Layer 2 is a no-op and could be dropped without affecting correctness.

#### 5.2.2 Why this layer matters on custom capacity-limited runners

Shopfloor deployments often run on custom self-hosted runner pools with limited concurrent capacity (1-4 runners is typical). Under that constraint the route jobs are no longer running in parallel — they are implicitly serialized by runner availability, and a later route can observe real state changes written by an earlier route's dispatched stage job.

Concrete walkthrough with a 2-runner pool and three events A, B, C for the same issue:

1. **t=0** — route A starts on runner 1. Route B starts on runner 2. Route C waits for capacity.
2. **t=10s** — route A finishes, dispatches triage A. Runner 1 is released.
3. **t=11s** — triage A acquires runner 1, starts a long-running agent run. Route B finishes, dispatches triage B (which queues behind A in the per-stage group `shopfloor-triage-<N>`). Runner 2 is released.
4. **t=12s** — route C acquires runner 2 and starts.
5. **t=40s** — triage A's post-precheck step writes `shopfloor:triaging` as its mutex marker (§5.4).
6. **Route C's routing call happens somewhere between t=12s and whenever route C finishes.** If that is before t=40s, route C sees empty labels under either payload-snapshot or live-re-fetch. If it is after t=40s:
   - **Payload-snapshot:** route C reads `payload.issue.labels`, which is the state as of event C's webhook emission time (pre-triage). Empty. Resolves `stage=triage`. Dispatches triage C. Triage C queues in the per-stage group behind triage B. When triage C eventually dequeues, its Layer 3 precheck sees the advanced state and emits `skip=true`, and the job exits without doing any real work. Cost: **two runner acquisitions** (one for route C, one for the no-op triage C).
   - **Live re-fetch:** route C reads labels from the API. Sees `shopfloor:triaging` present. `hasStateLabel` is true. State machine resolves `stage=none`. No triage C dispatch. Cost: **one runner acquisition** (only route C itself).

Under a 1-runner pool the scheduling shifts (routes never run in parallel; each route waits for the previous job to release the runner) but the shape is the same: later routes observe progressively more state, and live re-fetch lets them bail out at the route stage before dispatching wasted stage jobs.

Under limited capacity, the savings compound across bursts. A 10-event burst post-triage under a 2-runner pool costs 10 route acquisitions regardless, but Layer 2 drops the associated no-op stage dispatches from 10 to 0, halving the total runner load for the burst.

#### 5.2.3 Relationship to Layer 3

Layer 2 does not replace Layer 3. Two routes can STILL run in true parallel on two different runners if capacity allows, each sees the same pre-write state, both dispatch stage jobs, both queue in the per-stage group. The second job's Layer 3 precheck at job-start is the only check that runs AFTER the concurrency queue has serialized the jobs, and it is the only layer that can observe writes from a prior group-mate. Layer 3 is the correctness guarantee; Layer 2 is the cost saving on top.

### 5.3 Layer 3 — `precheck-stage` helper (correctness)

New router helper. Takes `stage` and `issue_number` inputs. Fetches the issue via `adapter.getIssue(issue_number)` and checks the stage-specific precondition. Emits:

- `skip`: `'true'` | `'false'`
- `reason`: short human-readable string for the workflow notice

#### 5.3.1 Preconditions per stage

| Stage               | Precondition                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`            | No state label from `{shopfloor:quick, shopfloor:medium, shopfloor:large, shopfloor:needs-spec, shopfloor:needs-plan, shopfloor:needs-impl, shopfloor:impl-in-review, shopfloor:needs-review, shopfloor:review-requested-changes, shopfloor:review-approved, shopfloor:review-stuck, shopfloor:done}` present. `shopfloor:triaging` and `shopfloor:awaiting-info` are permitted (they mean "triage is in progress" or "paused"). |
| `spec`              | `shopfloor:needs-spec` present AND no `shopfloor:spec-running` marker label present.                                                                                                                                                                                                                                                                                                                                             |
| `plan`              | `shopfloor:needs-plan` present AND no `shopfloor:plan-running` marker label present.                                                                                                                                                                                                                                                                                                                                             |
| `implement`         | `shopfloor:needs-impl` OR `shopfloor:review-requested-changes` present AND no `shopfloor:implementing` marker label present. (Revision runs enter via review-requested-changes.)                                                                                                                                                                                                                                                 |
| `review-aggregator` | `shopfloor:needs-review` present AND the impl PR's head SHA matches the SHA the matrix analyzed (passed in via an existing input). Separate concern from marker labels.                                                                                                                                                                                                                                                          |
| `handle-merge`      | The merged-stage's expected next-label transition has not already been applied. E.g., for a merged spec PR, skip if `shopfloor:needs-plan` is already present.                                                                                                                                                                                                                                                                   |

#### 5.3.2 Fail policy

Fail closed on definitive "preconditions not met" reads — precondition demonstrably does not hold, skip. Fail open (pass through) only on transient API errors — could not read labels, let the job proceed and rely on in-helper assertions (§5.3.3) as a second line of defence.

This is the opposite of my first instinct. The reason: GitHub occasionally redelivers webhooks. Under a naive fail-open policy, a redelivered `labeled(needs-impl)` event would route to `implement`, enter the queue, dequeue, precheck sees `needs-impl` still present (it is — implement hasn't started yet), passes, and a second implement agent starts on top of the first. Fail-closed on definitive reads prevents this without losing correctness: the only way precheck sees "label no longer present" is if a real subsequent mutation removed it, in which case skipping is correct.

#### 5.3.3 In-helper precondition assertions (belt-and-suspenders)

Add defensive assertions at the top of the mutating helpers that do label flips:

- `apply-triage-decision`: assert no state label other than `shopfloor:triaging`/`shopfloor:awaiting-info` is present. If it is, fail the job loudly with the offending label in the error message.
- `apply-impl-postwork`: assert `shopfloor:implementing` is present. If not, fail loudly.
- `advance-state`: already takes `from_labels` and `to_labels`; add a pre-check that `from_labels` are present before removing.
- `aggregate-review`: assert the impl PR head SHA matches the analysed SHA; else exit as no-op.
- `handle-merge`: assert the transition has not already been applied.

These are the last line of defence. If precheck passes but state changes between precheck and the helper call (microseconds), the helper still refuses to mutate incorrect state.

### 5.4 Layer 4 — Transient marker labels (correctness)

Three new transient labels used as mutexes for long-running stages:

- `shopfloor:spec-running`
- `shopfloor:plan-running`
- `shopfloor:implementing`

Added by each stage's early helper (immediately after precheck passes and before the agent runs). Removed by the stage's terminal helper (`apply-impl-postwork`, `open-stage-pr` for spec/plan, etc.) after labels are flipped. These labels are registered in `bootstrap-labels` alongside the existing Shopfloor label set.

#### 5.4.1 Why this layer is needed in addition to precheck

Layer 3 alone is not sufficient when two queued advancement events could both legitimately pass precheck before either writes its advancement labels. Concrete sequence: event A and event B both route to `implement`. Implement A acquires the per-stage group, its precheck reads `shopfloor:needs-impl` present, passes. Implement A runs the agent (minutes). While the agent is running, implement B... wait — per-stage concurrency serializes them, so implement B is still queued. This particular scenario is blocked by Layer 1.

Where Layer 4 matters: a redelivered webhook. GitHub occasionally redelivers the same `labeled(needs-impl)` event. Both route jobs dispatch implement. Implement A acquires the group, runs to completion, removes `shopfloor:needs-impl` / flips to `impl-in-review`. Implement B dequeues. Precheck B fetches labels, sees `impl-in-review` (not `needs-impl`), emits `skip=true`. Correct.

BUT if the helper that transitions `needs-impl → impl-in-review` fails mid-transition (say, it removed `needs-impl` but crashed before adding `impl-in-review`), precheck B would see neither label present and would be ambiguous. The `shopfloor:implementing` marker — added by implement A at its start and explicitly cleaned up by `apply-impl-postwork` — is the unambiguous signal that "a run is in progress or crashed mid-transition". Precheck B sees the marker and emits `skip=true` with `reason=stage_already_in_progress`.

#### 5.4.2 Why not reuse `shopfloor:triaging`?

`shopfloor:triaging` is already a stable state-label meaning "triage is the issue's current state" (versus `shopfloor:needs-spec`, `shopfloor:done`, etc.). Overloading it as a short-lived mutex would muddy that semantic. The `-running` / `implementing` suffix makes the mutex intent explicit and keeps the state-label set clean.

#### 5.4.3 Why not a lock file or check run?

Labels are strongly consistent with read-your-writes on the GitHub API, which is the property we need. Check runs would also work but add an API surface we do not use elsewhere. Lock files in the repo would require a commit, which is expensive and fires its own events.

#### 5.4.4 Stuck-marker recovery

A crashed runner could leave an orphaned marker label (`shopfloor:implementing` with no running job). Recovery: a human removes the label manually. Documented in the troubleshooting runbook (§9). A future improvement could add a TTL via a timestamp in the label description, but labels do not support descriptions per-issue, so this would require a separate issue comment or artifact. Out of scope for v0.1 of the fix.

### 5.5 Plumbing — Job-level `if:` guards on every subsequent step

The precheck step outputs `skip`. Every subsequent step in the job must be gated on `if: steps.precheck.outputs.skip != 'true'`. Missing one leaves a mutation live. Tedious, but there is no early-exit-cleanly primitive in GitHub Actions, so this is unavoidable. Not a conceptual layer — just the mechanical wiring needed to make Layer 3 effective. Treat it as a lint concern, not a design concern.

## 6. State machine changes

### 6.1 `resolvePullRequestEvent` populates `issueNumber` on merge

```ts
if (payload.action === "closed" && pr.merged) {
  return {
    stage: "none",
    issueNumber: meta.issueNumber,
    reason: `pr_merged_${meta.stage}_triggered_label_flip`,
  };
}
```

Required so that `handle-merge`'s concurrency group name resolves correctly. Independent bug that was masked by workflow-level concurrency.

### 6.2 `StateContext` gains `liveLabels?: string[]`

```ts
export interface StateContext {
  eventName: string;
  payload: EventPayload;
  shopfloorBotLogin?: string;
  triggerLabel?: string;
  liveLabels?: string[]; // NEW
}
```

`resolveIssueEvent` uses `ctx.liveLabels ?? payload.issue.labels.map(l => l.name)` as its label source. Tests that already build payloads with labels keep working; the router helper at runtime passes `liveLabels` from an API fetch.

### 6.3 New label set entries

Add to `STATE_LABELS` in `state.ts`:

- `shopfloor:spec-running`
- `shopfloor:plan-running`
- `shopfloor:implementing`

These are treated as "not an advancement label" and do not trigger routing on their own. They exist purely as mutex markers. They are registered in `bootstrap-labels.ts`.

### 6.4 No changes to `resolveStage`'s control flow

The state machine's decision graph stays the same. All changes are additive: a new `liveLabels` input, a new PR merge `issueNumber` field, three new label strings.

## 7. Walkthroughs

### 7.1 The original bug (dropped advancement event)

**Events:** `issue_comment.created`, `labeled(shopfloor:quick)`, `labeled(shopfloor:needs-impl)` in rapid succession after triage finishes.

**Under the fix:**

1. `issue_comment.created` → `route` runs un-grouped → `resolveStage` returns `stage=none` → exits. No group acquired.
2. `labeled(shopfloor:quick)` → `route` runs un-grouped → `computeStageFromLabels` checks if `shopfloor:quick` is in `ADVANCEMENT_STATE_LABELS`. It is not. Returns `stage=none`. Exits. No group acquired.
3. `labeled(shopfloor:needs-impl)` → `route` runs un-grouped → `ADVANCEMENT_STATE_LABELS.has('shopfloor:needs-impl')` is true → derives `stage=implement` → `implement` job starts and enters `shopfloor-implement-<N>` alone.

Advancement fires. No preemption possible because events 1 and 2 never touched the group.

### 7.2 Two triggers both resolve `stage=triage`

**Events:** `issues.opened` for new issue with trigger label already set fires both `opened` and `labeled(trigger_label)` near-simultaneously. (Or any two events that both resolve to triage.)

**Under the fix:**

1. Both route jobs run in parallel, un-grouped. Both call the API and read an empty label set. Both resolve `stage=triage`.
2. `triage` job A acquires `shopfloor-triage-<N>`, starts. Triage job B queues behind A.
3. Triage A: precheck step runs, API call shows no state label. Precondition holds. Skip=false.
4. Triage A: `create-progress-comment` helper adds `shopfloor:triaging`. Progress comment created.
5. Triage A: runs claude-code-action triage agent.
6. Triage A: `apply-triage-decision` runs the in-helper assertion (§5.3.3), then flips labels: removes `shopfloor:triaging`, adds complexity label, adds advancement label.
7. Triage A completes. Group released.
8. Triage B starts. Precheck step runs, API call returns labels including `shopfloor:quick` and `shopfloor:needs-impl`. Precondition `no state label present` fails. Emits `skip=true reason=triage_already_completed_by_prior_run`.
9. All subsequent steps in Triage B have `if: steps.precheck.outputs.skip != 'true'`. They no-op. Job exits cleanly with a workflow notice.

No wasted agent run. No duplicate labels. No duplicate comments.

### 7.3 Duplicate webhook redelivery

**Events:** GitHub redelivers a single `labeled(shopfloor:needs-impl)` event (~once in N thousand events, but it happens).

**Under the fix:**

1. Route A runs, fetches live labels, sees `needs-impl`, resolves `implement`. `implement` job A queues.
2. Route B (redelivered event) runs, fetches live labels, still sees `needs-impl`, resolves `implement`. `implement` job B queues.
3. Job A enters `shopfloor-implement-<N>`, starts. Job B queues.
4. Job A: precheck sees `needs-impl` still present, no `shopfloor:implementing` marker yet. Passes.
5. Job A: first thing after precheck is to add `shopfloor:implementing`. Creates the progress comment. Runs agent. At the very end, `apply-impl-postwork` removes `shopfloor:implementing` and advances state to `shopfloor:impl-in-review`.
6. Job A completes. Group released.
7. Job B starts. Precheck sees `shopfloor:impl-in-review` present (not `needs-impl`), and no `shopfloor:implementing` marker (A just removed it). Precondition for fresh `implement` fails. Emits `skip=true reason=already_advanced_past_needs-impl`.
8. Job B exits cleanly.

### 7.4 `handle-merge` races with `implement` revision

**Events:** Reviewer posts `REQUEST_CHANGES` (queues revision `implement`). Human force-merges the impl PR before the revision starts.

**Under the fix:**

1. Review aggregator's own run posted the review, added `shopfloor:review-requested-changes`, released its group. Implement revision's route job resolves `stage=implement` and queues in `shopfloor-implement-<N>`.
2. Concurrently, the force-merge fires `pull_request.closed merged=true`. Route job runs, returns `stage=none issueNumber=<N>`, and the `handle-merge` job is dispatched.
3. `handle-merge` tries to enter `shopfloor-implement-<N>` (shared group per §5.1.2). Whichever was enqueued first wins.
4. If `handle-merge` acquires first: runs, flips `impl-in-review → done`, closes the issue, releases the group. The queued `implement` revision now dequeues, precheck sees `shopfloor:done` (or equivalent terminal label), emits skip=true, exits.
5. If the `implement` revision acquires first: runs (possibly unnecessarily, since the PR is merged), finishes, releases the group. `handle-merge` dequeues, runs, applies its transitions. The implementation run's work on a merged branch is wasted but not harmful.

Case 5 is suboptimal but not a correctness issue; the `implement` helper can additionally check "is the PR still open?" at its start and exit early if not.

## 8. Component changes

### 8.1 New files

- `router/src/helpers/precheck-stage.ts` — the new helper. Exports `runPrecheckStage(adapter)` and a pure `precheckStage(params)` for testing.
- `router/test/helpers/precheck-stage.test.ts` — unit tests covering every stage's precondition, fail-closed path, fail-open-on-transient-error path, and live-vs-stale label scenarios.

### 8.2 Modified files

- `router/src/state.ts`:
  - `resolvePullRequestEvent` populates `issueNumber` on merge.
  - Add `shopfloor:spec-running`, `shopfloor:plan-running`, `shopfloor:implementing` to `STATE_LABELS`. (They do not advance anything, they just block re-entry.)
- `router/src/types.ts`:
  - `StateContext.liveLabels?: string[]`.
- `router/src/index.ts`:
  - `route` case fetches live labels from the API before calling `resolveStage`.
  - Register the new `precheck-stage` helper.
- `router/src/helpers/bootstrap-labels.ts`:
  - Register the three new `-running` / `implementing` marker labels.
- `router/src/helpers/apply-triage-decision.ts`:
  - Assert no unexpected state label is already present (§5.3.3).
- `router/src/helpers/advance-state.ts`:
  - Assert `from_labels` are present before removing.
- `router/src/helpers/apply-impl-postwork.ts`:
  - Assert `shopfloor:implementing` is present. Remove it as part of the transition.
- `router/src/helpers/aggregate-review.ts`:
  - Assert the PR head SHA matches the analysed SHA; exit no-op if not.
- `router/src/helpers/handle-merge.ts`:
  - Assert the merged-stage transition has not already been applied.
- `router/action.yml`:
  - Declare the `stage` input for `precheck-stage`.
- `.github/workflows/shopfloor.yml`:
  - Remove workflow-level `concurrency:`.
  - Add per-job `concurrency:` to `triage`, `spec`, `plan`, `implement`, `review-aggregator`, `handle-merge`, wired with the correct group names (§5.1).
  - Add a precheck step at the top of each mutating job (after checkout + mint) and gate every subsequent step on `if: steps.precheck.outputs.skip != 'true'`.
  - Add a step in `triage` that creates `shopfloor:triaging` right after precheck passes (the existing create-progress-comment step is a good home for this).
  - Add steps in `spec`, `plan`, `implement` that add the `-running` / `implementing` marker after precheck passes.

### 8.3 Test changes

- `router/test/state.test.ts`:
  - New test for `resolvePullRequestEvent` returning `issueNumber` on merge.
  - New tests for `liveLabels` taking precedence over payload labels.
- `router/test/helpers/precheck-stage.test.ts` (new):
  - Every precondition case, fail-closed and fail-open-on-error paths.
- `router/test/helpers/apply-triage-decision.test.ts`:
  - New "unexpected state label already present" assertion.
- `router/test/helpers/apply-impl-postwork.test.ts`:
  - New "`shopfloor:implementing` missing" assertion; new "implementing is removed as part of advance" check.
- `router/test/helpers/handle-merge.test.ts`:
  - New "transition already applied" idempotency test.

No fixture churn — the existing event fixtures are still valid; the new tests just add to them.

## 9. Edge cases and gotchas

1. **Missing `if:` guard on a step leaks a mutation.** Every step after the precheck must be guarded. Easy to miss when adding new steps in the future. Mitigation: add a lint (grep) in CI that flags any step without the precheck guard inside a gated job. Future work.
2. **Transient label creates a visible UI artifact.** `shopfloor:implementing` will briefly appear on the issue while the impl agent runs. Users may be confused. Mitigation: documentation + label description copy that explains "transient marker, removed when stage completes".
3. **bootstrap-labels runs on every un-grouped route.** Still idempotent (label creation is create-or-ignore). Pin that assumption in a code comment so future edits do not break it.
4. **Retry-from-failure path under per-stage concurrency.** A human removes `shopfloor:failed:implement`, firing `unlabeled`. Route resolves `stage=implement reason=retry_...`. An in-flight implement might exist (unusual — report-failure normally runs after the agent finishes, but a worker crash could leave stale state). Per-stage concurrency serializes them; precheck catches the stale one if any.
5. **Review matrix across iterations.** The four matrix cells are un-grouped by design (§5.1). Iteration N+1's matrix can start while iteration N's `review-aggregator` is still holding the implement group. That is fine: iteration N+1's matrix runs analysis but the aggregator for N+1 queues behind N's aggregator in the shared group. By the time N+1's aggregator dequeues, N has finished its label flips, and N+1's precheck sees the advanced state and decides correctly.
6. **Head-SHA checking for the aggregator.** The PR head SHA can change between matrix start and aggregator run (e.g., a fast push). Aggregator's in-helper assertion catches this and exits no-op. Existing design partially handles this via `getPr(prNumber).head.sha`; confirm and harden.
7. **2am runbook.** When the pipeline stalls despite the fix, the human recovery path is: identify the expected next label, `gh label remove` it, `gh label add` it. The advancement event re-fires, the queue is empty, the job runs cleanly. Document this in `docs/shopfloor/troubleshooting.md`.
8. **The `shopfloor:triaging` semantic overlap.** The label is both a state label (meaning "triage is in progress for this issue") and the mutex marker (meaning "another triage job is running right now"). In practice these are the same, but a future state machine change that introduces a "pre-triage" phase would blur them. Flag for re-review in any future state machine refactor.

## 10. Testing strategy

- **Unit tests** cover all state-machine changes (live labels, merge issueNumber population), every precheck-stage precondition, every in-helper assertion. 20-30 new tests, all synchronous, run under vitest in the existing test harness. No new fixtures required beyond minor label-set additions.
- **Integration-ish tests** (`router/test/helpers/*.test.ts`) exercise each modified helper via the existing mock adapter.
- **No E2E tests** in this spec. The concurrency behaviour is a property of GitHub Actions, not of Shopfloor's code, and cannot be meaningfully unit-tested. The dogfood pipeline is the E2E signal. Closing §2.1's failure mode on a live dogfood run is the acceptance criterion.

## 11. Rollout

1. Implement and land the router changes on main. Dogfood run will exercise them on the next issue.
2. Monitor the next few dogfood runs for any precheck-skip notices. Expected on genuine duplicate-event scenarios; unexpected on first-run-after-triage (which would indicate a bug in precheck).
3. If precheck skips happen on first-runs, fail-closed is over-eager. Tighten the precondition and ship a patch.
4. Roll out to external consumers only after at least two clean dogfood cycles and at least one observed duplicate-event skip that is definitively correct.

## 12. Out of scope / follow-ups

- **Cross-issue serialization.** Not addressed. If two issues share a file (e.g., two quick-fixes to the same module), their impl agents can race at the git push level. Existing `git push --force` ensures one wins; the loser's commits are silently discarded. Worth tracking but out of scope for this fix.
- **Richer lock semantics.** A real lease (TTL + heartbeat) would survive a crashed runner. Labels do not. If a runner crashes mid-stage, the mutex label is orphaned and blocks retries. Today, a human recovery step can delete the label. Adequate for v0.1.
- **Webhook de-duplication at the event level.** GitHub has no "I already processed this delivery ID" primitive we can use. An issue comment marker or a workflow artefact could track processed delivery IDs, but that is heavier than the label mutex and not required for correctness.
- **Label rate limits.** The GitHub API has label mutation rate limits. Under sustained Shopfloor load on a repository with many concurrent issues, the additional label flips (marker add + remove per stage) might bump into the limit. Unlikely in practice; note for future monitoring.

## 13. Planned commits

Conventional commits, in the order they should land. Each commit is independently green under `pnpm test` and `pnpm exec tsc --noEmit`.

1. `fix(state): populate issueNumber on PR merge events` — the §4.4 bug. State.ts change plus one new test.
2. `feat(state): support live-label override in StateContext` — the `liveLabels` field, `resolveIssueEvent` plumbing, tests.
3. `feat(router): route helper fetches live labels from the API` — the index.ts change, adapter call, tests via the mock adapter.
4. `feat(labels): add transient stage-running marker labels` — bootstrap-labels registration, STATE_LABELS additions, tests.
5. `feat(router): add precheck-stage helper` — new helper, tests for every precondition and failure mode.
6. `feat(helpers): add in-helper precondition assertions` — modifications to apply-triage-decision, advance-state, apply-impl-postwork, aggregate-review, handle-merge, tests.
7. `feat(workflow): per-stage concurrency groups and precheck wiring` — the shopfloor.yml surgery. Removes workflow-level concurrency, adds per-job concurrency, wires precheck step into every mutating job, gates every subsequent step on precheck output, wires marker-label creation.
8. `docs(spec): close the concurrency-fix spec` — move this spec from Draft to Accepted, link the commits above.
9. `docs(troubleshooting): runbook for stalled pipeline recovery` — the §9 gotcha as a manual recovery step in `docs/shopfloor/troubleshooting.md`.

## 14. Open questions

- **Should the review matrix cells also be grouped?** §5.1 leaves them un-grouped for maximum parallelism. The cost is occasional duplicate analyses of the same HEAD across iterations. Benefit: no dropping of mid-iteration findings. The aggregator's shared-group placement (§5.1.1) already serializes the visible review output, so matrix-cell grouping buys only compute savings, not correctness. Recommend leaving un-grouped and revisiting if compute cost becomes material.
- **Should `precheck-stage` also handle the revision-mode `implement` case explicitly?** Revision entry is via `shopfloor:review-requested-changes`, which is a different precondition than fresh entry via `shopfloor:needs-impl`. The helper needs a `mode` input or needs to accept both labels as valid preconditions. Leaning toward "accept either label and let the implement job decide revision vs fresh via existing logic".
- **Do we need a workflow-artifact trail of every skip decision?** Workflow notices are visible in the Actions UI but disappear with log retention. A single line per skip in a JSON file attached as an artifact would be searchable. Probably overkill for v0.1.

## 15. Approval

This spec supersedes nothing and is additive to `2026-04-14-shopfloor-design.md`. It does not require re-approval of the original design. Merge after review; the implementation plan is tracked in `docs/superpowers/plans/2026-04-15-shopfloor-concurrency-fix-implementation.md` (to be written after this spec is approved).
