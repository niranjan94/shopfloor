# Spec/Plan Revision Mode + @path References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spec and plan PR rework loops functional end-to-end (YAML + router + prompts), and switch all prompts from embedding full spec/plan file contents to `@<relative-path>` references that let the agent read them on demand.

**Architecture:** Mirror the implement job's proven 7-conditional revision_mode pattern for spec and plan jobs in the workflow YAML. Extend `build-revision-context` with a `stage` input so a single helper handles revision context for all three stages. Create `spec-revision-fragment.md` and `plan-revision-fragment.md` following the same `{{revision_block}}` pattern implement already uses. Replace all inline spec/plan content injection with `@<path>` references.

**Tech Stack:** GitHub Actions YAML, TypeScript (router helpers), Markdown (prompt templates), vitest (e2e tests).

**Spec:** Emerged from YAML audit against the implement job's revision-mode handling; verified by independent subagent review.

---

## File Structure

| File                                                                 | Status  | Responsibility                                                                                                                                                            |
| -------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts/spec.md`                                                    | Modify  | Replace `<previous_spec>{{previous_spec_contents}}</previous_spec>` + `<review_feedback>` + `<revision_handling>` with `{{revision_block}}`.                              |
| `prompts/plan.md`                                                    | Modify  | Replace `{{spec_source}}` with `@{{spec_file_path}}` ref. Replace `<previous_plan>` + `<review_feedback>` + `<revision_handling>` with `{{revision_block}}`.              |
| `prompts/implement.md`                                               | Modify  | Replace `{{spec_source}}` with `@{{spec_file_path}}` ref. Replace `<plan_file_contents>{{plan_file_contents}}</plan_file_contents>` with `@{{plan_file_path}}` ref.       |
| `prompts/spec-revision-fragment.md`                                  | Create  | Revision instructions for spec agent + `{{review_comments_json}}` + `@{{spec_file_path}}` ref to read previous version.                                                   |
| `prompts/plan-revision-fragment.md`                                  | Create  | Revision instructions for plan agent + `{{review_comments_json}}` + `@{{plan_file_path}}` ref + `@{{spec_file_path}}` ref.                                                |
| `router/src/helpers/build-revision-context.ts`                       | Modify  | Accept `stage` input (spec/plan/implement). For all stages: stop reading full file contents, pass paths. For spec/plan: render the new fragment, output `revision_block`. |
| `.github/workflows/shopfloor.yml`                                    | Modify  | Spec job: split branch checkout + context builder on `revision_mode`. Plan job: same. Implement job first-run: stop embedding full contents, pass paths.                  |
| `router/test/helpers/build-revision-context.test.ts`                 | Modify  | Add spec/plan stage test coverage.                                                                                                                                        |
| `router/test/e2e/harness/job-graph.ts`                               | Modify  | Add spec-revision and plan-revision stage keys. Update implement context builders to use paths.                                                                           |
| `router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts` | Modify  | Assert `revision_block` is populated during the rework run.                                                                                                               |
| `router/dist/index.cjs`                                              | Rebuild | Standard dist rebuild after router changes.                                                                                                                               |

---

## Phase 1: Prompt templates and revision fragments

### Task 1: Create revision fragments for spec and plan

**Files:**

- Create: `prompts/spec-revision-fragment.md`
- Create: `prompts/plan-revision-fragment.md`

These follow the exact pattern of `prompts/implement-revision-fragment.md`.

- [ ] **Step 1: Read the implement revision fragment for reference**

Run: `cat prompts/implement-revision-fragment.md`

- [ ] **Step 2: Create `prompts/spec-revision-fragment.md`**

```markdown
<revision_run>
THIS IS A REVISION RUN. You are iterating on an existing spec PR that a
human reviewer flagged with REQUEST_CHANGES. Your job is to address the
review comments below by revising the spec file in place. Read the current
spec at @{{spec_file_path}} before making any changes.

Preserve structure and decisions that were not criticized. Address every
review comment by name in your revision. Do NOT rewrite from scratch.
</revision_run>

