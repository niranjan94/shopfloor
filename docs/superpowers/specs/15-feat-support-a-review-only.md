# Spec: Review-only flow for non-Shopfloor PRs

**Issue:** #15
**Complexity:** large
**Date:** 2026-04-17

## Problem

Shopfloor's review pipeline (four-reviewer matrix + aggregator) is tightly coupled to the full issue-driven pipeline. It requires Shopfloor PR metadata (`Shopfloor-Issue`, `Shopfloor-Stage`, `Shopfloor-Review-Iteration`) and a linked origin issue for label-based state tracking. External contributor PRs — or any PR not created by Shopfloor's implement stage — cannot use agent review at all.

The goal is to let consumers run the same review+approve/request-changes cycle on arbitrary PRs without requiring a linked issue or Shopfloor metadata. Shopfloor-managed PRs must be excluded from this flow to avoid double-reviewing.

## Design

### New reusable workflow: `shopfloor-review.yml`

A second reusable workflow dedicated to review-only. Consumers call it from a thin caller workflow that listens to `pull_request` events:

```yaml
# Example: .github/workflows/review.yml (consumer-side)
name: Shopfloor Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

jobs:
  review:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor-review.yml@main
    permissions:
      contents: read
      issues: read
      pull-requests: read
    secrets: inherit
```

A separate workflow is chosen over a mode flag on the existing `shopfloor.yml` because:

1. The full pipeline workflow's inputs, routing, and job graph are all issue-centric. Bolting a PR-only mode onto it would add conditionals to every job and make an already complex workflow harder to reason about.
2. The review-only workflow has no triage, spec, plan, or implement jobs — a separate file makes this structurally clear.
3. Consumers wire different GitHub event triggers for each workflow, which is naturally expressed as separate `on:` blocks in separate files.

### Workflow structure

`shopfloor-review.yml` contains six jobs, mirroring the review chain in `shopfloor.yml`:

1. **`route`** — Lightweight gating. Checks out the repo, mints an App token, bootstraps labels, and runs the router with a new `review_only: true` mode. The router returns `stage: "review"` for any PR that does NOT carry Shopfloor metadata (i.e., `parsePrMetadata(body)` returns null), and `stage: "none"` for PRs that do. Also skips draft PRs, closed PRs, and PRs with `shopfloor:skip-review`. After routing, a step adds `shopfloor:needs-review` to the PR (so the `review-aggregator` precheck and downstream label-flip logic work identically to the full pipeline). Outputs: `stage`, `pr_number`, `review_iteration`, `has_review_app`.
2. **`review-skip-check`** — Reuses the existing `check-review-skip` helper with adaptations for missing origin issue (see below).
3. **`review-compliance`**, **`review-bugs`**, **`review-security`**, **`review-smells`** — Identical to the full pipeline's review matrix jobs. Same prompts, same models, same structured output schema. The only difference: `refs/pull/<pr_number>/head` checkout uses the route job's `pr_number` output instead of `impl_pr_number`.
4. **`review-aggregator`** — Runs `aggregate-review` in review-only mode (see below).

### Workflow inputs

`shopfloor-review.yml` accepts a subset of `shopfloor.yml`'s inputs — only the review-related ones:

- `review_*_model`, `review_*_max_turns`, `review_*_enabled`, `review_*_effort` (per-reviewer knobs)
- `review_timeout_minutes`, `review_confidence_threshold`, `max_review_iterations`
- `use_bedrock`, `use_vertex`, `use_foundry` (provider selection)
- `display_report`
- `runner_router`, `runner_review`
- `trigger_label` — optional label gate, same semantics as the full pipeline's trigger label but applied to PRs instead of issues. When set, only PRs carrying this label are reviewed.

Secrets: same set as the full pipeline. The secondary review App (`shopfloor_github_app_review_*`) is **optional** in review-only mode because the Shopfloor App is not the PR author and can post reviews on non-Shopfloor PRs without the self-review restriction.

### Router changes (`state.ts`)

Add a new export `resolveReviewOnly(payload: PullRequestPayload): RouterDecision` — a focused routing function for review-only mode. It:

1. Calls `parsePrMetadata(pr.body)`. If metadata is found, returns `{ stage: "none", reason: "pr_has_shopfloor_metadata_use_full_pipeline" }`.
2. Checks `pr.draft`, `pr.state === "closed"`, and the `shopfloor:skip-review` label. Returns `stage: "none"` with an appropriate reason for each.
3. Parses `Shopfloor-Review-Iteration: N` from the PR body (if present, from a prior review-only cycle). Defaults to 0.
4. Returns `{ stage: "review", implPrNumber: pr.number, reviewIteration }`.

This function is called by `runRoute` when a new `review_only` input is set to `"true"`. The existing `resolveStage` code path is unchanged.

### `check-review-skip.ts` changes

The `checkReviewSkip` function currently calls `parseIssueNumberFromBody` and, if a linked issue exists, checks whether it is closed or carries `shopfloor:skip-review`. For review-only PRs, there is no linked issue.

Change: make the origin-issue lookup a no-op when `parseIssueNumberFromBody` returns null. The function already handles null by skipping the block — but verify the existing code and add a test confirming this path. The rest of the skip logic (draft check, WIP label, skip-review label on PR, empty diff, already-reviewed-at-SHA) applies unchanged.

### `aggregate-review.ts` changes

#### Make `issueNumber` optional

In `AggregateReviewParams`, change `issueNumber` from required to optional (`issueNumber?: number`). When omitted, all label operations (add/remove on `shopfloor:review-approved`, `shopfloor:needs-review`, `shopfloor:review-requested-changes`, `shopfloor:review-stuck`) target the PR number instead. The PR number is always required.

