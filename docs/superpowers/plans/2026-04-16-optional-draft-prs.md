# Optional Draft PRs with `shopfloor:wip` Label Gate -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `use_draft_prs` workflow input (default `true`) so consumers can opt out of draft PRs, using a `shopfloor:wip` label as the review-suppression gate instead.

**Architecture:** The `shopfloor:wip` label is bootstrapped alongside existing labels. The state machine gains a WIP-label gate on `synchronize`/`ready_for_review` and a new `unlabeled` handler that triggers review when the label is removed. The workflow conditionally opens impl PRs as draft or non-draft and adds/removes the WIP label at the start/end of both first and revision runs. `check-review-skip` gets a parallel defense-in-depth check.

**Tech Stack:** TypeScript, vitest, GitHub Actions YAML, esbuild (dist rebuild)

**Spec:** `docs/superpowers/specs/2026-04-16-optional-draft-prs-design.md`

---

### Task 1: Add `shopfloor:wip` to bootstrap labels and the type union

**Files:**

- Modify: `router/src/helpers/bootstrap-labels.ts:139` (insert new label def before closing `];`)
- Modify: `router/src/types.ts:33` (add to `ShopfloorLabel` union)
- Test: `router/test/helpers/bootstrap-labels.test.ts` (existing test auto-covers; may need assertion bump)

- [ ] **Step 1: Add the label definition to `bootstrap-labels.ts`**

Insert after the `shopfloor:implementing` entry (line 139), before the closing `];`:

```typescript
{
  name: "shopfloor:wip",
  color: "fbca04",
  description:
    "Implementation in progress. Suppresses review triggers until removed.",
},
```

- [ ] **Step 2: Add `"shopfloor:wip"` to the `ShopfloorLabel` union in `types.ts`**

Insert after `"shopfloor:implementing"` (line 33):

```typescript
| "shopfloor:wip"
```

- [ ] **Step 3: Run the bootstrap-labels test to verify**

Run: `pnpm test -- router/test/helpers/bootstrap-labels.test.ts`

The existing test asserts `created.length >= 18`. With the new label, the count goes up by 1. The test should still pass since it uses `>=`. If it fails, bump the assertion to `>= 19`.

- [ ] **Step 4: Commit**

```
feat(labels): add shopfloor:wip to bootstrap label definitions
```

---

### Task 2: Add `label` field to `PullRequestPayload`

**Files:**

- Modify: `router/src/types.ts:68-81` (add optional `label` field)

- [ ] **Step 1: Add the `label` field to `PullRequestPayload`**

In `router/src/types.ts`, the `PullRequestPayload` interface starts at line 68. Add `label?: { name: string };` after the `action` field:

```typescript
export interface PullRequestPayload {
  action: string;
  label?: { name: string };
  pull_request: {
    number: number;
    body: string | null;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    labels: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string };
}
```

- [ ] **Step 2: Run typecheck to verify**

Run: `pnpm exec tsc --noEmit`
Expected: no new errors (field is optional, so all existing code is unaffected)

- [ ] **Step 3: Commit**

```
feat(types): add label field to PullRequestPayload for unlabeled events
```

---

### Task 3: State machine -- WIP label gate on `synchronize`/`ready_for_review`

**Files:**

- Modify: `router/src/state.ts:393-410`
- Test: `router/test/state.test.ts`
- Create: `router/test/fixtures/events/pr-synchronize-impl-wip.json`

- [ ] **Step 1: Create the `pr-synchronize-impl-wip.json` fixture**

Create `router/test/fixtures/events/pr-synchronize-impl-wip.json`. Copy from `pr-synchronize-impl.json` and add `"shopfloor:wip"` to the labels array:

```json
{
  "action": "synchronize",
  "pull_request": {
    "number": 45,
    "body": "Implementation for #42.\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
    "state": "open",
    "draft": false,
    "merged": false,
    "head": {
      "ref": "shopfloor/impl/42-github-oauth-login",
      "sha": "abcdef0000000000000000000000000000000000"
    },
    "base": {
      "ref": "main",
      "sha": "1234567890abcdef1234567890abcdef12345678"
    },
    "labels": [
      { "name": "shopfloor:needs-review" },
      { "name": "shopfloor:wip" }
    ]
  },
  "repository": {
    "owner": { "login": "niranjan94" },
    "name": "shopfloor"
  }
}
```

