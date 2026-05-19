# Spec: `shopfloor:paused` overlay label

**Issue:** #17
**Complexity:** large (dogfood — surface area kept deliberately small)

## Context

Issue #17 is a deliberate dogfood test of the `spec → plan → implement` pipeline. The issue body is empty; the author asked the agent to invent a coherent, self-contained feature. Triage classified it `large` and explicitly delegated feature invention to spec. This document is the contract for that invented feature.

The feature has to be:

1. Small enough that plan and implement can finish inside a single pipeline budget.
2. Real — a thing a user of Shopfloor would plausibly want, not a placeholder.
3. Touchable only inside `src/state/` so it does not collide with in-flight work elsewhere in the repo.

## The feature

Add a new **`shopfloor:paused`** label that acts as an _overlay_ on any issue or PR currently moving through the Shopfloor pipeline. While the label is present, the state machine refuses to route any stage for that issue or PR. Removing the label resumes routing silently — the next event that arrives will be evaluated as if the pause had never happened.

The label is intended for cases where a maintainer wants to freeze automation on a single ticket (e.g. while they discuss the design in comments, while CI for an external dependency stabilizes, while waiting on a human reviewer to weigh in) without stripping the stage labels that record where the pipeline is.

### User-visible contract

| Action                                               | Effect                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Add `shopfloor:paused` to an issue                   | All subsequent `issues` and `issue_comment` events for that issue resolve to `{ stage: "none", reason: "paused" }`.                   |
| Add `shopfloor:paused` to a Shopfloor PR             | All subsequent `pull_request` and `pull_request_review` events for that PR resolve to `{ stage: "none", reason: "paused" }`.          |
| Remove `shopfloor:paused`                            | Silent — no comment, no triage re-run. The next legitimate event (label change, push, review submission) flows through normally.     |
| Pipeline-internal label flips that the agent makes   | Unaffected. Pause only gates routing decisions; it does not change what an already-running stage writes back when it finishes.        |

### Out of scope

- Pausing the entire repository. The label is per-issue / per-PR only.
- Auto-unpause on a timer.
- Posting status comments when pause is applied or removed.
- Migrating any existing `shopfloor:wip` semantics. `wip` continues to mean "suppress review on this impl PR"; `paused` is a stronger, stage-agnostic hold.

## Design

### Overlay, not state

The defining property is that `paused` sits **next to**, never **instead of**, the existing state label. `computeStageFromLabels`, `resolveIssueEvent`, and `resolvePullRequestEvent` must all be able to recover the resume point from the surviving state label (`shopfloor:needs-impl`, `shopfloor:review-requested-changes`, etc.) the moment the pause is lifted. This is the only behavior that matters for downstream stability.

### Where the gate goes

`src/state/machine.ts` already has a small, well-defined set of branch points. The pause check is a single early-return added near the top of each event resolver, **after** the `issue_closed` / `pr_has_no_shopfloor_metadata` short-circuits (so pause does not mask "this isn't ours") and **before** any stage-advancing logic.

Resolver-by-resolver behavior:

- `resolveIssueEvent` — check for `shopfloor:paused` in `labels` after the `issue_closed_aborted` and `issue_event_is_actually_a_pr` returns, before the failed-label gate. Return `{ stage: "none", issueNumber, reason: "paused" }`.
- `resolvePullRequestEvent` — check `prLabelSet(pr).has("shopfloor:paused")` immediately after the `parsePrMetadata` guard. Return `{ stage: "none", issueNumber: meta.issueNumber, reason: "paused" }`. The merge-time `advanceOnMerge` transition is **also** suppressed by the pause — predictable beats clever, and the maintainer can always remove the label and re-trigger by closing-and-reopening or by merging again.
- `resolvePullRequestReviewEvent` — same treatment: pause check immediately after `parsePrMetadata`.
- `resolveReviewOnly` — same treatment: pause check after the metadata guard but before the draft/closed/skip-review gates.

`issue_comment` and `pull_request_review_comment` already return `none` unconditionally, so they need no change.

### Failure-label interaction

The failed-label gate (`blocked_by_shopfloor:failed:*`) and the pause gate are **independent** and both block routing. If both are present, the resolver returns whichever it checks first (failed). The user-visible result is the same: nothing routes. This is acceptable; the labels carry different remediation instructions and a maintainer who put both on knows what they did.