<review_feedback>
{{review_comments_json}}
</review_feedback>
```

- [ ] **Step 3: Create `prompts/plan-revision-fragment.md`**

```markdown
<revision_run>
THIS IS A REVISION RUN. You are iterating on an existing plan PR that a
human reviewer flagged with REQUEST_CHANGES. Your job is to address the
review comments below by revising the plan file in place. Read the current
plan at @{{plan_file_path}} before making any changes. If a spec exists,
read it at @{{spec_file_path}} for context.

Preserve structure and decisions that were not criticized. Address every
review comment by name in your revision. Do NOT rewrite from scratch.
</revision_run>

<review_feedback>
{{review_comments_json}}
</review_feedback>
```

- [ ] **Step 4: Commit**

```bash
git add prompts/spec-revision-fragment.md prompts/plan-revision-fragment.md
git commit -m "feat(prompts): add spec and plan revision fragments"
```

---

### Task 2: Update prompt templates to use @path refs and {{revision_block}}

**Files:**

- Modify: `prompts/spec.md`
- Modify: `prompts/plan.md`
- Modify: `prompts/implement.md`

- [ ] **Step 1: Update `prompts/spec.md`**

Replace the `<previous_spec>`, `<review_feedback>`, and `<revision_handling>` blocks (lines 50-63) with:

```markdown
{{revision_block}}
```

The `revision_block` is empty on first-run (no revision context) and populated from `spec-revision-fragment.md` during revision runs. The fragment itself tells the agent to read the previous spec via `@path`.

- [ ] **Step 2: Update `prompts/plan.md`**

Replace `{{spec_source}}` (line 48, which currently embeds the full spec file) with:

```markdown
<spec_reference>
Read the design spec at @{{spec_file_path}} for the decisions this plan must implement. If no spec exists (medium-complexity flow), derive the design directly from the <issue_body> and <issue_comments> above.
</spec_reference>
```

Replace the `<previous_plan>`, `<review_feedback>`, and `<revision_handling>` blocks (lines 50-61) with:

```markdown
{{revision_block}}
```

- [ ] **Step 3: Update `prompts/implement.md`**

Replace `{{spec_source}}` (line 53, currently `<spec_file_contents>` or `<spec_source>` block) with:

```markdown
<spec_reference>
Read the design spec at @{{spec_file_path}} if one exists. If no spec file is present, this is the medium-complexity flow -- the plan below is your sole source of truth.
</spec_reference>
```

Replace `<plan_file_contents>{{plan_file_contents}}</plan_file_contents>` (lines 55-57) with:

```markdown
<plan_reference>
Read the implementation plan at @{{plan_file_path}}.
</plan_reference>
```

- [ ] **Step 4: Verify no prompt template references `previous_spec_contents`, `previous_plan_contents`, `plan_file_contents`, or `spec_source` anymore**

Run: `grep -rn "previous_spec_contents\|previous_plan_contents\|plan_file_contents\|spec_source" prompts/`
Expected: no matches (or only in revision fragments if needed).

NOTE: `spec_file_path` and `plan_file_path` are ALREADY in the context JSON for all stages (the route emits them). So `@{{spec_file_path}}` will render to e.g. `@docs/superpowers/specs/issue-42-spec.md` which the agent can read.

- [ ] **Step 5: Commit**

```bash
git add prompts/spec.md prompts/plan.md prompts/implement.md
git commit -m "feat(prompts): replace inline spec/plan content with @path refs and revision_block"
```

---

## Phase 2: Router helper changes

### Task 3: Extend build-revision-context for spec/plan stages

**Files:**

- Modify: `router/src/helpers/build-revision-context.ts`
- Modify: `router/test/helpers/build-revision-context.test.ts`

- [ ] **Step 1: Read the current `build-revision-context.ts`**

The helper currently:

1. Fetches issue, PR, and reviews from the adapter
2. Finds the latest REQUEST_CHANGES review
3. Fetches line-level review comments for that review
4. Reads spec + plan files from disk and embeds their full contents
5. Renders `implement-revision-fragment.md` into `revision_block`
6. Writes a context JSON with all fields implement.md needs

For spec/plan stages, the helper needs to:

1. Same: fetch issue, PR, reviews
2. Same: find latest REQUEST_CHANGES review + comments
3. Different: do NOT read full spec/plan contents from disk -- just pass paths
4. Different: render the stage-appropriate fragment (spec or plan)
5. Different: write a context JSON with the fields spec.md or plan.md needs

- [ ] **Step 2: Add `stage` input to the helper**

In `runBuildRevisionContext`, add:

```ts
const stage = core.getInput("stage") || "implement";
```

In `BuildRevisionContextParams`, add:

```ts
stage: "spec" | "plan" | "implement";
```

- [ ] **Step 3: Choose the correct fragment path based on stage**

Replace the hardcoded fragment path fallback:

```ts
// Before:
promptFragmentPath: core.getInput("prompt_fragment_path") || "prompts/implement-revision-fragment.md",

