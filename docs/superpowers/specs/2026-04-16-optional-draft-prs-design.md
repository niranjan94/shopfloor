# Optional draft PRs with `shopfloor:wip` label gate

**Status:** Draft
**Date:** 2026-04-16

## 1. Overview

Shopfloor opens implementation PRs as drafts and un-drafts them after the agent finishes. The draft/undraft cycle serves two purposes:

1. **Cosmetic** -- signals to humans that work is in progress.
2. **Functional** -- suppresses review triggers. The state machine returns `stage: "none"` for `synchronize` events on draft PRs (`state.ts:402`), so mid-run pushes never fan out into the review matrix. The `ready_for_review` event fired by `gh pr ready` is the sole mechanism that promotes the first-iteration impl run into review.

Some consumers cannot or do not want to use draft PRs (organizational policies, tooling that ignores drafts, notification preferences). This spec introduces a `use_draft_prs` workflow input (default `true`) and replaces the draft/undraft dance with a `shopfloor:wip` label when disabled. The label is added to the impl PR at the start of both first and revision runs and removed after the agent finishes, serving both the cosmetic ("this PR is being actively worked on") and functional (review suppression) roles that draft status currently fills.

## 2. Problem statement

### 2.1 The constraint

GitHub's draft PR mechanism is the only review-suppression gate in the current implementation. Consumers who disable drafts lose both the cosmetic signal and the functional gate. Without an alternative, every mid-agent push fires `synchronize` on a non-draft PR, which the state machine routes to `stage: "review"`, fanning out the review matrix against incomplete work.

### 2.2 Why a label and not just tolerating spurious reviews

The `precheck-stage` helper and `already_reviewed_at_sha` guard can handle idempotency, so spurious review-matrix runs are harmless in terms of correctness. But they waste Actions minutes, clutter the run history, and -- for repos with slow review models -- can cause genuine contention if a review matrix starts against half-written code and finishes after the agent is done, posting stale feedback. A label gate prevents these runs from dispatching at all.

### 2.3 What is already working