The "remove the failed label to retry" semantics are **not** extended to pause — removing `shopfloor:paused` does **not** re-trigger any stage on its own. The next genuine event drives the next decision.

### Label definition

Add a new entry to `LABELS` in `src/state/labels.ts`:

```ts
paused: "shopfloor:paused",
```

and a corresponding `LABEL_DEFS` row using the existing amber transient palette (`fbca04`) with description: _"Routing halted on this issue or PR. Remove to resume — no automatic re-trigger."_ Add `"shopfloor:paused"` to the `ShopfloorLabel` union in `src/state/types.ts`. **Do not** add it to the `STATE_LABELS` set in `machine.ts`: `STATE_LABELS` represents progress markers that grandfather an issue past the trigger-label gate, and pause is explicitly not progress.

### Why a label, not a flag in metadata

Labels are the only Shopfloor surface a human can mutate from the GitHub UI without crafting a comment or touching a PR body. The whole point of this feature is "click one button, freeze automation, click again, resume" — that maps to labels and nothing else.

## Surface area

Only these files change:

- `src/state/labels.ts` — add `paused` to `LABELS`, add a row to `LABEL_DEFS`.
- `src/state/types.ts` — add `"shopfloor:paused"` to `ShopfloorLabel`.
- `src/state/machine.ts` — add pause-gate early returns in the four resolvers listed above.
- `test/state/labels.test.ts` — assert the new constant is namespaced and present in `LABEL_DEFS`.
- `test/state/machine.test.ts` — cover the six cases listed under Testing.

Nothing under `src/stages/`, `src/orchestrator.ts`, `src/runners.ts`, `src/agents/`, or `src/github/` is touched. No prompt template changes. No new MCP tools. No new action inputs.

## Testing

Add unit tests in `test/state/machine.test.ts` (one `describe("paused overlay label")` block) for:

1. **Issue with `paused` + `needs-impl`** → routes to `none` with reason `paused`. After removing `paused` (next event has neither the paused label nor a `label.name === "shopfloor:paused"` unlabel signal — just a fresh `labeled: shopfloor:needs-impl` event), routes to `implement` with the original `needsLabelFor("implement")` semantics.
2. **Issue with `paused` + `failed:triage`** → routes to `none`. (Either reason is acceptable; the test asserts `stage === "none"` and does not pin the reason string. This prevents the test from over-coupling to gate ordering.)
3. **Impl PR with `paused`** on a `synchronize` event → `none` with reason `paused`, even though the PR is non-draft and lacks `wip`.
4. **Spec PR with `paused`** on a `pull_request_review` `changes_requested` event → `none` with reason `paused`; without `paused` the same payload routes to spec revision.
5. **Impl PR with `paused` + merged closed** → `none` with reason `paused`, no `advanceOnMerge`.
6. **Review-only path**: human-author PR with `paused` → `resolveReviewOnly` returns `none` with reason `paused`, even when the PR is open, non-draft, and lacks `skip-review`.

In `test/state/labels.test.ts`, assert:

- `LABELS.paused === "shopfloor:paused"`.
- `LABEL_DEFS` contains an entry whose `name === LABELS.paused`.

Run `pnpm test` and `pnpm typecheck` clean. Run `pnpm build` and commit the regenerated `dist/index.cjs` (CI enforces this).

## Trade-offs

- **Pause blocks merge-time label flips.** A maintainer who pauses a spec PR and then merges it will not see the `needs-spec → needs-plan` transition fire. This is intentional — predictable beats clever — but it is a sharp edge worth documenting. The escape hatch is "remove the label, then click 'Re-run' from the GitHub Actions UI on any prior event, or add and remove `shopfloor:revise`." We accept the sharp edge because the alternative (pause everything _except_ merge transitions) requires a second decision point and a second contract about what is and isn't gated, which is exactly the complexity this feature is supposed to avoid.
- **Pause and `wip` overlap on impl PRs.** `wip` is narrower (it only suppresses review) and is preserved for the existing user habit. Pause is the stage-agnostic hammer. We do not collapse the two because the wider `wip` semantics (e.g. is it visible in issue events?) would have to change, which is out of scope for a dogfood spec.

## Open questions

None. Defaults above are the contract.