// After:
promptFragmentPath: core.getInput("prompt_fragment_path") || `prompts/${stage}-revision-fragment.md`,
```

- [ ] **Step 4: Stop embedding full spec/plan contents for ALL stages**

In `buildRevisionContext`, replace `composeSpecSource` and `readPlanContents` usage. For all stages, set `spec_file_path` and `plan_file_path` as string paths instead of reading contents.

For implement:

```ts
const contextOut: Record<string, string> = {
  // ... common fields ...
  spec_file_path: params.specFilePath,
  plan_file_path: params.planFilePath,
  // Remove: spec_source, plan_file_contents
  // Keep: revision_block (rendered from implement-revision-fragment.md)
};
```

For spec:

```ts
const contextOut: Record<string, string> = {
  issue_number: String(params.issueNumber),
  issue_title: issue.title,
  issue_body: issue.body ?? "",
  issue_comments: issueComments,
  triage_rationale: "",
  branch_name: params.branchName,
  spec_file_path: params.specFilePath,
  repo_owner: params.repoOwner,
  repo_name: params.repoName,
  revision_block: revisionBlock,
};
```

For plan:

```ts
const contextOut: Record<string, string> = {
  issue_number: String(params.issueNumber),
  issue_title: issue.title,
  issue_body: issue.body ?? "",
  issue_comments: issueComments,
  branch_name: params.branchName,
  plan_file_path: params.planFilePath,
  spec_file_path: params.specFilePath,
  repo_owner: params.repoOwner,
  repo_name: params.repoName,
  revision_block: revisionBlock,
};
```

Use a switch on `params.stage` to pick the right context shape.

- [ ] **Step 5: Update the first-run inline context builders in the YAML to also stop embedding full contents**

This is done in Task 5 (YAML changes). Here in the helper we only change the revision path.

- [ ] **Step 6: Add tests for spec and plan stages**

In `router/test/helpers/build-revision-context.test.ts`, add test cases that:

- Call with `stage: "spec"`, verify `revision_block` is populated from `spec-revision-fragment.md`
- Call with `stage: "plan"`, verify `revision_block` is populated from `plan-revision-fragment.md`
- Call with `stage: "spec"`, verify `spec_source` and `plan_file_contents` are NOT in the output
- Verify the existing implement tests still pass

- [ ] **Step 7: Run tests**

```bash
pnpm test router/test/helpers/build-revision-context.test.ts
pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add router/src/helpers/build-revision-context.ts router/test/helpers/build-revision-context.test.ts
git commit -m "feat(router): extend build-revision-context for spec and plan stages"
```

---

### Task 4: Update first-run inline context builders to use @path refs

**Files:**

- Modify: `router/src/helpers/build-revision-context.ts` (remove `composeSpecSource` and `readPlanContents` dead code)

After Task 3, the revision path no longer uses `composeSpecSource` or `readPlanContents`. However, these functions are still used by the IMPLEMENT first-run inline builder in the YAML (which reads spec/plan contents and passes them to the context JSON). Since we're moving all prompts to @path references, the YAML first-run builders also need to stop embedding contents.

This task cleans up the dead code in the helper. The YAML changes happen in Task 5.

- [ ] **Step 1: Remove `composeSpecSource` and `readPlanContents` from build-revision-context.ts**

These are no longer called by any code path after Task 3.

- [ ] **Step 2: Verify tests still pass**

```bash
pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add router/src/helpers/build-revision-context.ts
git commit -m "refactor(router): remove dead composeSpecSource and readPlanContents"
```

---

## Phase 3: YAML workflow changes

### Task 5: Add revision-mode conditionals to spec job

**Files:**

- Modify: `.github/workflows/shopfloor.yml` (spec job, lines ~304-468)

Mirror the implement job's pattern. The spec job currently has a straight-line execution path. Add `revision_mode` conditionals.

- [ ] **Step 1: Split "Create spec branch" into first-run vs revision**

Replace the single "Create spec branch" step (line 359-364) with two steps:

```yaml
- name: Create spec branch
  if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true'
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git checkout -b "${{ needs.route.outputs.branch_name }}"
- name: Checkout existing spec branch
  if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
  env:
    BRANCH_NAME: ${{ needs.route.outputs.branch_name }}
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git fetch origin "${BRANCH_NAME}"
    git checkout -B "${BRANCH_NAME}" FETCH_HEAD
