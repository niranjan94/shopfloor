# Spec: `shopfloor:paused` label — human-controlled pipeline pause

Issue: #17

## Context

This issue is the dogfood vehicle for exercising spec → plan → implement end-to-end. Per the issue author's direction ("fake the issue fully"), the spec stage is to invent a coherent, self-contained Shopfloor feature that the downstream stages can plan and implement realistically. Triage classified the issue as `large` on that basis.

The feature this spec defines is real and ships: a `shopfloor:paused` overlay label that lets a human freeze the pipeline on a single issue or PR without disturbing any existing stage labels, then unfreeze it cleanly.

## Motivation

Shopfloor today has two ways to halt forward motion on an issue, both of which are stage transitions rather than pauses:

- `shopfloor:awaiting-info` — set by the triage agent when it needs clarification from the author. Routing returns `awaiting_info_paused` and resumes when the human removes the label (re-triage). This is owned by the agent, not the human.
- `shopfloor:failed:<stage>` — set by the orchestrator on stage failure. Removing it is a retry signal.

There is no equivalent **human-initiated** pause for an issue that has already advanced past triage (e.g., `shopfloor:needs-plan` is set, but the human spotted a problem in the merged spec and wants to halt the plan run while they amend the spec PR). Today the only options are destructive: rip out the stage label, close the issue, or scramble to delete the workflow run mid-flight. All of them lose state.

`shopfloor:paused` solves this by acting as an overlay: it does not replace existing state labels, it just makes the router decline to route while present.

## Design

### Label

Add one new label to `src/state/labels.ts:LABELS`:

```ts
paused: "shopfloor:paused",
```

It is a **user-set behaviour modifier**, in the same category as `shopfloor:skip-review` and `shopfloor:wip`. It is **not** a state label (must not be added to `STATE_LABELS` in `src/state/machine.ts`) and **not** a mutex marker. It does not appear in `ShopfloorLabel` in `src/state/types.ts` as a "stage" — it is added to the union as a plain string literal.

### Router behaviour — issue events (`resolveIssueEvent`)

The pause check is inserted in `resolveIssueEvent` immediately **after** the two structural short-circuits (`issue.state === "closed"` and `payload.issue.pull_request`) and **before** every other branch — including the failed-retry-unlabel branch and the failed-label gate. Ordering rationale:

1. **Closed issue still wins.** Closing the issue is a stronger signal than pausing it; we always emit `issue_closed_aborted` so the orchestrator does not attempt mutations on a closed issue.
2. **Pause beats failed-retry.** If a human paused the issue, removing a `shopfloor:failed:*` label should *not* secretly resume execution. Pausing means "stop, regardless of other events."
3. **Pause beats the failed-label gate.** Either reason for declining to route is fine; emitting `paused_by_user` is more informative than `blocked_by_shopfloor:failed:*` when both are present.
4. **Pause beats trigger-label gating, advancement, and `awaiting_info_paused`.** Same reasoning — the pause is the dominant signal.

When the paused label is present, return:

```ts
{ stage: "none", issueNumber, reason: "paused_by_user" }
```

The check reads from the same label source as the rest of the function — `liveLabels` when provided, else `issueLabelSet(payload.issue)` — so split-runner `execute` jobs that fetched fresh labels see the pause.

**Removing the paused label is not itself a trigger.** The `unlabeled` action where `payload.label.name === "shopfloor:paused"` falls through to the existing routing rules and returns `no_matching_label_rule` (or whatever the prevailing state-label rule yields). There is no auto-resume event — the human resumes by performing the next normal action (push a commit, flip a state label, comment-driven retry, etc.). This is intentional: auto-resuming on label removal would conflict with the "removing a label is a retry signal" pattern already established for `shopfloor:failed:*` and `shopfloor:awaiting-info`, and would surprise users who unpause to do something else first.

### Router behaviour — PR events (`resolvePullRequestEvent`)

PR-side pause is symmetric: a `shopfloor:paused` label applied to a PR halts further routing on that PR. The check is inserted **after** `parsePrMetadata(pr.body)` (so we still ignore non-Shopfloor PRs first) and **before** every branch that returns a stage. When present:

```ts
{ stage: "none", issueNumber: meta.issueNumber, reason: "paused_by_user" }
```

This covers both `synchronize` / `ready_for_review` (would-be review triggers) and `unlabeled shopfloor:wip` (the alternate review trigger). The `pr_merged_*_triggered_label_flip` branch is intentionally **not** suppressed: a merged PR has already shipped, and the label-flip orchestrator side-effect must still run to advance the linked issue.

### Router behaviour — `pull_request_review` events

`resolvePullRequestReviewEvent` reads labels from the PR payload (`prLabelSet` is not used in that function today, but `pr.labels` is available). Add the same paused-label check after `parsePrMetadata` and before any branch that returns a stage. Reason string: `paused_by_user`.

### Router behaviour — `resolveReviewOnly`

`resolveReviewOnly` already inspects `prLabelSet(pr)` to honour `shopfloor:skip-review`. Add a `shopfloor:paused` check alongside it, returning `{ stage: "none", reason: "paused_by_user" }`. This keeps the review-only entry point consistent with the full pipeline.

### What does NOT change