- [ ] **Step 2: Write the failing test for WIP gate**

Add to `router/test/state.test.ts` inside the `describe("resolveStage")` block, after the `"draft impl PR -> none"` test (line 137):

```typescript
test("synchronize on impl PR with shopfloor:wip label -> none", () => {
  const decision = resolveStage(ctx("pull_request", "pr-synchronize-impl-wip"));
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("pr_has_wip_label");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- router/test/state.test.ts`
Expected: FAIL -- the new test returns `stage: "review"` because the WIP gate does not exist yet.

- [ ] **Step 4: Add the WIP label check to `resolvePullRequestEvent` in `state.ts`**

In `router/src/state.ts`, inside the `synchronize`/`ready_for_review` handler (lines 393-410), add the WIP check after the `pr.draft` check at line 402:

```typescript
if (pr.draft) return { stage: "none", reason: "pr_is_draft" };
if (labels.has("shopfloor:wip"))
  return { stage: "none", reason: "pr_has_wip_label" };
```

The `labels` variable is already computed at line 398 (via `prLabelSet(pr)`). The new line goes between the existing `pr.draft` check (line 402) and the `pr.state === "closed"` check (line 403).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- router/test/state.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
feat(state): gate synchronize/ready_for_review on shopfloor:wip label
```

---

### Task 4: State machine -- `unlabeled` handler for impl PRs

**Files:**

- Modify: `router/src/state.ts:370-416`
- Test: `router/test/state.test.ts`
- Create: `router/test/fixtures/events/pr-unlabeled-wip-impl.json`

- [ ] **Step 1: Create the `pr-unlabeled-wip-impl.json` fixture**

Create `router/test/fixtures/events/pr-unlabeled-wip-impl.json`:

```json
{
  "action": "unlabeled",
  "label": { "name": "shopfloor:wip" },
  "pull_request": {
    "number": 45,
    "body": "Implementation for #42.\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
    "state": "open",
    "draft": false,
    "merged": false,
    "head": {
      "ref": "shopfloor/impl/42-github-oauth-login",
      "sha": "abcdef0000000000000000000000000000000000"
    },
    "base": {
      "ref": "main",
      "sha": "1234567890abcdef1234567890abcdef12345678"
    },
    "labels": [{ "name": "shopfloor:needs-review" }]
  },
  "repository": {
    "owner": { "login": "niranjan94" },
    "name": "shopfloor"
  }
}
```

Note: `labels` does NOT include `shopfloor:wip` -- GitHub removes the label from the array before delivering the `unlabeled` event. The removed label is in the top-level `label` field.

- [ ] **Step 2: Write the failing tests**

Add to `router/test/state.test.ts` inside `describe("resolveStage")`, after the test from Task 3:

```typescript
test("unlabeled shopfloor:wip on impl PR -> review", () => {
  const decision = resolveStage(ctx("pull_request", "pr-unlabeled-wip-impl"));
  expect(decision.stage).toBe("review");
  expect(decision.issueNumber).toBe(42);
  expect(decision.implPrNumber).toBe(45);
  expect(decision.reviewIteration).toBe(0);
});

test("unlabeled shopfloor:wip on draft impl PR -> none", () => {
  const fixture = JSON.parse(
    JSON.stringify(loadFixture("pr-unlabeled-wip-impl")),
  ) as Record<string, unknown>;
  (fixture.pull_request as Record<string, unknown>).draft = true;
  const decision = resolveStage({
    eventName: "pull_request",
    payload: fixture as StateContext["payload"],
  });
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("pr_is_draft");
});

test("unlabeled shopfloor:wip on closed impl PR -> none", () => {
  const fixture = JSON.parse(
    JSON.stringify(loadFixture("pr-unlabeled-wip-impl")),
  ) as Record<string, unknown>;
  (fixture.pull_request as Record<string, unknown>).state = "closed";
  const decision = resolveStage({
    eventName: "pull_request",
    payload: fixture as StateContext["payload"],
  });
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("pr_is_closed");
});