```

- [ ] **Step 2: Update first-run context builder to use @path refs**

The current "Build spec context" step (lines 365-396) embeds `previous_spec_contents: ""` and `review_comments_json: "[]"`. Update to:

- Add `revision_mode != 'true'` condition
- Remove `previous_spec_contents` and `review_comments_json` fields (no longer in prompt)
- Add `revision_block: ""` (empty on first run)
- Keep `spec_file_path` (already present)

- [ ] **Step 3: Add revision context builder step**

After the first-run context builder, add:

```yaml
- name: Build spec revision context
  id: ctx_revision
  if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
  uses: ./router
  with:
    helper: build-revision-context
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    stage: spec
    issue_number: ${{ needs.route.outputs.issue_number }}
    pr_number: ${{ needs.route.outputs.impl_pr_number }}
    branch_name: ${{ needs.route.outputs.branch_name }}
    spec_file_path: ${{ needs.route.outputs.spec_file_path }}
    plan_file_path: ""
    progress_comment_id: ""
    bash_allowlist: ""
    repo_owner: ${{ github.repository_owner }}
    repo_name: ${{ github.event.repository.name }}
    output_path: ${{ runner.temp }}/context.json
```

NOTE: For spec revision, we need the PR number. The route now emits `branchName` but not a `specPrNumber`. However, `build-revision-context` currently takes `pr_number` as input. We need to either:
(a) Have the route emit a spec PR number
(b) Have the helper look up the PR by branch name

Option (b) is simpler -- add a `findPrByBranch` lookup to the helper if `pr_number` is 0 or empty. Or option (a): extend the route to emit a generic `stage_pr_number`. **Check which approach is simpler by reading how `open-stage-pr` finds existing PRs -- it uses `findOpenPrByHead(branch)`. The helper can do the same.**

For the YAML, pass `pr_number` from the route output. If the route doesn't emit one for spec, the helper must look it up. Address in Task 3's implementation.

- [ ] **Step 4: Add a unified context path resolver**

```yaml
- name: Resolve spec context path
  id: ctx_path
  if: steps.precheck.outputs.skip != 'true'
  env:
    FROM_FIRST_RUN: ${{ steps.ctx.outputs.path }}
    FROM_REVISION: ${{ steps.ctx_revision.outputs.path }}
  run: |
    if [ -n "$FROM_FIRST_RUN" ]; then
      echo "path=$FROM_FIRST_RUN" >> "$GITHUB_OUTPUT"
    else
      echo "path=$FROM_REVISION" >> "$GITHUB_OUTPUT"
    fi