- **Apply layer**: no stage's `apply.ts` is touched. Pause is a routing-time concern only.
- **Orchestrator**: no changes. The orchestrator already treats `stage: "none"` as "do nothing"; `paused_by_user` is one more reason it can receive.
- **Mutex / running labels**: not affected. If a stage is mid-execution when paused is added, that stage runs to completion (we cannot interrupt an in-flight Claude session safely) and the *next* event sees the pause. This is the intended behaviour — pause is a halt-future-work signal, not a kill-current-work signal.
- **Audit events**: no new `AuditEvent` types. The existing `stage_resolved` event carries the `paused_by_user` reason string.
- **PR footer / issue metadata blocks**: unchanged.
- **`STATE_LABELS` set in `src/state/machine.ts`**: unchanged. Paused is an overlay; including it would cause `hasStateLabel` to flip true and grandfather the issue past the trigger-label gate, which is wrong.

## File-level change summary

| File | Change |
| --- | --- |
| `src/state/labels.ts` | Add `paused: "shopfloor:paused"` to `LABELS`. No new helper functions required. |
| `src/state/types.ts` | Extend `ShopfloorLabel` union with `"shopfloor:paused"`. |
| `src/state/machine.ts` | Insert paused-label early return in `resolveIssueEvent`, `resolvePullRequestEvent`, `resolvePullRequestReviewEvent`, and `resolveReviewOnly`. |
| `test/state/machine.test.ts` | Add the test cases listed below. |
| `test/state/labels.test.ts` | Assert the new label exists in `LABELS` and is recognised by `isShopfloorLabel`. |
| `README.md` | One short subsection under the existing labels documentation explaining the pause overlay. (Plan stage decides exact placement.) |

No changes to `action.yml`, `src/orchestrator.ts`, `src/runners.ts`, any stage runner or apply file, any agent prompt, or any GitHub adapter method.

## Test plan

All tests live in `test/state/machine.test.ts` (extending the existing suite). The plan stage may split into smaller `describe` blocks at its discretion.

1. **Issue with paused + needs-spec → none.** Payload action `labeled`, labels include both `shopfloor:paused` and `shopfloor:needs-spec`. Expect `{ stage: "none", reason: "paused_by_user" }`.
2. **Issue with paused + closed → still closed wins.** Closed issue, paused present. Expect `issue_closed_aborted`.
3. **Issue with paused + `shopfloor:failed:plan` → paused wins.** `unlabeled` of the failed label should *not* resume; expect `paused_by_user`.
4. **Issue with paused + trigger label absent → paused wins** (paused is more informative than `trigger_label_absent`).
5. **Removing paused alone → no auto-resume.** `unlabeled` with `payload.label.name === "shopfloor:paused"`, no other state labels triggered. Expect `no_matching_label_rule` (or `awaiting_info_paused` if that label is still set — assert by setting up labels without it).
6. **PR `synchronize` on impl PR with paused → none.** Standard review-trigger payload, paused on PR. Expect `paused_by_user`. Without the pause label, the same payload should still return `review`.
7. **PR `closed` + merged on spec PR with paused → still merged-label-flip wins.** Merge must continue to advance the linked issue. Expect `pr_merged_spec_triggered_label_flip`.
8. **`pull_request_review` REQUEST_CHANGES on paused PR → none.** Expect `paused_by_user`.
9. **`resolveReviewOnly` on paused human-authored PR → none.** Expect `paused_by_user`.
10. **Labels suite (`test/state/labels.test.ts`)**: `LABELS.paused === "shopfloor:paused"` and `isShopfloorLabel("shopfloor:paused")` is true.

`pnpm test` and `pnpm typecheck` must both pass. `pnpm build` re-bundles `dist/index.cjs`; the implement stage commits the regenerated bundle as part of its PR (Shopfloor's CI check fails on push otherwise).

## Trade-offs

- **Overlay label vs. dedicated stage.** A "paused" state in the pipeline was considered and rejected. It would force label transitions, interact with the mutex system, and break the invariant that stage labels form a linear sequence. The overlay form is strictly smaller and reversible at zero cost.
- **Auto-resume on label removal vs. silent unpause.** Auto-resume would mirror `shopfloor:failed:*` and `shopfloor:awaiting-info`, but it conflates two distinct user intents (unpausing vs. *also* immediately retrying) and would re-fire on every churn of the label. Silent unpause is more predictable; the human always has cheap ways to fire the next event explicitly (push a commit, toggle a state label).
- **Same label name on issues and PRs vs. two separate names.** A single `shopfloor:paused` applied to either object is what humans reach for naturally, and the router already inspects labels on whichever object the event fires against. Two names (`shopfloor:issue-paused`, `shopfloor:pr-paused`) would double the surface area without making the semantics clearer.

## Open questions

None. The design is fully self-contained; ambiguity in the original issue body was resolved by triage's classification rationale.

## Out of scope

- Surfacing the pause label in the GitHub step-summary mirror (`src/audit/step-summary.ts`). The router still emits `stage_resolved`, and that is enough for log debuggability.
- Automatic cleanup of stale pauses (e.g., auto-removing paused after N days). Humans add and remove this label deliberately.
- Pausing at the **repository** level. Users who want that can use the existing `triggerLabel` action input (drop the trigger label from issues), which already gates entry.
- Any changes to the spec / plan / implement / review **agent prompts** themselves.
