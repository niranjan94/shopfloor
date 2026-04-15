# Implement-stage revision loop

**Status:** Draft
**Date:** 2026-04-15
**Author:** Drafted collaboratively with Claude (Opus 4.6)
**Supersedes:** N/A (completes the implement-stage revision path that was partially wired in v0.1)

## 1. Overview

When the Shopfloor review matrix posts `REQUEST_CHANGES` on an impl PR, the router state machine already returns `stage: "implement"` with `revisionMode: true`. The pipeline reads the next event correctly, the precheck helper already accepts `shopfloor:review-requested-changes` as a valid entry condition, and the impl prompt template already has slots for a review iteration counter and a review feedback array. But the workflow YAML never branches on `revision_mode`, the `branchName`/`implPrNumber`/file-path outputs are never populated for the revision path, and no mechanism exists to fetch the actual review comments and feed them to the agent.

The end-to-end symptom is that the second impl run for any PR that received agent review feedback crashes at the `Create impl branch` step:

```
git config user.name "github-actions[bot]"
fatal: '' is not a valid branch name
```

This spec completes the half-wired revision path so that:

1. The state machine populates branch/PR/path metadata for revision decisions.
2. A new `build-revision-context` router helper composes the impl context.json from API state instead of from `github.event.issue.*` (which does not exist on `pull_request_review` events).
3. The implement job in the workflow gains a `revision_mode == 'true'` fork that checks out the existing branch, skips PR creation, and pushes new commits without force.
4. The impl prompt is restructured so the revision context is omitted entirely on first runs and explicitly stated on revision runs (no "if non-empty" conditionals for the agent to interpret).

The push at the end of a revision run fires `pull_request.synchronize`, which the existing state machine already routes back into the review matrix. The iteration counter, the iteration cap, and the `review-stuck` escape hatch are already implemented in `aggregate-review` and need no changes.

## 2. Problem statement

### 2.1 The observed failure

`https://github.com/niranjan94/shopfloor/pull/10` completed its first impl run, the review matrix posted `REQUEST_CHANGES` with inline comments, the issue picked up `shopfloor:review-requested-changes`, and the next impl workflow run crashed immediately at branch creation. Run: `https://github.com/niranjan94/shopfloor/actions/runs/24462484131/job/71480325952?pr=10`.

### 2.2 Root cause walk

1. `aggregate-review` posts a `REQUEST_CHANGES` review on the impl PR using the secondary review GitHub App. That fires `pull_request_review.submitted`.
2. `dogfood.yml` propagates the event into the reusable `shopfloor.yml` workflow.
3. `route` runs. `resolvePullRequestReviewEvent` (`router/src/state.ts:386`) parses PR metadata, sees `meta.stage === "implement"`, and returns:
   ```ts
   {
     stage: "implement",
     issueNumber: meta.issueNumber,
     revisionMode: true,
     reviewIteration: meta.reviewIteration,
     reason: "agent_requested_changes",
   }
   ```
   No `branchName`, no `implPrNumber`, no `specFilePath`, no `planFilePath`.
4. The `route` job's outputs are emitted by `runRoute` in `router/src/helpers/route.ts`. Outputs that are undefined are simply not written, so `needs.route.outputs.branch_name` becomes the empty string downstream.
5. The `implement` job's `if:` gate is `needs.route.outputs.stage == 'implement'`. It fires unconditionally for both first runs and revisions. The job's `Create impl branch` step runs `git checkout -b ""`, which fails with the error above.

Even if `branchName` were populated, the next four steps would also be wrong for a revision: the empty bootstrap commit, the force-push, the `open-stage-pr` call (which would 422 because a PR for the head already exists), the `gh pr ready` call (which would noop on an already-ready PR), and the `Build implement context` step's reliance on `github.event.issue.*` (which does not exist on a `pull_request_review` event). The revision path is effectively unimplemented in the workflow.

### 2.3 What is already working

It is worth being explicit about what does NOT need to change, so the scope of the fix stays small:

- `aggregate-review` correctly posts `REQUEST_CHANGES`, increments `Shopfloor-Review-Iteration` in the PR body, adds `shopfloor:review-requested-changes`, and removes `shopfloor:needs-review`.
- `precheckStage` for the `implement` stage (`router/src/helpers/precheck-stage.ts:97`) already accepts `shopfloor:review-requested-changes` as a valid entry alongside `shopfloor:needs-impl`.
- `apply-impl-postwork` already removes `shopfloor:review-requested-changes` and re-adds `shopfloor:needs-review` after a successful impl run, completing the loop.
- The state machine's `synchronize` branch (`router/src/state.ts:361`) already routes a non-draft impl PR push back into the review matrix.
- The iteration cap and `review-stuck` escape hatch are already in `aggregate-review`.

The only pieces missing are: populating router outputs for the revision case, fetching the review feedback, branching the impl job, and restructuring the impl prompt to avoid the conditional language the agent currently has to interpret.

## 3. Goals and non-goals

### Goals

- **Second impl run does not crash.** A revision triggered by `pull_request_review.submitted` with `state == "changes_requested"` runs to completion or fails for a real reason, not because of empty router outputs.
- **Agent receives the review comments verbatim.** The agent does not have to scrape the PR; the workflow hands it a typed JSON array of review comments and an explicit "this is a revision run" preamble.
- **The iteration loop closes naturally.** A push from the revision run fires `synchronize`, which the existing state machine already converts into another review matrix run, which either approves the PR or posts another `REQUEST_CHANGES` and bumps the counter.
- **Single source of truth for the first-run impl prompt.** Restructuring the prompt to support revision mode does not duplicate the bulk of `prompts/implement.md`.
- **Testable in isolation.** New logic lives behind a router helper with a `GitHubAdapter` dependency that mocks cleanly in vitest.

### Non-goals