```

Update the "Render spec prompt" step to use `${{ steps.ctx_path.outputs.path }}` instead of `${{ steps.ctx.outputs.path }}`.

- [ ] **Step 5: Commit (do not rebuild dist yet -- that happens in Task 8)**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add spec job revision-mode branch checkout and context builder"
```

---

### Task 6: Add revision-mode conditionals to plan job

**Files:**

- Modify: `.github/workflows/shopfloor.yml` (plan job, lines ~469-643)

Same pattern as Task 5 but for the plan job.

- [ ] **Step 1: Split branch checkout into first-run vs revision**
- [ ] **Step 2: Update first-run context builder to use @path refs** (remove `spec_source` full-content embedding, use `spec_file_path` reference; remove `previous_plan_contents` and `review_comments_json`; add `revision_block: ""`)
- [ ] **Step 3: Add revision context builder step** (call `build-revision-context` with `stage: plan`)
- [ ] **Step 4: Add unified context path resolver**
- [ ] **Step 5: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add plan job revision-mode branch checkout and context builder"
```

---

### Task 7: Update implement job first-run context builder to use @path refs

**Files:**

- Modify: `.github/workflows/shopfloor.yml` (implement job first-run context builder, lines ~829-882)

The implement job's first-run inline `jq` builder currently reads spec/plan files from disk and embeds their contents. Update to pass paths instead.

- [ ] **Step 1: In the "Build implement context" step, replace spec_source and plan_file_contents**

Replace:

```bash
SPEC_SOURCE=$(printf '<spec_file_contents>\n%s\n</spec_file_contents>' "$(cat "$SPEC_FILE_PATH")")
```

With:

```bash
# Prompts now use @path references -- just pass the path, not the contents.
```

In the `jq` call:

- Remove `--arg spec_source "$SPEC_SOURCE"` and `--arg plan_file_contents "$(cat ...)"`
- Add `--arg spec_file_path "$SPEC_FILE_PATH"` and `--arg plan_file_path "$PLAN_FILE_PATH"`
- Keep `revision_block: ""`

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): replace inline spec/plan content with @path refs in implement context"
```

---

## Phase 4: Router state + dist

### Task 8: Emit stage PR number from route for spec/plan revisions

**Files:**

- Modify: `router/src/state.ts` (resolvePullRequestReviewEvent, spec/plan branch)
- Modify: `router/src/helpers/route.ts` (add output)
- Modify: `router/src/types.ts` (add `stagePrNumber` to `RouterDecision` if needed)

The `build-revision-context` helper needs the PR number to fetch reviews. The route currently only emits `implPrNumber` for implement revisions. For spec/plan revisions, the PR number is available from `github.event.pull_request.number` in the event payload.

- [ ] **Step 1: Check if `github.event.pull_request.number` is accessible in the YAML**

For a `pull_request_review` event, `github.event.pull_request.number` IS available. So the YAML can pass it directly to the helper without needing a new route output:

```yaml
pr_number: ${{ github.event.pull_request.number }}
```

If this works, NO router changes are needed for this task. Verify by checking that the YAML `pull_request_review` event context includes `github.event.pull_request.number`.

- [ ] **Step 2: If YAML access works, skip router changes. Otherwise, add a generic `stage_pr_number` to `RouterDecision` and emit it from `resolvePullRequestReviewEvent`.**

- [ ] **Step 3: Rebuild dist**

```bash
pnpm --filter @shopfloor/router build
```

- [ ] **Step 4: Run all tests**

```bash
pnpm test
pnpm -r typecheck
```

- [ ] **Step 5: Commit dist + any router changes**

```bash
git add router/dist/ router/src/
git commit -m "chore(router): rebuild dist with spec/plan revision context support"
```

---

## Phase 5: E2e infrastructure

### Task 9: Update job-graph.ts for spec/plan revision paths

**Files:**

- Modify: `router/test/e2e/harness/job-graph.ts`