test("unlabeled shopfloor:wip on impl PR with skip-review -> none", () => {
  const fixture = JSON.parse(
    JSON.stringify(loadFixture("pr-unlabeled-wip-impl")),
  ) as Record<string, unknown>;
  const pr = fixture.pull_request as Record<string, unknown>;
  pr.labels = [{ name: "shopfloor:skip-review" }];
  const decision = resolveStage({
    eventName: "pull_request",
    payload: fixture as StateContext["payload"],
  });
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("skip_review_label_present");
});

test("unlabeled non-wip label on impl PR -> none", () => {
  const fixture = JSON.parse(
    JSON.stringify(loadFixture("pr-unlabeled-wip-impl")),
  ) as Record<string, unknown>;
  (fixture as Record<string, unknown>).label = { name: "some-other-label" };
  const decision = resolveStage({
    eventName: "pull_request",
    payload: fixture as StateContext["payload"],
  });
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("pr_action_unlabeled_on_implement_no_action");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- router/test/state.test.ts`
Expected: FAIL -- the `unlabeled` action has no handler yet, so all five tests hit the catch-all.

- [ ] **Step 4: Add the `unlabeled` handler to `resolvePullRequestEvent`**

In `router/src/state.ts`, inside `resolvePullRequestEvent`, add a new block BEFORE the existing `synchronize`/`ready_for_review` block (before line 393). This ensures `unlabeled` with `shopfloor:wip` on impl PRs routes to review:

```typescript
// WIP label removal on an impl PR triggers review -- the non-draft
// equivalent of ready_for_review. Non-WIP unlabeled events fall
// through to the catch-all and return stage: "none".
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

Note: `resolvePullRequestEvent` already types `payload` as `PullRequestPayload` (line 370). After Task 2 adds the `label` field to `PullRequestPayload`, `payload.label?.name` works directly with no cast needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- router/test/state.test.ts`
Expected: PASS for all 6 new tests (1 from Task 3 + 5 from this task) plus all existing tests.

- [ ] **Step 6: Commit**

```
feat(state): add unlabeled handler for shopfloor:wip on impl PRs
```

---

### Task 5: `check-review-skip` -- WIP label gate

**Files:**

- Modify: `router/src/helpers/check-review-skip.ts:21`
- Test: `router/test/helpers/check-review-skip.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `router/test/helpers/check-review-skip.test.ts` inside the `describe("checkReviewSkip")` block, after the `"skip=true when PR has shopfloor:skip-review label"` test:

```typescript
test("skip=true when PR has shopfloor:wip label", async () => {
  const bundle = makeMockAdapter();
  primePrFixture(bundle, { labels: [{ name: "shopfloor:wip" }] });
  const result = await checkReviewSkip(bundle.adapter, 45);
  expect(result.skip).toBe(true);
  expect(result.reason).toBe("pr_wip_label");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- router/test/helpers/check-review-skip.test.ts`
Expected: FAIL -- `skip` is `false` because no WIP check exists yet.

- [ ] **Step 3: Add the WIP check to `check-review-skip.ts`**

In `router/src/helpers/check-review-skip.ts`, after line 21 (`if (pr.draft) return { skip: true, reason: "pr_draft" };`), add:

```typescript
if (pr.labels.some((l) => l.name === "shopfloor:wip")) {
  return { skip: true, reason: "pr_wip_label" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- router/test/helpers/check-review-skip.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```
feat(review-skip): check shopfloor:wip in check-review-skip
```

---

### Task 6: Workflow -- `use_draft_prs` input and conditional steps

**Files:**

- Modify: `.github/workflows/shopfloor.yml`

This task is pure YAML. No TypeScript tests cover the workflow directly -- correctness is verified by the e2e harness in Task 7 and by reading the diff.

- [ ] **Step 1: Add the `use_draft_prs` input**

In `.github/workflows/shopfloor.yml`, inside the `inputs:` block (after `display_report` at line 61), add:

```yaml
use_draft_prs:
  type: boolean
  default: true
  description: >-
    When true (default), implementation PRs are opened as drafts and
    un-drafted when the agent finishes. When false, a shopfloor:wip label
    is used instead to suppress premature reviews. Callers that set this
    to false MUST include 'unlabeled' in their pull_request event types.
```

- [ ] **Step 2: Conditional draft on `open_pr` step**

Change line 825 from:

```yaml
draft: "true"
```

to:

```yaml
draft: ${{ inputs.use_draft_prs && 'true' || 'false' }}
```

- [ ] **Step 3: Add "Add WIP label" step for first runs**

After the `open_pr` step (after line 825), add:

```yaml
- name: Add WIP label to impl PR
  if: ${{ steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true' && !inputs.use_draft_prs }}
  env:
    GH_TOKEN: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
    PR_NUMBER: ${{ steps.open_pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --add-label "shopfloor:wip"
```

- [ ] **Step 4: Add "Add WIP label" step for revision runs**

After the "Resolve unified impl PR number" step (after line 853), add:

```yaml
- name: Add WIP label to impl PR (revision)
  if: ${{ steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true' && !inputs.use_draft_prs }}
  env:
    GH_TOKEN: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --add-label "shopfloor:wip"
```

- [ ] **Step 5: Gate the existing "Mark impl PR ready for review" step on draft mode**

The existing step at line 1061 has this condition:

```yaml
if: ${{ success() && steps.app_token_post.outputs.token != '' && steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true' }}
```

Add `&& inputs.use_draft_prs` to the end:

```yaml
if: ${{ success() && steps.app_token_post.outputs.token != '' && steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true' && inputs.use_draft_prs }}
```

- [ ] **Step 6: Add "Remove WIP label" step after push**

Immediately after the "Mark impl PR ready for review" step (line 1067), add:

```yaml
# WIP-label equivalent of the draft -> ready transition above.
# Runs on BOTH first and revision runs (no revision_mode gate).
# Must use the App token: events from GITHUB_TOKEN are suppressed
# and the unlabeled event is the review trigger in non-draft mode.
- name: Remove WIP label from impl PR
  if: ${{ success() && steps.app_token_post.outputs.token != '' && steps.precheck.outputs.skip != 'true' && !inputs.use_draft_prs }}
  env:
    GH_TOKEN: ${{ steps.app_token_post.outputs.token }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
    REPO_SLUG: ${{ github.repository }}
  run: gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --remove-label "shopfloor:wip"
```

- [ ] **Step 7: Update the comment block above the undraft step**

Update the comment block above "Mark impl PR ready for review" (lines 1050-1060) to mention the WIP alternative. Replace the block with:

```yaml
# The impl PR was opened as a draft (or had shopfloor:wip applied)
# so nothing reviews it mid-run. Now that the agent has finished and
# the final commits are pushed, either un-draft the PR or remove the
# WIP label, depending on the use_draft_prs input. This fires
# pull_request.ready_for_review (draft mode) or
# pull_request.unlabeled (WIP mode), which the state machine
# translates into stage=review.
# Only first runs need to un-draft the PR; on revision runs the PR
# is already ready-for-review. The WIP label removal runs on both
# first and revision runs since the label is added at the start of
# every run.
```

- [ ] **Step 8: Commit**

```
feat(workflow): add use_draft_prs input with shopfloor:wip fallback
```

---

### Task 7: E2E harness -- WIP mode support in job graph

**Files:**

- Modify: `router/test/e2e/harness/job-graph.ts:57-69` (`StageContext` type)
- Modify: `router/test/e2e/harness/job-graph.ts:589-601` (`implement-first-run` graph)
- Modify: `router/test/e2e/harness/job-graph.ts:670-684` (`mark_ready` fake step)
- Modify: `router/test/e2e/harness/job-graph.ts:708-826` (`implement-revision` graph)
- Modify: `router/test/e2e/harness/scenario-harness.ts:46-68,198-208` (plumb config)
- Create: `router/test/e2e/scenarios/quick-happy-path-wip.test.ts`

The harness and job-graph must be wired up FIRST (Steps 1-2) before any graph steps reference `ctx.useDraftPrs`. Otherwise existing tests break because `ctx.useDraftPrs` is `undefined` (falsy) in `makeStageContext`, causing the `open_pr` step to always pass `draft: "false"`.

- [ ] **Step 1: Add `useDraftPrs` to `StageContext` interface**

In `router/test/e2e/harness/job-graph.ts`, add to the `StageContext` interface (line 57):

```typescript
export interface StageContext {
  fake: FakeGitHub;
  routeOutputs: Record<string, string>;
  previous: Record<string, Record<string, string>>;
  workspaceDir: string;
  currentEvent: { eventName: string; payload: unknown } | null;
  /** When false, the harness uses shopfloor:wip labels instead of draft PRs. Defaults to true. */
  useDraftPrs: boolean;
}
```

- [ ] **Step 2: Plumb `useDraftPrs` through ScenarioHarness**

This MUST happen before any graph steps reference `ctx.useDraftPrs`, or existing tests break.

In `router/test/e2e/harness/scenario-harness.ts`:

(a) Add a `useDraftPrs` field to the class and accept it in the constructor opts. Change the constructor signature (line 55) to:

```typescript
constructor(opts: { fake: FakeGitHub; workspaceDir?: string; useDraftPrs?: boolean }) {
```

Add the field declaration alongside the existing fields:

```typescript
readonly useDraftPrs: boolean;
```

Initialize it in the constructor body:

```typescript
this.useDraftPrs = opts.useDraftPrs ?? true;
```

(b) Pass it into `makeStageContext` (line 198-208). Add `useDraftPrs: this.useDraftPrs` to the returned object:

```typescript
private makeStageContext(
  previous: Record<string, Record<string, string>>,
): StageContext {
  return {
    fake: this.fake,
    routeOutputs: this.routeOutputs,
    previous,
    workspaceDir: this.workspaceDir,
    currentEvent: this.currentEvent,
    useDraftPrs: this.useDraftPrs,
  };
}
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `pnpm test -- router/test/e2e`
Expected: PASS -- existing tests still work because `useDraftPrs` defaults to `true`, and `StageContext.useDraftPrs` is now always set.

- [ ] **Step 4: Conditional draft on `open_pr` step in `implement-first-run`**

In `router/test/e2e/harness/job-graph.ts`, change the `draft` input of the `open_pr` helper step (line 600) from:

```typescript
draft: { source: "literal", value: "true" },
```

to:

```typescript
draft: { source: "fake", resolve: (ctx) => ctx.useDraftPrs ? "true" : "false" },
```

- [ ] **Step 5: Add WIP label fake step after `open_pr` in `implement-first-run`**

After the `open_pr` step in `implement-first-run` (after line 601), insert a new fake step:

```typescript
{
  kind: "fake",
  id: "add_wip_label",
  mutate: (ctx) => {
    if (ctx.useDraftPrs) return;
    const prNumberStr = ctx.previous.open_pr?.pr_number;
    if (!prNumberStr) return;
    const prNumber = Number(prNumberStr);
    const pr = ctx.fake.pr(prNumber);
    pr.labels.push({ name: "shopfloor:wip" });
  },
},
```

- [ ] **Step 6: Update `mark_ready` fake step in `implement-first-run`**

Replace the `mark_ready` fake step (lines 670-684) with:

```typescript
{
  kind: "fake",
  id: "mark_ready",
  mutate: (ctx) => {
    const prNumberStr = ctx.previous.open_pr?.pr_number;
    if (!prNumberStr) return;
    const prNumber = Number(prNumberStr);
    const pr = ctx.fake.pr(prNumber);
    if (ctx.useDraftPrs) {
      // Draft mode: mirror `gh pr ready`
      pr.draft = false;
    } else {
      // WIP mode: mirror `gh pr edit --remove-label shopfloor:wip`
      pr.labels = pr.labels.filter((l) => l.name !== "shopfloor:wip");
    }
  },
},
```

- [ ] **Step 7: Add WIP label add/remove steps to `implement-revision` graph**

The spec requires symmetric behavior: the WIP label is added at the start AND removed at the end of revision runs too. The `implement-revision` graph currently has no draft/WIP manipulation (the PR is already non-draft on revisions).

In `router/test/e2e/harness/job-graph.ts`, in the `implement-revision` graph:

(a) After the `advance-state` step (line 728) and before the `progress` step (line 732), insert a WIP label add step:

```typescript
{
  kind: "fake",
  id: "add_wip_label_revision",
  mutate: (ctx) => {
    if (ctx.useDraftPrs) return;
    const prNumberStr = ctx.routeOutputs.impl_pr_number;
    if (!prNumberStr) return;
    const prNumber = Number(prNumberStr);
    const pr = ctx.fake.pr(prNumber);
    // Only add if not already present (idempotent)
    if (!pr.labels.some((l) => l.name === "shopfloor:wip")) {
      pr.labels.push({ name: "shopfloor:wip" });
    }
  },
},
```

(b) After the `push_files_revision` fake step (line 805) and before `finalize-progress-comment` (line 807), insert a WIP label removal step:

```typescript
{
  kind: "fake",
  id: "mark_ready_revision",
  mutate: (ctx) => {
    if (ctx.useDraftPrs) return;
    const prNumberStr = ctx.routeOutputs.impl_pr_number;
    if (!prNumberStr) return;
    const prNumber = Number(prNumberStr);
    const pr = ctx.fake.pr(prNumber);
    pr.labels = pr.labels.filter((l) => l.name !== "shopfloor:wip");
  },
},
```

Note: revision runs use `ctx.routeOutputs.impl_pr_number` (not `ctx.previous.open_pr?.pr_number`) because no `open_pr` step runs on revision.

- [ ] **Step 8: Run existing e2e tests again to verify no regression**

Run: `pnpm test -- router/test/e2e`
Expected: PASS -- all steps are no-ops when `useDraftPrs` is `true` (the default).

- [ ] **Step 9: Create `quick-happy-path-wip.test.ts`**

Create `router/test/e2e/scenarios/quick-happy-path-wip.test.ts`. Based on `quick-happy-path.test.ts` with these key differences:

1. Describe block renamed to `"quick happy path (WIP mode)"`.
2. `useDraftPrs: false` passed to `ScenarioHarness`.
3. After `runStage("implement")`, assert the PR is NOT draft and the WIP label has been removed.
4. The review trigger uses `pr-unlabeled-wip-impl.json` -- NOT `pr-synchronize-impl.json` or `pr-ready-for-review-impl.json`. In production WIP mode, `synchronize` fires while the WIP label is still present (suppressed), and `unlabeled` is the canonical event that triggers review. The test must exercise the `unlabeled` code path.

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("quick happy path (WIP mode)", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake, useDraftPrs: false });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "Add foo",
      body: "Need foo.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage -> implement -> review approved -> merge -> done", async () => {
    // 1. Triage
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "quick",
        rationale: "single-file fix",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");
    expect(fake.labelsOn(42)).toContain("shopfloor:quick");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");

    // 2. Implement
    const implRouteOutputs = await harness.deliverEvent(
      loadEvent("issue-labeled-needs-impl.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    const implBranch = implRouteOutputs.branch_name;
    if (!implBranch) {
      throw new Error("expected route to emit branch_name for implement stage");
    }
    fake.seedBranch(implBranch, "sha-impl-0");

    harness.queueAgent("implement", {
      pr_title: "feat: add foo",
      pr_body: "Implements foo as requested.",
      summary_for_issue_comment: "Done.",
      changed_files: JSON.stringify(["src/foo.ts"]),
    });
    await harness.runStage("implement");
    const implPr = fake.openPrs().find((p) => p.head.ref === implBranch);
    expect(implPr).toBeDefined();
    // In WIP mode, PR should NOT be draft
    expect(implPr!.draft).toBe(false);
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:implementing");
    // WIP label should have been removed after impl
    expect(implPr!.labels.some((l) => l.name === "shopfloor:wip")).toBe(false);

    const implPrAfter = fake.pr(implPr!.number);
    expect(implPrAfter.body).toContain("Shopfloor-Issue: #42");
    expect(implPrAfter.body).toContain("Shopfloor-Stage: implement");

    // 3. Review -- in WIP mode, the canonical trigger is pull_request.unlabeled
    // with label.name === "shopfloor:wip". In production, the push fires
    // synchronize while the WIP label is still present (suppressed), then
    // the label removal fires unlabeled which routes to review. We must
    // exercise the unlabeled code path here.
    await harness.deliverEvent(
      loadEvent("pr-unlabeled-wip-impl.json", {
        prNumber: implPr!.number,
        sha: implPrAfter.head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueReviewAgents({
      compliance: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      bugs: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      security: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
      smells: {
        output: JSON.stringify({
          verdict: "clean",
          summary: "ok",
          comments: [],
        }),
      },
    });
    await harness.runStage("review");
    expect(fake.labelsOn(42)).toContain("shopfloor:review-approved");

    // 4. Merge
    fake.mergePr(implPr!.number, implPrAfter.head.sha);
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-impl.json", {
        issueNumber: 42,
        prNumber: implPr!.number,
        sha: implPrAfter.head.sha,
      }),
      { trigger_label: "shopfloor:enabled" },
    );
    await harness.runStage("handle-merge");
    expect(fake.issue(42).state).toBe("closed");
    expect(fake.labelsOn(42)).toContain("shopfloor:done");

    expect(fake.snapshot()).toMatchSnapshot();
  });
});
```

- [ ] **Step 10: Run the e2e tests**

Run: `pnpm test -- router/test/e2e/scenarios/quick-happy-path-wip.test.ts`
Expected: PASS (snapshot will be created on first run)

Also run the original to ensure no regression:
Run: `pnpm test -- router/test/e2e/scenarios/quick-happy-path.test.ts`
Expected: PASS (existing snapshot unchanged)

Run all e2e tests:
Run: `pnpm test -- router/test/e2e`
Expected: PASS

- [ ] **Step 11: Commit**

```
test(e2e): support WIP mode in job-graph harness and add quick-happy-path-wip scenario
```

---

### Task 8: Documentation -- install guide and FAQ

**Files:**

- Modify: `docs/shopfloor/install.md:216`
- Modify: `docs/shopfloor/FAQ.md:61`

- [ ] **Step 1: Add "Disabling draft PRs" section to install.md**

In `docs/shopfloor/install.md`, after line 216 (the end of the "GitHub App for reviews" section, before `## Troubleshooting`), add:

````markdown
## Disabling draft PRs

By default, Shopfloor opens implementation PRs as drafts and un-drafts them when the agent finishes. If your organization disallows or prefers not to use draft PRs, set `use_draft_prs: false`:

```yaml
jobs:
  shopfloor:
    uses: your-org/shopfloor/.github/workflows/shopfloor.yml@main
    with:
      use_draft_prs: false
```
````

When disabled, Shopfloor applies a `shopfloor:wip` label to the impl PR during agent work and removes it when done. The label suppresses premature reviews the same way draft status does.

**Required:** your caller workflow must subscribe to `pull_request` `unlabeled` events, or the review pipeline will never trigger:

```yaml
on:
  pull_request:
    types: [opened, synchronize, closed, unlabeled, ready_for_review]
```

````

- [ ] **Step 2: Add FAQ entry**

In `docs/shopfloor/FAQ.md`, after the "How do I pause the pipeline?" section (after line 61), add:

```markdown
## Can I use regular (non-draft) PRs instead of drafts?

Yes. Set `use_draft_prs: false` in your caller workflow's `with:` block. Shopfloor will use a `shopfloor:wip` label to suppress reviews during agent work instead of draft status. Make sure your caller workflow subscribes to `pull_request: types: [unlabeled]` or the review pipeline will not trigger after implementation completes. See [install.md](install.md#disabling-draft-prs) for details.
````

- [ ] **Step 3: Commit**

```
docs: document use_draft_prs option in install guide and FAQ
```

---

### Task 9: Rebuild dist and final verification

**Files:**

- Modify: `router/dist/index.cjs` (auto-generated)

- [ ] **Step 1: Rebuild the dist bundle**

Run: `pnpm --filter @shopfloor/router build`
Expected: exits 0, `router/dist/index.cjs` is updated

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (unit, helper, e2e)

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: no errors

- [ ] **Step 4: Run format check**

Run: `pnpm format:check`
If it fails, run `pnpm format` first, then re-run `pnpm format:check`.

- [ ] **Step 5: Commit the dist**

```
chore(router): rebuild dist
```

- [ ] **Step 6: Run `pnpm format` if not already done**

Run: `pnpm format`
If any files changed, commit:

```
style: apply prettier formatting
```