- `open-stage-pr` already accepts a `draft` boolean and passes it through to `GitHubAdapter.openStagePr`. No changes needed there.
- `GitHubAdapter.addLabel` and `removeLabel` take an issue/PR number and work on PRs (GitHub's Issues API handles both). No new adapter methods needed for label manipulation.
- The dogfood caller already subscribes to `pull_request: types: [unlabeled]` (see `dogfood.yml:8`). Callers that want the WIP gate and already subscribe to `unlabeled` need no event subscription changes.
- `PullRequestPayload` already has `labels: Array<{ name: string }>` on the `pull_request` object, so the state machine can read PR labels without an extra API call.
- The `prLabelSet` helper (`state.ts:67`) already extracts labels into a `Set<string>`.
- Spec/plan PRs are never opened as drafts today. This feature only affects the implement stage.

## 3. Goals and non-goals

### Goals

- **Opt-out from draft PRs.** A consumer sets `use_draft_prs: false` and impl PRs open as regular (non-draft) PRs.
- **Review suppression via label.** When drafts are disabled, `shopfloor:wip` on the impl PR suppresses review triggers during agent work, equivalent to the draft gate.
- **Cosmetic WIP signal on both run types.** The label is added at the start of first runs and revision runs, and removed at the end, so humans always see when work is in progress.
- **Symmetric first-run and revision-run flow.** Both run types follow the same add-label / agent-work / push / remove-label sequence. The label removal is the event that triggers review on first runs; on revision runs, `synchronize` from the push also reaches the state machine (the label is removed before or concurrently), but the `unlabeled` event provides the canonical trigger.
- **No behavior change when `use_draft_prs` is true (the default).** The existing draft/undraft flow is preserved exactly. Zero risk to existing consumers.
- **Caller documentation.** Callers who set `use_draft_prs: false` must subscribe to `pull_request: types: [unlabeled]` in their caller workflow. The install docs and the input description make this explicit.

### Non-goals

- Applying `shopfloor:wip` to spec or plan PRs. Those are never opened as drafts today and this spec does not change that.
- Making the label name configurable. `shopfloor:wip` is the canonical name, bootstrapped alongside all other Shopfloor labels.
- Removing the draft PR code path. Both modes coexist permanently. Draft is the default and recommended path.
- Changing how the review matrix, aggregate-review, or iteration cap work.

## 4. Architecture

### 4.1 New workflow input

```yaml
use_draft_prs:
  type: boolean
  default: true
  description: >-
    When true (default), implementation PRs are opened as drafts and
    un-drafted when the agent finishes. When false, a shopfloor:wip label
    is used instead. Callers that set this to false MUST include
    'unlabeled' in their pull_request event types.
```

### 4.2 `shopfloor:wip` label definition

Add to `bootstrap-labels.ts` LABEL_DEFS:

```typescript
{
  name: "shopfloor:wip",
  color: "fbca04",
  description:
    "Implementation in progress. Suppresses review triggers until removed.",
}
```

Color `fbca04` (yellow) matches the existing transient markers (`shopfloor:triaging`, `shopfloor:implementing`, etc.), signaling "active work, will be removed automatically."

### 4.3 `ShopfloorLabel` type

Add `"shopfloor:wip"` to the `ShopfloorLabel` union in `types.ts`.

### 4.4 `PullRequestPayload` type

Add an optional `label` field to support `unlabeled` events:

```typescript
export interface PullRequestPayload {
  action: string;
  label?: { name: string }; // present on labeled/unlabeled actions
  pull_request: {
    // ... existing fields unchanged
  };
  repository: { owner: { login: string }; name: string };
}
```

GitHub includes `label` at the top level of `labeled` and `unlabeled` PR event payloads, same as it does for issue events. The field is optional because other PR actions (`synchronize`, `closed`, etc.) do not carry it.

### 4.5 State machine changes (`state.ts`)

#### 4.5.1 WIP label gate on `synchronize` / `ready_for_review`

The existing handler at `state.ts:393` checks `pr.draft` to suppress review triggers. Add a parallel check for `shopfloor:wip`:

```typescript
if (
  (payload.action === "synchronize" || payload.action === "ready_for_review") &&
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
```

The `labels` variable is already computed (moved up from its current position after the `skip-review` check). The `shopfloor:wip` check sits between the draft check and the closed check, matching the priority order: skip-review > draft > wip > closed.

#### 4.5.2 New handler for `unlabeled` on impl PRs

When `shopfloor:wip` is removed from an impl PR, the state machine should route to review -- this is the non-draft equivalent of `ready_for_review`:

```typescript
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
```

This block sits alongside the existing `synchronize`/`ready_for_review` block. The draft check is retained as a safety valve: if someone manually puts a WIP label on a draft PR and removes it, the draft gate still holds.

Non-WIP `unlabeled` events (removing any other label from an impl PR) fall through to the existing catch-all at the bottom of `resolvePullRequestEvent` and return `stage: "none"`.

### 4.6 `check-review-skip.ts` changes

Add a WIP label check after the draft check at line 21:

```typescript
if (pr.draft) return { skip: true, reason: "pr_draft" };
if (pr.labels.some((l) => l.name === "shopfloor:wip")) {
  return { skip: true, reason: "pr_wip_label" };
}
```

This is a defense-in-depth measure. The state machine's WIP gate should prevent review dispatch entirely, but if a race condition or manual trigger gets through, `check-review-skip` is the second gate.

### 4.7 Workflow changes (`.github/workflows/shopfloor.yml`)

#### 4.7.1 Route job: forward `use_draft_prs`

The `use_draft_prs` input needs to reach the implement job. Add it as a route job output (passthrough):

```yaml
outputs:
  # ... existing outputs ...
  use_draft_prs: ${{ inputs.use_draft_prs }}
```

Alternatively, since it is a static workflow input (not computed), the implement job can reference `inputs.use_draft_prs` directly via `${{ inputs.use_draft_prs }}`. Prefer whichever the existing pattern uses for other inputs like `trigger_label`. The implement job already references `inputs.impl_model`, `inputs.impl_timeout_minutes`, etc. directly, so direct reference is the established pattern. No route-job output needed.

#### 4.7.2 Implement job: conditional draft vs. WIP on first run

The `open_pr` step (line 807) currently passes `draft: "true"`. Change to:

```yaml
draft: ${{ inputs.use_draft_prs && 'true' || 'false' }}
```

Add a new step after `open_pr` (first run only, WIP mode only):

```yaml
- name: Add WIP label to impl PR
  if: >-
    steps.precheck.outputs.skip != 'true'
    && needs.route.outputs.revision_mode != 'true'
    && !inputs.use_draft_prs
  env:
    GH_TOKEN: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
    PR_NUMBER: ${{ steps.open_pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --add-label "shopfloor:wip"
```

#### 4.7.3 Implement job: WIP label on revision runs

Revision runs need the WIP label for cosmetic purposes and to suppress any `synchronize` events from the push. Add a step after the "Resolve unified impl PR number" step, gated on revision mode and WIP mode:

```yaml
- name: Add WIP label to impl PR (revision)
  if: >-
    steps.precheck.outputs.skip != 'true'
    && needs.route.outputs.revision_mode == 'true'
    && !inputs.use_draft_prs
  env:
    GH_TOKEN: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --add-label "shopfloor:wip"
```

Note: adding the `shopfloor:wip` label fires `pull_request.labeled` on the impl PR. The state machine has no handler for `labeled` on PRs, so this event reaches the catch-all and returns `stage: "none"`. Harmless but fires a wasted workflow run. This is an acceptable cost -- the alternative (suppressing labeled events) would require filtering in the caller, which is fragile.

#### 4.7.4 Implement job: conditional undraft vs. WIP removal

The "Mark impl PR ready for review" step (line 1061) currently runs `gh pr ready`. Make it conditional and add a parallel WIP-removal step:

```yaml
- name: Mark impl PR ready for review
  if: >-
    success()
    && steps.app_token_post.outputs.token != ''
    && steps.precheck.outputs.skip != 'true'
    && needs.route.outputs.revision_mode != 'true'
    && inputs.use_draft_prs
  env:
    GH_TOKEN: ${{ steps.app_token_post.outputs.token }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr ready "$PR_NUMBER" --repo "$REPO_SLUG"

- name: Remove WIP label from impl PR
  if: >-
    success()
    && steps.app_token_post.outputs.token != ''
    && steps.precheck.outputs.skip != 'true'
    && !inputs.use_draft_prs
  env:
    GH_TOKEN: ${{ steps.app_token_post.outputs.token }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --remove-label "shopfloor:wip"
```

The WIP removal step runs on both first and revision runs (no `revision_mode` gate). The first run needs it to trigger review via `unlabeled`. Revision runs need it to clear the cosmetic signal and to fire `unlabeled` as the review trigger (consistent with first runs).

Critical: the WIP removal step must use the App token (not `GITHUB_TOKEN`), same as the existing `gh pr ready` step. Events caused by `GITHUB_TOKEN` are suppressed by GitHub and would never trigger the downstream review workflow.

#### 4.7.5 Ordering: push before WIP removal

The existing flow is: push commits, then `gh pr ready`. The WIP flow must follow the same order: push commits, then remove `shopfloor:wip`. This ensures the `synchronize` event from the push is suppressed by the WIP label (still present at push time), and the `unlabeled` event from label removal is the canonical review trigger.

If the order were reversed (remove label, then push), the `synchronize` from the push would also route to review (no WIP label, no draft), causing a double review trigger. The `unlabeled` and `synchronize` events would race and potentially dispatch two concurrent review matrices.

The current step ordering in the workflow already has push before undraft, so no reordering is needed -- just slot the WIP removal step in the same position as the existing undraft step.

### 4.8 Interaction with revision runs (detailed)

Walking through a complete revision run with WIP mode:

1. Review matrix posts `REQUEST_CHANGES`. `aggregate-review` adds `shopfloor:review-requested-changes` to the issue.
2. `pull_request_review.submitted` fires. State machine returns `stage: "implement"`, `revisionMode: true`.
3. Implement job starts. Precheck passes (issue has `shopfloor:review-requested-changes`).
4. `shopfloor:implementing` added to issue. `shopfloor:wip` added to PR.
   - The `labeled` event on the PR fires a workflow run. State machine sees `labeled` on an impl PR with no specific handler, returns `stage: "none"`. Wasted run, harmless.
5. Existing impl branch checked out. No new PR opened.
6. Agent runs, makes commits locally.
7. `git push` pushes commits. `synchronize` fires.
   - State machine sees `synchronize` on impl PR. PR has `shopfloor:wip` label. Returns `stage: "none", reason: "pr_has_wip_label"`. Review suppressed.
8. `shopfloor:wip` removed from PR. `unlabeled` fires.
   - State machine sees `unlabeled` with `label.name === "shopfloor:wip"` on impl PR. No draft, no skip-review, not closed. Returns `stage: "review"`. Review matrix dispatches.
9. `apply-impl-postwork` runs. Updates PR title/body. Adds `shopfloor:needs-review` to issue. Removes `shopfloor:implementing` and `shopfloor:review-requested-changes`.
10. Review matrix runs, either approves or requests changes again. Loop continues.

### 4.9 Edge cases

#### 4.9.1 Manual WIP label manipulation

A human manually adds or removes `shopfloor:wip` on an impl PR. The state machine handles this gracefully:

- **Manual add**: next `synchronize` is suppressed. The label must be manually removed to resume review triggers. This is safe -- it is equivalent to converting a PR to draft.
- **Manual remove during agent run**: the next `synchronize` from the post-agent push will route to review, which is premature but caught by `check-review-skip`'s `already_reviewed_at_sha` guard on subsequent iterations.
- **Manual remove when no agent is running**: fires `unlabeled`, state machine routes to review. If the impl hasn't been pushed yet, `precheck-stage` or `check-review-skip` will bail. Harmless.

#### 4.9.2 Mixed mode (draft + WIP label)

If someone manually adds `shopfloor:wip` to a draft PR, both gates are active. The draft gate fires first in the state machine. Removing the WIP label while the PR is still a draft does nothing (the `unlabeled` handler checks `pr.draft` and returns `none`). This is correct -- the draft gate is authoritative when draft mode is active.

#### 4.9.3 Caller forgets to subscribe to `unlabeled`

If a caller sets `use_draft_prs: false` but does not include `unlabeled` in their `pull_request` event types, the `unlabeled` event from WIP removal never reaches the workflow. The `synchronize` event from the push was already suppressed by the WIP label. Result: the review pipeline never starts. The impl PR sits with `shopfloor:needs-review` on the issue but no review matrix run.

Mitigation: the `use_draft_prs` input description warns about this. Additionally, a startup warning step can be added to the route job that checks `github.event.action` patterns over time, but this is not worth the complexity for v1. The install docs are the primary safeguard.

#### 4.9.4 WIP label removal fails

If `gh pr edit --remove-label` fails (token expired, rate limit, network), the step fails, the job fails, `report-failure` runs, and `shopfloor:failed:implement` is added to the issue. The WIP label remains on the PR. A human must remove it manually after fixing the failure. Same failure mode as a failed `gh pr ready` today.

#### 4.9.5 Label added by `GITHUB_TOKEN` instead of App token

The "Add WIP label" step can use either the App token or `GITHUB_TOKEN` -- the `labeled` event it fires is not a review trigger, so suppression does not matter. The "Remove WIP label" step must use the App token, because the `unlabeled` event IS the review trigger and `GITHUB_TOKEN`-caused events are suppressed.

The workflow already uses the App token for the equivalent undraft step. The WIP removal step mirrors this.

## 5. Testing

### 5.1 State machine (`router/test/state.test.ts`)

New test cases:

| Test                                                             | Input                                                                                                      | Expected                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `synchronize on impl PR with shopfloor:wip label -> none`        | fixture: `pr-synchronize-impl-wip.json` (impl PR, non-draft, labels include `shopfloor:wip`)               | `{ stage: "none", reason: "pr_has_wip_label" }`                                  |
| `unlabeled shopfloor:wip on impl PR -> review`                   | fixture: `pr-unlabeled-wip-impl.json` (action: `unlabeled`, label.name: `shopfloor:wip`, impl PR metadata) | `{ stage: "review", issueNumber: ..., implPrNumber: ..., reviewIteration: ... }` |
| `unlabeled shopfloor:wip on impl PR that is still draft -> none` | Same fixture but `pr.draft: true`                                                                          | `{ stage: "none", reason: "pr_is_draft" }`                                       |
| `unlabeled shopfloor:wip on closed impl PR -> none`              | Same fixture but `pr.state: "closed"`                                                                      | `{ stage: "none", reason: "pr_is_closed" }`                                      |
| `unlabeled shopfloor:wip on impl PR with skip-review -> none`    | Same fixture but labels include `shopfloor:skip-review`                                                    | `{ stage: "none", reason: "skip_review_label_present" }`                         |
| `unlabeled non-wip label on impl PR -> none`                     | fixture with `label.name: "some-other-label"`                                                              | `{ stage: "none", reason: "pr_action_unlabeled_on_implement_no_action" }`        |

New fixtures:

- `router/test/fixtures/events/pr-synchronize-impl-wip.json`: copy of `pr-synchronize-impl.json` with `"shopfloor:wip"` added to `pull_request.labels`.
- `router/test/fixtures/events/pr-unlabeled-wip-impl.json`: `action: "unlabeled"`, top-level `label: { name: "shopfloor:wip" }`, `pull_request` with impl metadata in body, non-draft, open, labels without `shopfloor:wip` (GitHub removes the label from the array before delivering the event).

### 5.2 `check-review-skip` (`router/test/helpers/check-review-skip.test.ts`)

New test case:

| Test                                  | Input                                                      | Expected                                 |
| ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `PR with shopfloor:wip label -> skip` | mock `getPr` returns `labels: [{ name: "shopfloor:wip" }]` | `{ skip: true, reason: "pr_wip_label" }` |

### 5.3 Prompt rendering

No prompt changes in this spec. No new prompt tests.

### 5.4 E2E test harness (`router/test/e2e/harness/job-graph.ts`)

The `mark_ready` fake step (line 672) needs a conditional path:

- **Draft mode (default):** set `pr.draft = false` (existing behavior).
- **WIP mode:** remove `shopfloor:wip` from the PR's labels array, then enqueue a synthetic `pull_request.unlabeled` event with `label: { name: "shopfloor:wip" }` so the scenario harness processes the review trigger.

The e2e harness will need a configuration knob (passed from the scenario) to select draft vs. WIP mode. At minimum, one existing scenario (e.g., `quick-happy-path`) should be duplicated or parameterized to run in WIP mode, validating the full add-label / suppress-synchronize / remove-label / trigger-review flow.

Additionally, the `open_pr` step in the job graph should conditionally add `shopfloor:wip` to the PR's labels when WIP mode is active, mirroring the "Add WIP label" workflow step.

### 5.5 Bootstrap labels (`router/test/helpers/bootstrap-labels.test.ts`)

Existing test coverage for `bootstrapLabels` should pick up the new label automatically if it asserts on the full label list. If it uses snapshots, update the snapshot.

## 6. Caller documentation

### 6.1 Workflow input documentation

The `use_draft_prs` input in `shopfloor.yml` carries an inline description (see section 4.1). The install docs (`docs/shopfloor/install.md`) should add a section:

> **Disabling draft PRs**
>
> Set `use_draft_prs: false` in your caller workflow's `with:` block. When disabled, Shopfloor uses a `shopfloor:wip` label instead of draft status to signal work-in-progress and suppress premature reviews.
>
> Your caller workflow **must** include `unlabeled` in its `pull_request` event types:
>
> ```yaml
> on:
>   pull_request:
>     types: [opened, synchronize, closed, unlabeled, ready_for_review]
> ```
>
> Without `unlabeled`, the review pipeline will never trigger after implementation completes.

### 6.2 FAQ entry

Add to `docs/shopfloor/FAQ.md`:

> **Q: Can I use regular (non-draft) PRs instead of drafts?**
>
> A: Yes. Set `use_draft_prs: false`. Shopfloor will use a `shopfloor:wip` label to suppress reviews during agent work. Make sure your caller workflow subscribes to `pull_request: types: [unlabeled]`.

## 7. Risks and mitigations

### 7.1 Wasted workflow runs from `labeled` events

Adding `shopfloor:wip` fires `pull_request.labeled`. The state machine has no handler for `labeled` on PR events, so the route job runs and returns `stage: "none"`. This is one wasted run per impl execution (two for revision runs -- one for adding the label, though the `synchronize` from the push would have been wasted anyway in draft mode).

Mitigation: acceptable cost. The route job is lightweight (single router invocation, no agent). Filtering `labeled` events in the caller would require consumers to maintain a fragile event type list.

### 7.2 Caller event subscription mismatch

As described in section 4.9.3. Mitigation: documentation and input description. A runtime warning could be added in a future iteration if this proves to be a common mistake.

### 7.3 Race between push and label removal

If the `synchronize` from the push and the `unlabeled` from label removal arrive at GitHub's event system in a narrow window, both could potentially route to review. The `synchronize` handler checks for `shopfloor:wip` in the PR's label set as of the event payload. If the label was removed between the push and the event delivery, the payload might show the label as absent, letting `synchronize` through.

Mitigation: the workflow step ordering (push, then remove label) and GitHub's sequential event delivery within a single workflow run make this highly unlikely. Even if it occurs, the review matrix's `precheck-stage` and `already_reviewed_at_sha` guards handle duplicate review runs gracefully. The worst case is two review matrices running concurrently, one of which will skip at the aggregator due to SHA drift.

### 7.4 No behavioral regression risk for default mode

All new code paths are gated on `!inputs.use_draft_prs` or `shopfloor:wip` label presence. When `use_draft_prs` is `true` (the default), no new steps execute, no new state machine branches are reached (no impl PR will ever carry `shopfloor:wip` unless manually added), and the existing draft flow is unchanged.

## 8. Summary of touched files

| File                                            | Change                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/shopfloor.yml`               | New `use_draft_prs` input. Conditional `draft` value on `open_pr`. Two new "Add WIP label" steps (first run + revision). Conditional undraft vs. WIP removal. |
| `router/src/state.ts`                           | `shopfloor:wip` gate in `synchronize`/`ready_for_review` handler. New `unlabeled` handler for impl PRs.                                                       |
| `router/src/types.ts`                           | Add `"shopfloor:wip"` to `ShopfloorLabel` union. Add optional `label` field to `PullRequestPayload`.                                                          |
| `router/src/helpers/check-review-skip.ts`       | WIP label check (2 lines).                                                                                                                                    |
| `router/src/helpers/bootstrap-labels.ts`        | New label definition (4 lines).                                                                                                                               |
| `router/test/state.test.ts`                     | 6 new test cases.                                                                                                                                             |
| `router/test/fixtures/events/`                  | 2 new fixture files.                                                                                                                                          |
| `router/test/helpers/check-review-skip.test.ts` | 1 new test case.                                                                                                                                              |
| `router/test/e2e/harness/job-graph.ts`          | Conditional `mark_ready` step for WIP mode. Conditional WIP label add on `open_pr`.                                                                           |
| `docs/shopfloor/install.md`                     | New "Disabling draft PRs" section.                                                                                                                            |
| `docs/shopfloor/FAQ.md`                         | New FAQ entry.                                                                                                                                                |
| `router/dist/index.cjs`                         | Rebuilt dist (standard JS Action pattern).                                                                                                                    |

## 9. Conventional Commits sequence

1. `feat(labels): add shopfloor:wip to bootstrap label definitions`
   Add the label to `bootstrap-labels.ts` LABEL_DEFS and the `ShopfloorLabel` union in `types.ts`.

2. `feat(types): add label field to PullRequestPayload for unlabeled events`
   Optional `label?: { name: string }` on `PullRequestPayload`.

3. `feat(state): gate review triggers on shopfloor:wip label`
   Add WIP check to the `synchronize`/`ready_for_review` handler. Add `unlabeled` handler for impl PRs.

4. `test(state): cover shopfloor:wip gate and unlabeled handler`
   6 new test cases, 2 new fixtures.

5. `feat(review-skip): check shopfloor:wip in check-review-skip`
   Add WIP label check after draft check.

6. `test(review-skip): cover shopfloor:wip skip case`
   1 new test case.

7. `feat(workflow): add use_draft_prs input with shopfloor:wip fallback`
   Workflow input, conditional draft, add/remove WIP label steps, conditional undraft vs. removal.

8. `test(e2e): support WIP mode in job-graph harness`
   Conditional `mark_ready` and WIP label manipulation in the e2e harness.

9. `docs: document use_draft_prs option in install guide and FAQ`
   Install docs section and FAQ entry.

10. `chore(router): rebuild dist`
    `pnpm --filter @shopfloor/router build` output committed.