Add `spec-revision` and `plan-revision` stage keys (or extend existing spec/plan stages with revision_mode branching). Mirror the YAML changes from Tasks 5-6.

- [ ] **Step 1: Add `spec-revision` stage key to jobGraph**

Following the implement-revision pattern: precheck, advance-state, progress-comment, build-revision-context (with `stage: spec`), render-prompt, agent, finalize-progress-comment.

Actually, spec/plan stages don't have progress comments or advance-state-to-running in revision mode. Re-read the YAML changes from Task 5 to confirm the exact step list. The revision path should be: (reuse existing precheck), (reuse advance-state to spec-running), (revision branch checkout -- no-op in fake), (build-revision-context), render-prompt, agent, (commit+push -- no-op), open-stage-pr (upserts), advance-state to spec-in-review.

- [ ] **Step 2: Update `runStage("spec")` to auto-select first-run vs revision based on `revision_mode`**

Mirror how `runStage("implement")` already picks between `implement-first-run` and `implement-revision`.

- [ ] **Step 3: Do the same for plan**

- [ ] **Step 4: Update the implement-first-run context builder to use path refs instead of embedded contents**

The inline `ctx` step currently reads spec/plan files from disk. Update to pass paths.

- [ ] **Step 5: Run all e2e tests**

```bash
pnpm test:e2e
```

- [ ] **Step 6: Commit**

```bash
git add router/test/e2e/harness/job-graph.ts
git commit -m "test(e2e): mirror spec/plan revision-mode paths in job graph"
```

---

### Task 10: Update spec-rework scenario to verify revision context

**Files:**

- Modify: `router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts`

- [ ] **Step 1: Assert that the revision run populates `revision_block`**

After the second `runStage("spec")`, the harness should have invoked `build-revision-context` with `stage: spec`. The context JSON written to disk should have a non-empty `revision_block` containing the review comments.

Add an assertion that reads the context file and checks `revision_block` is populated.

- [ ] **Step 2: Run**

```bash
pnpm test router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts
pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts
git commit -m "test(e2e): assert revision_block is populated during spec rework"
```

---

## Phase 6: Final verification

### Task 11: Full verification

- [ ] **Step 1: Run the whole test suite**

```bash
pnpm test
```

Expected: all 215+ tests green.

- [ ] **Step 2: Type-check**

```bash
pnpm -r typecheck
```

- [ ] **Step 3: Format check**

```bash
pnpm format:check
```

Fix any formatting issues with `pnpm format`.

- [ ] **Step 4: Verify no prompt template references full-content keys**

```bash
grep -rn "previous_spec_contents\|previous_plan_contents\|plan_file_contents\|spec_source" prompts/
```

Expected: no matches in any prompt template. `spec_file_path` and `plan_file_path` are the only file-related keys.

- [ ] **Step 5: Verify dist is current**

```bash
pnpm --filter @shopfloor/router build
git diff --stat router/dist/
```

If dist changed, commit it.

---

## Commit summary

| #   | Commit message                                                                          |
| --- | --------------------------------------------------------------------------------------- |
| 1   | `feat(prompts): add spec and plan revision fragments`                                   |
| 2   | `feat(prompts): replace inline spec/plan content with @path refs and revision_block`    |
| 3   | `feat(router): extend build-revision-context for spec and plan stages`                  |
| 4   | `refactor(router): remove dead composeSpecSource and readPlanContents`                  |
| 5   | `feat(workflow): add spec job revision-mode branch checkout and context builder`        |
| 6   | `feat(workflow): add plan job revision-mode branch checkout and context builder`        |
| 7   | `feat(workflow): replace inline spec/plan content with @path refs in implement context` |
| 8   | `chore(router): rebuild dist with spec/plan revision context support`                   |
| 9   | `test(e2e): mirror spec/plan revision-mode paths in job graph`                          |
| 10  | `test(e2e): assert revision_block is populated during spec rework`                      |

Plus any fixup commits that surface during iteration.