- Resolving individual review comment threads (GitHub's REST API does not support this cleanly; the iteration counter is the convergence signal).
- Fetching multi-review history. Only the latest `REQUEST_CHANGES` review gets fed to the agent. Older iterations are either resolved by previous commits or superseded by the latest review.
- Filtering review comments by the review App's identity. Whatever `REQUEST_CHANGES` review is most recent gets addressed, regardless of author. If a human also requests changes, both get rolled into the same revision run, which is the correct behavior.
- Per-comment commit traceability beyond what the existing prompt already requires (one CC commit per review comment, referencing the comment in the message).
- Rewriting `prompts/implement.md` for any reason other than carving out the revision context into a fragment.
- Changing how `apply-impl-postwork` or `aggregate-review` work.

## 4. Architecture

The fix has four parts. They are independent enough to land as separate commits but small enough to ship together.

### 4.1 State machine populates revision outputs

`resolvePullRequestReviewEvent` for `meta.stage === "implement"` parses `pr.head.ref` against the canonical impl branch shape and uses the parse to populate the missing decision fields:

```
shopfloor/impl/<issueNumber>-<slug>
```

If the parse succeeds, the decision becomes:

```ts
{
  stage: "implement",
  issueNumber: meta.issueNumber,
  revisionMode: true,
  reviewIteration: meta.reviewIteration,
  branchName: pr.head.ref,
  implPrNumber: pr.number,
  specFilePath: `docs/shopfloor/specs/${meta.issueNumber}-${slug}.md`,
  planFilePath: `docs/shopfloor/plans/${meta.issueNumber}-${slug}.md`,
  reason: isShopfloorReview ? "agent_requested_changes" : "human_requested_changes",
}
```

If the parse fails (the head ref is not in the canonical shape, e.g. someone manually retargeted the PR), the decision returns:

```ts
{ stage: "none", reason: "impl_revision_unparseable_branch_ref" }
```

This intentionally fails closed: no impl run is dispatched, the issue retains `shopfloor:review-requested-changes`, and a human investigates. Crashing the workflow at `git checkout -b` is not acceptable.

The slug derivation deliberately reads from the branch ref instead of from the issue body's `Shopfloor-Slug` metadata block. The branch is what actually exists on disk; if the issue title was renamed post-triage and the metadata block disagrees with the branch, the branch wins.

### 4.2 New router helper: `build-revision-context`

A new helper composes the impl `context.json` for revision runs. The first-run path keeps using the existing inline `jq` block in the workflow, because that path has access to `github.event.issue.*` and does not need any GitHub API calls. The revision path cannot use either the inline jq or the issue payload, so it needs a helper.

Inputs (from action.yml):

- `issue_number`
- `pr_number`
- `branch_name`
- `spec_file_path`
- `plan_file_path`
- `complexity`
- `progress_comment_id`
- `bash_allowlist`
- `output_path` — absolute path under `$RUNNER_TEMP` where the helper writes the resulting context.json

Behavior:

1. Fetch issue title + body via `adapter.getIssue(issue_number)`.
2. Fetch PR reviews via a new adapter method `listPrReviews(prNumber)`.
3. Find the most recent review with `state === "changes_requested"`. If none exists, throw — the helper was called in revision mode but the review system has no `REQUEST_CHANGES` to address. This indicates a wiring bug worth surfacing loudly.
4. Fetch PR review comments via a new adapter method `listPrReviewComments(prNumber)`. Filter to comments with `pull_request_review_id === latestReview.id`.
5. Map filtered comments to a stable shape:
   ```ts
   {
     path: string;
     line: number;
     side: "LEFT" | "RIGHT";
     start_line?: number;
     start_side?: "LEFT" | "RIGHT";
     body: string;
   }
   ```
6. Read `Shopfloor-Review-Iteration` from the PR body via the existing `parseIterationFromBody` (lifted from `apply-impl-postwork.ts` to a shared module if needed; pure function, two-line copy is also acceptable).
7. Compose `spec_source` the same way the existing inline workflow step does — wrap the spec file in `<spec_file_contents>` if present, otherwise the medium-flow fallback string.
8. Read `plan_file_contents` from `plan_file_path` if present.
9. Read issue comments via `gh api` is NOT used here; the helper uses the typed adapter for everything. A new adapter method `listIssueComments(issueNumber)` is added if it does not already exist.
10. Build the context object with the same shape the existing first-run jq block produces, plus a populated `revision_block` field:
    ```ts
    {
      issue_number: string,
      issue_title: string,
      issue_body: string,
      issue_comments: string,
      spec_source: string,
      plan_file_contents: string,
      branch_name: string,
      progress_comment_id: string,
      review_comments_json: string, // JSON-stringified array
      iteration_count: string,
      bash_allowlist: string,
      repo_owner: string,
      repo_name: string,
      revision_block: string, // pre-rendered fragment (see 4.4)
    }
    ```
11. Write `JSON.stringify(context)` to `output_path` and emit `path=$OUTPUT_PATH` as a step output.

The helper exits non-zero on any unrecoverable error (issue not found, no `REQUEST_CHANGES` review). It uses `core.warning` for soft failures (issue comments fetch fails — fall back to empty string, same as the inline path does today).

### 4.3 GitHubAdapter additions

Three new adapter methods, each a thin wrapper around an existing Octokit endpoint. All three are read-only. None of them require any new permissions on the App.

```ts
listPrReviews(prNumber: number): Promise<Array<{
  id: number;
  state: string;
  user: { login: string } | null;
  body: string | null;
  submitted_at: string | null;
  commit_id: string;
}>>;

listPrReviewComments(prNumber: number): Promise<Array<{
  id: number;
  pull_request_review_id: number | null;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  body: string;
}>>;

listIssueComments(issueNumber: number): Promise<Array<{
  user: { login: string } | null;
  created_at: string;
  body: string | null;
}>>;
```

All three use Octokit's pagination helpers internally and return the full list. The PR review and review-comment endpoints typically return at most a few dozen items per PR even on long-running iterations, so unbounded pagination is acceptable.

### 4.4 Prompt restructuring

`prompts/implement.md` currently has a `<review_feedback>` block inside `<context>` and a `<revision_handling>` section that says "If `<review_feedback>` is non-empty, this is a revision run." The agent has to interpret a conditional. Restructure to remove the conditional entirely:

1. Edit `prompts/implement.md`:
   - Remove the `<review_feedback>` block from `<context>`.
   - Remove the `<revision_handling>` section.
   - Remove the `Review iteration: {{iteration_count}}` line from `<context>`.
   - Add a single `{{revision_block}}` slot near the bottom of `<context>` (or as its own top-level section just below `<context>`; the exact location is a minor judgment call during implementation).
2. Add `prompts/implement-revision-fragment.md` containing the revision-specific language verbatim, with no conditionals:

   ```
   <revision_run>
   THIS IS A REVISION RUN. You are iterating on an existing impl PR that the
   Shopfloor review system flagged. This is iteration {{iteration_count}} of
   the review loop. Your job is to address the review comments below by adding
   new commits on top of the existing branch. Do NOT squash, amend, or rebase.
   Each fix gets its own Conventional Commits commit. The commit message
   should reference the comment it resolves (path:line and a short verbatim
   excerpt). Commit the fix, update the progress checklist, then move on to
   the next comment.
   </revision_run>

   <review_feedback>
   {{review_comments_json}}
   </review_feedback>
   ```

3. `build-revision-context` reads the fragment file via `resolvePromptFile`, renders it with `renderPrompt({iteration_count, review_comments_json})`, and stores the rendered text as the `revision_block` field of the parent context.
4. The first-run context builder passes `revision_block: ""`. The slot collapses to nothing in the rendered prompt; the agent never sees the word "revision".

Pros: prompt wording lives in plain markdown that prompt authors can edit independently. The renderer stays a dumb string substituter (no conditional support added). Single source of truth for the bulk of the impl prompt.

### 4.5 Workflow fork on `revision_mode`

The `implement` job in `.github/workflows/shopfloor.yml` gains conditionals on `needs.route.outputs.revision_mode == 'true'` for the steps that diverge. The shared steps (token mints, precheck, mark-implementing, MCP config write, agent invocation, post-agent token mint, push, finalize-progress, apply-impl-postwork, report-failure) stay unchanged.

Concretely:

| Step                                           | First run condition       | Revision run condition    |
| ---------------------------------------------- | ------------------------- | ------------------------- |
| `Create impl branch` (existing)                | `revision_mode != 'true'` | n/a                       |
| `Checkout existing impl branch` (new)          | n/a                       | `revision_mode == 'true'` |
| `Open draft impl PR` (existing `open_pr`)      | `revision_mode != 'true'` | n/a                       |
| `Resolve existing impl PR number` (new)        | n/a                       | `revision_mode == 'true'` |
| `Build implement context` (existing inline jq) | `revision_mode != 'true'` | n/a                       |
| `Build revision context` (new helper call)     | n/a                       | `revision_mode == 'true'` |
| `Push impl commits` (existing)                 | both                      | both                      |
| `Mark impl PR ready for review` (existing)     | `revision_mode != 'true'` | n/a                       |

Step details for the revision-only steps:

**Checkout existing impl branch.** Runs:

```bash
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin "${BRANCH_NAME}":"${BRANCH_NAME}"
git checkout "${BRANCH_NAME}"
```

The `actions/checkout` step at the top of the impl job uses default fetch depth, which is shallow. The `git fetch` here pulls down the impl branch tip as a local ref. No force, no rebase.

**Resolve existing impl PR number.** Reads `needs.route.outputs.impl_pr_number` and re-emits it as a step output with id `open_pr` so downstream steps that reference `steps.open_pr.outputs.pr_number` work for both paths without conditional indirection. This is a one-line `echo "pr_number=${{ needs.route.outputs.impl_pr_number }}" >> "$GITHUB_OUTPUT"` step. The step id stays `open_pr` (overloaded for both paths, gated by `if`); the existing first-run `open_pr` step keeps its id but gains a `revision_mode != 'true'` gate.

Implementation note: GitHub Actions does not allow two steps with the same id in the same job. The fix is to use distinct ids (`open_pr_first` and `open_pr_revision`) and then add a tiny aggregator step that emits a unified `pr_number` step output that downstream steps reference. Or simpler: rename the existing step and reference its output through a `steps.<id>.outputs.pr_number || needs.route.outputs.impl_pr_number` fallback expression in the consumers. The cleanest version is decided during implementation; the spec just requires that downstream steps see one canonical `pr_number` regardless of path.

**Build revision context.** Calls the new router helper:

```yaml
- name: Build revision context
  if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
  id: ctx
  uses: ./router
  with:
    helper: build-revision-context
    github_token: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
    issue_number: ${{ needs.route.outputs.issue_number }}
    pr_number: ${{ needs.route.outputs.impl_pr_number }}
    branch_name: ${{ needs.route.outputs.branch_name }}
    spec_file_path: ${{ needs.route.outputs.spec_file_path }}
    plan_file_path: ${{ needs.route.outputs.plan_file_path }}
    progress_comment_id: ${{ steps.progress.outputs.comment_id }}
    bash_allowlist: ${{ inputs.impl_bash_allowlist }}
    output_path: ${{ runner.temp }}/context.json
```

The helper writes `context.json` to the path and emits `path=...` as an output, so the existing `Render implement prompt` step's `context_file: ${{ steps.ctx.outputs.path }}` reference works unchanged.

**Push impl commits.** Stays as-is. `git push origin "${BRANCH_NAME}"` works for both first runs (where the branch was force-pushed already) and revision runs (where new commits stack on the existing branch). No force flag in either case at this step.

**Skipped on revision: Mark impl PR ready for review.** The existing step gains a `needs.route.outputs.revision_mode != 'true'` gate. The PR is already out of draft from the first-run impl job; calling `gh pr ready` again would be a noop.

**Triggering the next review cycle.** After `Push impl commits`, `pull_request.synchronize` fires on the (non-draft) impl PR. `dogfood.yml` already subscribes to `pull_request.synchronize`. The router runs, `resolvePullRequestEvent` returns `stage: "review"` for a non-draft impl PR's synchronize event, and the review matrix dispatches. No changes needed.

### 4.6 Iteration cap and label flow on revision

`aggregate-review` already handles iteration > max via the `shopfloor:review-stuck` path. Once the impl revision pushes, the new review run either approves or `REQUEST_CHANGES` again. After three iterations of `REQUEST_CHANGES`, the next aggregate-review hits the cap and applies `shopfloor:review-stuck`. No new logic.

The label transitions per revision iteration are:

```
Before revision:    needs-review removed,    review-requested-changes added
                    (by aggregate-review at end of previous iteration)
During revision:    implementing added (by impl job's mark-implementing step)
                    review-requested-changes still present (precheck accepts it)
After revision:     implementing removed,    needs-review added,
                    review-requested-changes removed
                    (by apply-impl-postwork at end of impl job)
```

This is unchanged from the existing intent of `apply-impl-postwork`. The fix only makes the impl job actually reach `apply-impl-postwork` instead of crashing at branch creation.

## 5. Testing

### 5.1 State machine

`router/test/state.test.ts` gains:

- A passing test: `pull_request_review.submitted` with `state: "changes_requested"` on an impl PR with head ref `shopfloor/impl/42-add-something` returns a decision with `branchName === "shopfloor/impl/42-add-something"`, `implPrNumber === <pr.number>`, `specFilePath === "docs/shopfloor/specs/42-add-something.md"`, `planFilePath === "docs/shopfloor/plans/42-add-something.md"`, `revisionMode === true`.
- A failing-closed test: same event but with `pr.head.ref === "feature/manual-rename"` returns `{ stage: "none", reason: "impl_revision_unparseable_branch_ref" }`.

A new fixture under `router/test/fixtures/` for the `pull_request_review` payload shape.

### 5.2 build-revision-context helper

`router/test/helpers/build-revision-context.test.ts` (new). Uses a vitest mock adapter (same pattern as the other helper tests). Cases:

- **Happy path.** Adapter returns issue, two reviews (one `commented`, one `changes_requested`), three review comments (two with `pull_request_review_id` matching the latest review, one with an older `pull_request_review_id`). Helper writes a context.json containing only the two relevant comments, the iteration counter parsed from the PR body, and a `revision_block` that contains the rendered fragment with the iteration counter inlined.
- **Missing REQUEST_CHANGES.** Adapter returns reviews with no `changes_requested` state. Helper throws with a message that names the wiring bug.
- **Filesystem reads.** Helper composes `spec_source` and `plan_file_contents` correctly when the files exist on disk vs. when they do not (use a temp dir fixture).
- **Snapshot.** Snapshot the rendered context.json against `router/test/fixtures/build-revision-context.snap.json`.

### 5.3 GitHubAdapter additions

`router/test/github.test.ts` (or wherever the existing adapter tests live) gains thin coverage for the three new methods. Each test mocks Octokit and asserts the parameters passed and the shape returned.

### 5.4 Prompt rendering

`router/test/prompt-render.test.ts` gains a snapshot test that renders `prompts/implement.md` with `revision_block: ""` and asserts the output contains no occurrence of "revision" or "review_feedback". A second snapshot renders with a non-empty fragment and asserts it appears in the rendered output.

### 5.5 Manual end-to-end on dogfood

Not part of the automated suite but documented here so the implementer knows the validation steps:

1. Land the spec, plan, and implementation commits on a feature branch.
2. Open a Shopfloor issue with `shopfloor:trigger`.
3. Let it run end-to-end through impl. PR opens, ready for review, review matrix runs, posts `REQUEST_CHANGES`.
4. Watch the second impl run dispatch. Check the impl agent's stdout for the `<revision_run>` block. Check that the agent commits a fix per review comment. Check that `apply-impl-postwork` removes `shopfloor:review-requested-changes`.
5. Watch the third review matrix run either approve the PR or post another `REQUEST_CHANGES`. Stop after iteration 3 confirms the cap behavior.

## 6. Risks and mitigations

### 6.1 Branch ref parsing is brittle

Hardcoding the `shopfloor/impl/<N>-<slug>` pattern means a manual rename of the impl branch breaks the revision path. Mitigation: the state machine fails closed (`stage: "none"`) instead of dispatching a broken impl job. The issue retains the review-requested-changes label and a human can investigate. Crash containment is more important than auto-recovery here.

### 6.2 Review comment threading is shallow

Filtering by `pull_request_review_id` of the latest `REQUEST_CHANGES` review ignores the case where a human posts a separate `REQUEST_CHANGES` review between the agent's review and the impl run. In that case only the most recent review's comments get addressed; the human's comments would be silently dropped. Mitigation: this is exotic enough that the iteration cap and human-readable PR thread make it recoverable. Document it in the spec but do not engineer for it. If it becomes a real problem, the fix is to fetch all `REQUEST_CHANGES` reviews newer than the most recent commit on the branch.

### 6.3 The revision context helper does many things

`build-revision-context` fetches issues, reviews, comments, reads the filesystem for spec/plan files, reads the prompt fragment, and writes a context file. That is a lot for one helper. Mitigation: the alternative is several smaller helpers chained in the workflow, which would multiply token mints, runner steps, and YAML clutter. The helper's dependencies are all behind the adapter and the renderer, both of which are mockable, so test coverage stays straightforward.

### 6.4 GitHubAdapter pagination

Three new endpoints all get unbounded pagination. PRs with hundreds of review comments would slow this down. Mitigation: not a real risk for impl PRs in v0.1 because the iteration cap is 3 and each iteration posts at most a couple dozen comments. Revisit if dogfooding shows more.

### 6.5 Race between impl push and review matrix

The impl job's `Push impl commits` step fires `synchronize`, which begins a separate workflow run for the review matrix. Meanwhile the impl job continues and runs `apply-impl-postwork`, which adds `shopfloor:needs-review`. The review aggregator's `precheck-stage` checks for `shopfloor:needs-review`. There is a race: if the review matrix's aggregator runs precheck before `apply-impl-postwork` adds the label, the aggregator skips with `review_needs_review_label_absent`.

This race already exists for first runs, where the same sequence occurs (push fires synchronize, then `gh pr ready` fires ready_for_review, then apply-impl-postwork flips the label). The matrix takes minutes to run because each cell calls claude-code-action; `apply-impl-postwork` finishes in seconds. Empirically the race resolves the right way in the existing first-run flow. Revision inherits the same property. No new mitigation needed.

### 6.6 Prompt fragment missing from runner

If `prompts/implement-revision-fragment.md` is not on disk where `resolvePromptFile` looks, `build-revision-context` throws and the impl job fails at the helper step. Mitigation: ship the fragment in the same `prompts/` directory as the existing prompt files. The repo's `actions/checkout` at the top of the impl job pulls the fragment along with everything else.

## 7. Out of scope

- Multi-review-per-iteration coalescing (one review per iteration is already the contract `aggregate-review` enforces).
- Resolving review comment threads in the GitHub UI (requires GraphQL `resolveReviewThread`; not worth the complexity for v0.1).
- A revision-aware `superpowers:subagent-driven-development` flow (the impl prompt already invokes the standard skill; revision just changes the input feedback).
- Per-comment commit status badges or a "fixed by" PR comment trail.
- Quick-complexity revision support. Quick issues use `prompts/implement-quick.md`, which has no spec/plan and no review matrix integration today. Out of scope here.
- Changing `aggregate-review` or the iteration cap.

## 8. Conventional Commits sequence

The implementation lands as a sequence of commits, each with a Conventional Commits message and a coherent diff. This sequence is also the basis for the implementation plan that follows this spec.

1. `feat(state): populate branch and pr metadata for impl revision decision`
   State machine change. Adds the branch ref parser, populates `branchName`, `implPrNumber`, `specFilePath`, `planFilePath` for the implement-stage revision decision. Fails closed when the head ref does not match the canonical pattern.

2. `test(state): cover impl revision decision and unparseable branch ref`
   Vitest cases for the happy path and the fail-closed path. New fixture for the `pull_request_review` payload.

3. `feat(github): add listPrReviews, listPrReviewComments, listIssueComments to adapter`
   Three thin Octokit wrappers in `router/src/github.ts`. Read-only, paginated, no permission changes.

4. `feat(prompts): split impl revision context into fragment file`
   Edit `prompts/implement.md` to remove `<review_feedback>` and `<revision_handling>`, add a `{{revision_block}}` slot. Add `prompts/implement-revision-fragment.md` with the explicit revision language.

5. `feat(router): add build-revision-context helper`
   New helper file, runner registration in `router/src/index.ts`, action.yml input declarations. Composes the impl context.json from API state and the rendered fragment.

6. `test(router): cover build-revision-context helper`
   Vitest cases for the helper's happy path, missing REQUEST_CHANGES throw, filesystem read paths, and snapshot of the rendered context.json.

7. `feat(workflow): branch implement job on revision_mode`
   Workflow YAML changes: existing first-run steps gated on `revision_mode != 'true'`, new revision-only steps gated on `revision_mode == 'true'`, downstream consumers reference a unified `pr_number` value.

8. `chore(router): rebuild dist`
   `pnpm --filter @shopfloor/router build` output committed. Standard JS Action pattern.

The first six commits land in any order before commit 7. Commit 7 is the last functional commit; commit 8 is the bundler output and lands last per the existing repo pattern.