Concretely, introduce a local `labelTarget` at the top of `aggregateReview`:

```typescript
const labelTarget = params.issueNumber ?? params.prNumber;
```

Replace every `params.issueNumber` in label calls with `labelTarget`. Comments and status calls already use `params.prNumber` or the SHA, so they need no change.

#### Handle missing `Shopfloor-Review-Iteration` footer

`writeIterationToBody` currently throws if the footer is absent. Change it to insert a footer when missing instead of throwing:

```typescript
function writeIterationToBody(body: string | null, iteration: number): string {
  const baseBody = body ?? "";
  if (!baseBody.match(/Shopfloor-Review-Iteration:\s*\d+/)) {
    return `${baseBody.trimEnd()}\n\nShopfloor-Review-Iteration: ${iteration}\n`;
  }
  return baseBody.replace(
    /Shopfloor-Review-Iteration:\s*\d+/,
    `Shopfloor-Review-Iteration: ${iteration}`,
  );
}
```

For full-pipeline PRs this is a no-op because `apply-impl-postwork` always inserts the footer before any review runs. For review-only PRs, the footer is inserted on the first REQUEST_CHANGES iteration and bumped on subsequent ones.

#### No revision loop

When the aggregator posts `REQUEST_CHANGES` on a review-only PR, no implement agent fires. The human contributor sees the review, fixes the code, and pushes. The push fires `pull_request.synchronize`, which re-enters the review-only workflow and triggers a new review cycle automatically.

The aggregator does not need to know whether a revision agent will run — it just posts the review and bumps the iteration counter. The existing code handles this correctly. The `max_review_iterations` cap still applies and will label the PR with `shopfloor:review-stuck` if exceeded.

### `precheck-stage.ts` changes

No new precheck stage is needed. The review-only workflow passes `issueNumber = prNumber` to the existing `review-aggregator` precheck, so it checks for the `shopfloor:needs-review` label on the PR's label set (GitHub's API treats PRs as issues). The SHA-drift check works identically since it reads from the PR head ref.

### `runRoute` changes

Add a new input `review_only` (string, default `""`). When `"true"`, call `resolveReviewOnly` instead of `resolveStage`. Forward the result as outputs. The new input is only read in the review-only workflow; the full pipeline never sets it.

### Excluding Shopfloor PRs

The `resolveReviewOnly` function returns `stage: "none"` for any PR that has Shopfloor metadata. This means if a consumer has both `dogfood.yml` (full pipeline) and a review-only caller workflow, Shopfloor-managed PRs are handled exclusively by the full pipeline and are invisible to the review-only workflow.

### No `pull_request_review` trigger needed

In the full pipeline, `pull_request_review.submitted` with `changes_requested` triggers a revision implement run. In review-only mode there is no implement agent — the human pushes a fix, which fires `pull_request.synchronize` and re-enters the review-only workflow. The review-only caller workflow therefore does NOT need `pull_request_review` in its `on:` triggers.

## State tracking summary

| Concern           | Full pipeline                                                               | Review-only                                                         |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Iteration counter | `Shopfloor-Review-Iteration` in PR body (inserted by `apply-impl-postwork`) | Same field, inserted by `aggregate-review` on first REQUEST_CHANGES |
| Label state       | On the origin issue                                                         | On the PR itself (GitHub treats PRs as issues for label API)        |
| Revision trigger  | `pull_request_review.submitted` → implement agent                           | `pull_request.synchronize` from human push                          |
| Review identity   | Requires secondary review App (primary App authored the PR)                 | Secondary review App optional (primary App did not author the PR)   |

## Files to change

| File                                      | Change                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/shopfloor-review.yml`  | **New file.** Reusable workflow with route, skip-check, four reviewer jobs, aggregator.                      |
| `router/src/state.ts`                     | Add `resolveReviewOnly` function.                                                                            |
| `router/src/helpers/route.ts`             | Read `review_only` input; dispatch to `resolveReviewOnly` when set.                                          |
| `router/src/helpers/aggregate-review.ts`  | Make `issueNumber` optional, add `labelTarget` fallback, change `writeIterationToBody` to insert-on-missing. |
| `router/src/helpers/check-review-skip.ts` | Confirm null-issue path works (add test).                                                                    |
| `router/src/helpers/precheck-stage.ts`    | No code change needed if review-only workflow passes `issueNumber = prNumber`.                               |
| `router/action.yml`                       | Add `review_only` input.                                                                                     |
| `router/dist/index.cjs`                   | Rebuilt from source.                                                                                         |
| `router/test/state.test.ts`               | Add tests for `resolveReviewOnly`.                                                                           |
| `router/test/aggregate-review.test.ts`    | Add tests for optional `issueNumber` and insert-on-missing iteration footer.                                 |
| `router/test/check-review-skip.test.ts`   | Add test for null origin issue.                                                                              |
| `docs/shopfloor/configuration.md`         | Document the review-only workflow and its inputs.                                                            |

## Trade-offs

The review matrix YAML (~200 lines per reviewer job) is duplicated between `shopfloor.yml` and `shopfloor-review.yml`. A shared composite action or reusable sub-workflow could eliminate this, but GitHub Actions does not support `workflow_call` from within a reusable workflow (no nested reusable workflows). The duplication is acceptable because: (a) the reviewer jobs are stable — they haven't changed since the initial implementation, and (b) any change to reviewer job structure should be applied to both workflows simultaneously, which is easy to verify in a single PR.

## Open questions

None. All ambiguities from the triage stage have been resolved by the issue author's clarification.
