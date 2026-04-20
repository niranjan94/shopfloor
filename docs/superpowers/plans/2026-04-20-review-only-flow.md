# Review-Only Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Shopfloor run its four-reviewer + aggregator review matrix on PRs that were NOT created by Shopfloor's implement stage (human-contributor PRs), driven by a new reusable workflow `shopfloor-review.yml` and dogfooded in this repo via `.github/workflows/dogfood-review.yml`.

**Architecture:** A second reusable workflow, separate from `shopfloor.yml`, listens to `pull_request` events and runs the review chain only. The router gets a `review_only` mode that returns `stage:"review"` for PRs without Shopfloor metadata and `stage:"none"` for Shopfloor-managed PRs (so the full pipeline keeps owning them). `aggregate-review.ts` is generalised so the label target falls back to the PR number when there is no origin issue, and the review-iteration PR-body footer is inserted on first REQUEST_CHANGES instead of required-up-front. Spec of record: `docs/shopfloor/specs/15-feat-support-a-review-only.md`.

**Tech Stack:** TypeScript (router action, esbuild → `router/dist/index.cjs`), GitHub Actions reusable workflows, vitest for router tests, pnpm monorepo.

---

## File Structure

**New files:**

- `.github/workflows/shopfloor-review.yml` — reusable review-only workflow (route, review-skip-check, review-compliance, review-bugs, review-security, review-smells, review-aggregator).
- `.github/workflows/dogfood-review.yml` — this repo's caller for `shopfloor-review.yml`, so we dogfood the new workflow on PRs in `niranjan94/shopfloor` itself.

**Modified files:**

- `router/src/state.ts` — add `resolveReviewOnly`.
- `router/src/helpers/route.ts` — read `review_only` input; dispatch to `resolveReviewOnly`.
- `router/src/helpers/aggregate-review.ts` — make `issueNumber` optional; add `labelTarget` fallback; switch `writeIterationToBody` from throw-on-missing to insert-on-missing.
- `router/src/helpers/check-review-skip.ts` — no code change expected; verified via new test (see Task 4).
- `router/action.yml` — add `review_only` input.
- `router/dist/index.cjs` (+ `.map`) — rebuilt from source (committed per project convention).
- `router/test/state.test.ts` — tests for `resolveReviewOnly`.
- `router/test/helpers/route.test.ts` — test that `review_only=true` dispatches to the new function.
- `router/test/helpers/aggregate-review.test.ts` — tests for optional `issueNumber`, PR-as-label-target, insert-on-missing.
- `router/test/helpers/check-review-skip.test.ts` — test for null-origin-issue fall-through.
- `docs/shopfloor/configuration.md` — new "Review-only workflow" section.
- `docs/shopfloor/install.md` — mention the review-only caller pattern.

---

## Conventional Commits for This Plan

Track progress by completing these commits in order (one per task group):

1. `test(router): add failing resolveReviewOnly tests`
2. `feat(router): add resolveReviewOnly for non-shopfloor PRs`
3. `feat(router): dispatch to resolveReviewOnly when review_only input is set`
4. `test(router): cover null origin issue path in checkReviewSkip`
5. `refactor(router): make aggregate-review issueNumber optional and insert iteration footer on missing`
6. `feat(workflow): add shopfloor-review.yml reusable review-only workflow`
7. `chore(workflow): dogfood shopfloor-review.yml via dogfood-review.yml`
8. `docs(configuration): document review-only workflow`
9. `chore(router): rebuild dist`

Group boundaries are marked as "Commit" steps inside each task. Do NOT add `Co-Authored-By` trailers.

---

## Task 1: Add failing tests for `resolveReviewOnly`

**Files:**

- Modify: `router/test/state.test.ts` — append a new `describe("resolveReviewOnly", ...)` block.

**Why TDD here:** `resolveReviewOnly` is pure state logic; tests nail down the decision table before we touch `state.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `router/test/state.test.ts` (keep existing imports; add `resolveReviewOnly` to the state import):

```typescript
import {
  branchSlug,
  parseIssueMetadata,
  resolveReviewOnly,
  resolveStage,
} from "../src/state";
import type { PullRequestPayload } from "../src/types";

function prPayload(
  overrides: Partial<PullRequestPayload["pull_request"]> = {},
  action = "synchronize",
): PullRequestPayload {
  return {
    action,
    pull_request: {
      number: 77,
      body: null,
      state: "open",
      draft: false,
      merged: false,
      head: { ref: "feature/x", sha: "abc" },
      base: { ref: "main", sha: "def" },
      labels: [],
      ...overrides,
    },
    repository: { owner: { login: "o" }, name: "r" },
  } as PullRequestPayload;
}

describe("resolveReviewOnly", () => {
  test("human PR with no Shopfloor metadata -> review, iteration 0", () => {
    const decision = resolveReviewOnly(prPayload());
    expect(decision.stage).toBe("review");
    expect(decision.implPrNumber).toBe(77);
    expect(decision.reviewIteration).toBe(0);
  });

  test("PR carrying Shopfloor metadata -> none (full pipeline owns it)", () => {
    const decision = resolveReviewOnly(
      prPayload({
        body: "Shopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 1",
      }),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_has_shopfloor_metadata_use_full_pipeline");
  });

  test("draft PR -> none", () => {
    const decision = resolveReviewOnly(prPayload({ draft: true }));
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_is_draft");
  });

  test("closed PR -> none", () => {
    const decision = resolveReviewOnly(prPayload({ state: "closed" }));
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_is_closed");
  });

  test("PR with shopfloor:skip-review label -> none", () => {
    const decision = resolveReviewOnly(
      prPayload({ labels: [{ name: "shopfloor:skip-review" }] }),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("skip_review_label_present");
  });

  test("PR with existing review-iteration footer resumes at that number", () => {
    const decision = resolveReviewOnly(
      prPayload({
        body: "Thanks for reviewing.\n\nShopfloor-Review-Iteration: 2\n",
      }),
    );
    expect(decision.stage).toBe("review");
    expect(decision.reviewIteration).toBe(2);
    expect(decision.implPrNumber).toBe(77);
  });

  test("unlabeled shopfloor:skip-review event on otherwise-eligible PR -> review", () => {
    // The consumer wants to re-enable reviews after marking skip-review; the
    // unlabel event fires with labels already removed from pr.labels, so this
    // is just the happy path with no blocking label. Cover it to document the
    // expectation that re-enabling works immediately.
    const decision = resolveReviewOnly(prPayload({ labels: [] }, "unlabeled"));
    expect(decision.stage).toBe("review");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @shopfloor/router test -- --run state`

Expected: All new cases fail with `SyntaxError` / `resolveReviewOnly is not a function` (or tsc failure from the import). That is the expected pre-implementation state.

- [ ] **Step 3: Commit**

```bash
git add router/test/state.test.ts
git commit -m "test(router): add failing resolveReviewOnly tests"
```

---

## Task 2: Implement `resolveReviewOnly`

**Files:**

- Modify: `router/src/state.ts` — add the new exported function near the other resolvers.

- [ ] **Step 1: Add the function**

Add to `router/src/state.ts` (after `resolvePullRequestReviewEvent` or near the other pull-request resolvers):

```typescript
export function resolveReviewOnly(
  payload: PullRequestPayload,
): RouterDecision {
  const pr = payload.pull_request;

  // PRs authored by the full Shopfloor pipeline carry metadata. Let the
  // full pipeline handle them; this workflow is for human-author PRs only.
  const meta = parsePrMetadata(pr.body);
  if (meta) {
    return {
      stage: "none",
      reason: "pr_has_shopfloor_metadata_use_full_pipeline",
    };
  }

  if (pr.state === "closed") {
    return { stage: "none", reason: "pr_is_closed" };
  }
  if (pr.draft) {
    return { stage: "none", reason: "pr_is_draft" };
  }
  if (prLabelSet(pr).has("shopfloor:skip-review")) {
    return { stage: "none", reason: "skip_review_label_present" };
  }

  // First review cycle starts at 0; subsequent runs read the footer that
  // aggregate-review appends on the first REQUEST_CHANGES.
  const iterMatch = pr.body?.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  const reviewIteration = iterMatch ? Number(iterMatch[1]) : 0;

  return {
    stage: "review",
    implPrNumber: pr.number,
    reviewIteration,
  };
}
```

Notes:

- Uses the existing `prLabelSet` and `parsePrMetadata` helpers.
- Intentionally does NOT set `issueNumber`. Downstream consumers must treat its absence as "no linked Shopfloor issue — operate on PR".
- The `reviewIteration` regex is local rather than calling `parsePrMetadata` because that helper requires `Shopfloor-Issue` AND `Shopfloor-Stage`; here only the iteration footer is relevant.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm --filter @shopfloor/router test -- --run state`

Expected: All seven new cases pass. Existing tests still pass.

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add router/src/state.ts
git commit -m "feat(router): add resolveReviewOnly for non-shopfloor PRs"
```

---

## Task 3: Wire `review_only` into `runRoute` and `action.yml`

**Files:**

- Modify: `router/src/helpers/route.ts`
- Modify: `router/action.yml`
- Modify: `router/test/helpers/route.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `router/test/helpers/route.test.ts` (inside the outer `describe("runRoute", ...)`):

```typescript
describe("review_only mode", () => {
  beforeEach(() => {
    (context as unknown as { eventName: string }).eventName = "pull_request";
    (context as unknown as { payload: unknown }).payload = {
      action: "synchronize",
      pull_request: {
        number: 77,
        body: null,
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "feature/x", sha: "abc" },
        base: { ref: "main", sha: "def" },
        labels: [],
      },
      repository: { owner: { login: "o" }, name: "r" },
    };
  });

  test("review_only=true dispatches to resolveReviewOnly", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "review_only") return "true";
      if (name === "trigger_label") return "";
      return "";
    });
    const bundle = makeMockAdapter();
    await runRoute(bundle.adapter);
    expect(setOutput).toHaveBeenCalledWith("stage", "review");
    expect(setOutput).toHaveBeenCalledWith("impl_pr_number", "77");
    // Crucially: no issueNumber is emitted because human PRs have no linked
    // Shopfloor issue. Downstream jobs pass PR number as issue_number instead.
    expect(setOutput).not.toHaveBeenCalledWith(
      "issue_number",
      expect.anything(),
    );
  });

  test("review_only not set -> falls through to resolveStage (PR without metadata -> none)", async () => {
    vi.spyOn(core, "getInput").mockImplementation(() => "");
    const bundle = makeMockAdapter();
    await runRoute(bundle.adapter);
    expect(setOutput).toHaveBeenCalledWith("stage", "none");
  });
});
```

- [ ] **Step 2: Run it — must fail**

Run: `pnpm --filter @shopfloor/router test -- --run route`

Expected: The `review_only=true` case fails because no such input is read yet.

- [ ] **Step 3: Update `route.ts` to branch on `review_only`**

Replace the top of `runRoute` (around the current `triggerLabel` read and `resolveStage` call) with:

```typescript
export async function runRoute(adapter: GitHubAdapter): Promise<void> {
  const triggerLabel = core.getInput("trigger_label") || undefined;
  const reviewOnly = core.getInput("review_only") === "true";

  let liveLabels: string[] | undefined;
  if (!reviewOnly && context.eventName === "issues") {
    const payload = context.payload as unknown as IssuePayload;
    if (payload.issue?.number !== undefined) {
      try {
        const issue = await adapter.getIssue(payload.issue.number);
        liveLabels = issue.labels.map((l) => l.name);
      } catch (err) {
        core.warning(
          `route: live label fetch failed, falling back to payload snapshot: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  let decision: RouterDecision = reviewOnly
    ? resolveReviewOnly(context.payload as unknown as PullRequestPayload)
    : resolveStage({
        eventName: context.eventName,
        payload: context.payload as never,
        triggerLabel,
        liveLabels,
      });
```

And add the new imports at the top:

```typescript
import {
  parsePrMetadata,
  resolveReviewOnly,
  resolveStage,
} from "../state";
import type {
  IssuePayload,
  PullRequestPayload,
  RouterDecision,
} from "../types";
```

The review-stuck enrichment block below this point remains unchanged — it only fires when `decision.reason === "review_stuck_removed_force_review"`, which `resolveReviewOnly` never produces.

- [ ] **Step 4: Add the action input**

In `router/action.yml`, add to the `inputs:` block (near the other generic inputs):

```yaml
review_only:
  description: "When 'true', routing uses resolveReviewOnly (for non-shopfloor human PRs) instead of the issue-centric state machine. Used by shopfloor-review.yml."
  required: false
  default: ""
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @shopfloor/router test -- --run route`

Expected: Both new cases pass; the existing route tests still pass.

- [ ] **Step 6: Commit**

```bash
git add router/src/helpers/route.ts router/action.yml router/test/helpers/route.test.ts
git commit -m "feat(router): dispatch to resolveReviewOnly when review_only input is set"
```

---

## Task 4: Verify null-origin-issue path in `checkReviewSkip`

**Files:**

- Modify: `router/test/helpers/check-review-skip.test.ts`

The spec expects the existing null-origin-issue fall-through to already work; this task adds the test that proves it.

- [ ] **Step 1: Write the new test**

Append to `router/test/helpers/check-review-skip.test.ts`, inside `describe("checkReviewSkip", ...)`:

```typescript
test("skip=false on human PR with no Shopfloor-Issue metadata", async () => {
  const bundle = makeMockAdapter();
  // Human-contributor PR: no metadata footer in body, no linked issue.
  primePrFixture(bundle, {
    body: "Fixes a rendering glitch in the sidebar.",
    changedFiles: ["src/ui/sidebar.tsx"],
  });
  const result = await checkReviewSkip(bundle.adapter, 45);
  expect(result.skip).toBe(false);
  // getIssue must NOT be called because the body has no Shopfloor-Issue ref.
  expect(bundle.mocks.getIssue).not.toHaveBeenCalled();
});
```

`primePrFixture` already wires `getIssue` to a default resolved value; the assertion tightens that it is not reached at all.

- [ ] **Step 2: Run the test to verify it passes without code changes**

Run: `pnpm --filter @shopfloor/router test -- --run check-review-skip`

Expected: PASS. If it fails, `check-review-skip.ts` is silently calling `getIssue` even on null; in that case the fix is one line in `check-review-skip.ts` (guard the issue lookup on `originIssueNumber !== null`), and a brief note in the commit.

- [ ] **Step 3: Commit**

```bash
git add router/test/helpers/check-review-skip.test.ts
git commit -m "test(router): cover null origin issue path in checkReviewSkip"
```

---

## Task 5: Generalise `aggregate-review` (optional issueNumber, insert-on-missing iteration)

**Files:**

- Modify: `router/src/helpers/aggregate-review.ts`
- Modify: `router/test/helpers/aggregate-review.test.ts`

- [ ] **Step 1: Replace the "throws when iteration footer missing" test with an insert-on-missing test**

In `router/test/helpers/aggregate-review.test.ts`, DELETE the existing final test (`writeIterationToBody throws when the body is missing the metadata footer`) and REPLACE it with two new tests:

```typescript
test("issueNumber omitted -> labels land on PR number", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "abc" },
      // Non-shopfloor human PR: no metadata footer.
      body: "Quick fix for the sidebar.",
    },
  });
  await aggregateReview(bundle.adapter, {
    prNumber: 77,
    confidenceThreshold: 80,
    maxIterations: 3,
    reviewerOutputs: {
      compliance: fixture("compliance-issues"),
      bugs: fixture("bugs-clean"),
      security: fixture("security-clean"),
      smells: fixture("smells-clean"),
    },
  });
  expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
    expect.objectContaining({
      issue_number: 77, // label target falls back to PR number
      labels: ["shopfloor:review-requested-changes"],
    }),
  );
  expect(bundle.mocks.removeLabel).toHaveBeenCalledWith(
    expect.objectContaining({
      issue_number: 77,
      name: "shopfloor:needs-review",
    }),
  );
});

test("inserts Shopfloor-Review-Iteration footer when absent", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "abc" },
      body: "Fixes a rendering bug.\n",
    },
  });
  await aggregateReview(bundle.adapter, {
    prNumber: 77,
    confidenceThreshold: 80,
    maxIterations: 3,
    reviewerOutputs: {
      compliance: fixture("compliance-issues"),
      bugs: fixture("bugs-clean"),
      security: fixture("security-clean"),
      smells: fixture("smells-clean"),
    },
  });
  const updatePrCall = bundle.mocks.updatePr.mock.calls.at(-1)?.[0] as {
    body: string;
  };
  expect(updatePrCall.body).toMatch(/Shopfloor-Review-Iteration: 1/);
  // Original body preserved.
  expect(updatePrCall.body).toContain("Fixes a rendering bug.");
});
```

Note: `AggregateReviewParams["issueNumber"]` needs to be optional for `{ prNumber: 77, ... }` to typecheck; TypeScript errors here drive the next step.

- [ ] **Step 2: Run tests to confirm failures**

Run: `pnpm --filter @shopfloor/router test -- --run aggregate-review`

Expected: Two new tests fail (the throw case no longer exists); the TypeScript compiler also complains inside the tests about the missing `issueNumber` field. Both are expected.

- [ ] **Step 3: Modify `AggregateReviewParams` and `aggregateReview` in `aggregate-review.ts`**

Change the interface:

```typescript
export interface AggregateReviewParams {
  /**
   * When omitted, every label operation below targets the PR number. Used by
   * shopfloor-review.yml on human-authored PRs that have no linked Shopfloor
   * issue. Present in the full pipeline so labels continue to land on the
   * origin issue.
   */
  issueNumber?: number;
  prNumber: number;
  confidenceThreshold: number;
  maxIterations: number;
  reviewerOutputs: Record<
    "compliance" | "bugs" | "security" | "smells",
    string
  >;
  workflowRunUrl?: string;
  analysedSha?: string;
}
```

Inside `aggregateReview`, right after the `const outputs = { ... }` block, introduce:

```typescript
const labelTarget = params.issueNumber ?? params.prNumber;
```

Replace every `params.issueNumber` reference in label calls (`addLabel`, `removeLabel`) with `labelTarget`. The four callsites are the approve path (3 calls), the iteration-cap path (3 calls), and the request-changes path (2 calls). Do not change `postIssueComment(params.prNumber, ...)` — that already uses the PR. Do not change status or `createReview` calls.

Rewrite `writeIterationToBody` to insert when absent:

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

Rationale documented inline — keep it short:

```typescript
// For full-pipeline PRs apply-impl-postwork always inserts the footer before
// any review runs, so this stays a no-op there. For review-only PRs the
// footer is inserted on the first REQUEST_CHANGES and bumped on subsequent
// iterations.
```

Also update `runAggregateReview` so `issue_number` becomes optional:

```typescript
const issueNumberInput = core.getInput("issue_number");
const params: AggregateReviewParams = {
  ...(issueNumberInput ? { issueNumber: Number(issueNumberInput) } : {}),
  prNumber: Number(core.getInput("pr_number", { required: true })),
  // ... rest unchanged
};
```

- [ ] **Step 4: Run tests to verify all aggregate-review tests pass**

Run: `pnpm --filter @shopfloor/router test -- --run aggregate-review`

Expected: All tests PASS (including the clean/issues/cap/two-app/drift cases which still supply `issueNumber`).

- [ ] **Step 5: Typecheck full repo**

Run: `pnpm -r typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add router/src/helpers/aggregate-review.ts router/test/helpers/aggregate-review.test.ts
git commit -m "refactor(router): make aggregate-review issueNumber optional and insert iteration footer on missing"
```

---

## Task 6: Reusable workflow `shopfloor-review.yml`

**Files:**

- Create: `.github/workflows/shopfloor-review.yml`

This workflow mirrors the review chain from `shopfloor.yml` lines 1205–1727 (review-skip-check through review-aggregator). Key deltas:

- It owns the `route` job (calls the router with `review_only: true`, then adds `shopfloor:needs-review` to the PR).
- All `refs/pull/*` checkouts use `needs.route.outputs.impl_pr_number` (same as the full pipeline's review matrix).
- The `review-aggregator` job passes `issue_number: ${{ needs.route.outputs.impl_pr_number }}` so the precheck reads PR labels (GitHub treats PRs as issues for the labels API) and the aggregator helper's `labelTarget` falls back to the PR. (`issue_number` input stays populated because precheck-stage requires it; the aggregator helper now tolerates its absence, but we keep this wire convention so the workflow YAML is a simple lift-and-shift.)
- Workflow-level GitHub App gating identical to the full pipeline: `has_review_app` flag gates the entire review chain. Unlike the full pipeline this secondary App is OPTIONAL in spirit (no self-review restriction), so for review-only we also allow the chain to run when only the primary App is set: `review_github_token` falls back to the primary App token via the existing `runAggregateReview` fallback in `index.ts`.

- [ ] **Step 1: Create the file**

Write `.github/workflows/shopfloor-review.yml`:

```yaml
name: Shopfloor Review
on:
  workflow_call:
    inputs:
      review_compliance_model: { type: string, default: sonnet }
      review_bugs_model: { type: string, default: opus }
      review_security_model: { type: string, default: opus }
      review_smells_model: { type: string, default: opus }
      review_compliance_max_turns: { type: string, default: "" }
      review_bugs_max_turns: { type: string, default: "" }
      review_security_max_turns: { type: string, default: "" }
      review_smells_max_turns: { type: string, default: "" }
      review_compliance_max_budget_usd: { type: string, default: "" }
      review_bugs_max_budget_usd: { type: string, default: "" }
      review_security_max_budget_usd: { type: string, default: "" }
      review_smells_max_budget_usd: { type: string, default: "" }
      review_compliance_enabled: { type: boolean, default: true }
      review_bugs_enabled: { type: boolean, default: true }
      review_security_enabled: { type: boolean, default: true }
      review_smells_enabled: { type: boolean, default: true }
      review_compliance_effort: { type: string, default: medium }
      review_bugs_effort: { type: string, default: medium }
      review_security_effort: { type: string, default: medium }
      review_smells_effort: { type: string, default: medium }
      review_timeout_minutes: { type: number, default: 20 }
      review_confidence_threshold: { type: number, default: 80 }
      max_review_iterations: { type: number, default: 3 }
      use_bedrock: { type: boolean, default: false }
      use_vertex: { type: boolean, default: false }
      use_foundry: { type: boolean, default: false }
      display_report: { type: string, default: "true" }
      # Same trigger_label semantics as the full pipeline, but applied to PRs.
      # When set, only PRs carrying this label are reviewed.
      trigger_label: { type: string, default: "" }
      runner_router:
        type: string
        default: "ubuntu-latest"
      runner_review:
        type: string
        default: "ubuntu-latest"
    secrets:
      anthropic_api_key: { required: false }
      claude_code_oauth_token: { required: false }
      aws_access_key_id: { required: false }
      aws_secret_access_key: { required: false }
      aws_region: { required: false }
      aws_bearer_token_bedrock: { required: false }
      anthropic_vertex_project_id: { required: false }
      cloud_ml_region: { required: false }
      google_application_credentials: { required: false }
      anthropic_foundry_resource: { required: false }
      shopfloor_github_app_client_id: { required: false }
      shopfloor_github_app_private_key: { required: false }
      # Optional second GitHub App. When set, reviews post under this App's
      # identity (same as the full pipeline). When unset, reviews post under
      # the primary App's identity -- which is safe here because Shopfloor is
      # not the author of these PRs, so the self-review restriction does not
      # apply.
      shopfloor_github_app_review_client_id: { required: false }
      shopfloor_github_app_review_private_key: { required: false }

env:
  SHOPFLOOR_PLUGIN_MARKETPLACES: |-
    https://github.com/anthropics/claude-code.git
    https://github.com/anthropics/claude-plugins-official.git
  SHOPFLOOR_COMMON_TOOLS: "Agent,Skill,LSP,ToolSearch,Bash(gh api:*),Bash(curl:*)"
  SHOPFLOOR_DISALLOWED_TOOLS: "AskUserQuestion,EnterPlanMode,EnterWorktree,ExitPlanMode,ExitWorktree,TodoWrite,TaskCreate,WebSearch"

jobs:
  route:
    runs-on: ${{ startsWith(inputs.runner_router, '[') && fromJSON(inputs.runner_router) || inputs.runner_router }}
    permissions:
      contents: read
      issues: read
      pull-requests: read
    env:
      SHOPFLOOR_HAS_APP: ${{ secrets.shopfloor_github_app_client_id != '' && secrets.shopfloor_github_app_private_key != '' }}
      SHOPFLOOR_HAS_REVIEW_APP: ${{ secrets.shopfloor_github_app_review_client_id != '' && secrets.shopfloor_github_app_review_private_key != '' }}
    outputs:
      stage: ${{ steps.router.outputs.stage }}
      impl_pr_number: ${{ steps.router.outputs.impl_pr_number }}
      review_iteration: ${{ steps.router.outputs.review_iteration }}
      reason: ${{ steps.router.outputs.reason }}
      has_review_app: ${{ steps.flags.outputs.has_review_app }}
      pr_trigger_label_gate_passed: ${{ steps.gate.outputs.passed }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - id: flags
        run: echo "has_review_app=${SHOPFLOOR_HAS_REVIEW_APP}" >> "$GITHUB_OUTPUT"
      - name: Warn if no GitHub App configured
        if: ${{ env.SHOPFLOOR_HAS_APP != 'true' }}
        run: |
          echo "::warning title=Shopfloor Review::No primary GitHub App credentials configured. Label writes on the PR will go through GITHUB_TOKEN, which may not be allowed by the caller's permissions."
      - name: Mint GitHub App token
        id: app_token
        if: ${{ env.SHOPFLOOR_HAS_APP == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ secrets.shopfloor_github_app_client_id }}
          private-key: ${{ secrets.shopfloor_github_app_private_key }}
      - id: bootstrap
        uses: niranjan94/shopfloor/router@main
        with:
          helper: bootstrap-labels
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
      # PR-side trigger_label gate. Empty input -> pass. Label present -> pass.
      # Implemented in shell because the state machine doesn't apply here.
      - id: gate
        env:
          PR_LABELS: ${{ toJSON(github.event.pull_request.labels) }}
          TRIGGER_LABEL: ${{ inputs.trigger_label }}
        run: |
          if [ -z "$TRIGGER_LABEL" ]; then
            echo "passed=true" >> "$GITHUB_OUTPUT"
          elif echo "$PR_LABELS" | jq -e --arg t "$TRIGGER_LABEL" '.[] | select(.name == $t)' >/dev/null; then
            echo "passed=true" >> "$GITHUB_OUTPUT"
          else
            echo "passed=false" >> "$GITHUB_OUTPUT"
            echo "::notice title=Shopfloor Review skipped::PR does not carry trigger label '$TRIGGER_LABEL'"
          fi
      - id: router
        if: steps.gate.outputs.passed == 'true'
        uses: niranjan94/shopfloor/router@main
        with:
          helper: route
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          review_only: "true"
      # Mark the PR as needing review so the aggregator's precheck passes and
      # downstream label-flips work identically to the full pipeline.
      - name: Label PR as needs-review
        if: steps.router.outputs.stage == 'review'
        env:
          GH_TOKEN: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          PR: ${{ steps.router.outputs.impl_pr_number }}
          REPO: ${{ github.repository }}
        run: gh api -X POST "repos/$REPO/issues/$PR/labels" -f "labels[]=shopfloor:needs-review" >/dev/null

  review-skip-check:
    needs: route
    if: needs.route.outputs.stage == 'review'
    runs-on: ${{ startsWith(inputs.runner_router, '[') && fromJSON(inputs.runner_router) || inputs.runner_router }}
    permissions:
      contents: read
      issues: read
      pull-requests: read
    env:
      SHOPFLOOR_HAS_APP: ${{ secrets.shopfloor_github_app_client_id != '' && secrets.shopfloor_github_app_private_key != '' }}
    outputs:
      skip: ${{ steps.check.outputs.skip }}
      reason: ${{ steps.check.outputs.reason }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - name: Mint GitHub App token
        id: app_token
        if: ${{ env.SHOPFLOOR_HAS_APP == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ secrets.shopfloor_github_app_client_id }}
          private-key: ${{ secrets.shopfloor_github_app_private_key }}
      - id: check
        uses: niranjan94/shopfloor/router@main
        with:
          helper: check-review-skip
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          pr_number: ${{ needs.route.outputs.impl_pr_number }}

  review-compliance:
    needs: [route, review-skip-check]
    if: needs.route.outputs.stage == 'review' && needs.review-skip-check.outputs.skip == 'false' && inputs.review_compliance_enabled
    concurrency:
      group: shopfloor-review-compliance-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}
      cancel-in-progress: true
    runs-on: ${{ startsWith(inputs.runner_review, '[') && fromJSON(inputs.runner_review) || inputs.runner_review }}
    timeout-minutes: ${{ inputs.review_timeout_minutes }}
    permissions:
      contents: read
      issues: read
      pull-requests: read
    env:
      SHOPFLOOR_HAS_APP: ${{ secrets.shopfloor_github_app_client_id != '' && secrets.shopfloor_github_app_private_key != '' }}
    outputs:
      structured_output: ${{ steps.agent.outputs.structured_output }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: refs/pull/${{ needs.route.outputs.impl_pr_number }}/head
          fetch-depth: 0
          persist-credentials: false
      - name: Mint GitHub App token
        id: app_token
        if: ${{ env.SHOPFLOOR_HAS_APP == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ secrets.shopfloor_github_app_client_id }}
          private-key: ${{ secrets.shopfloor_github_app_private_key }}
      - name: Build review context
        id: ctx
        env:
          PR_NUMBER: ${{ needs.route.outputs.impl_pr_number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_BODY: ${{ github.event.pull_request.body }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          BASE_REF: ${{ github.event.pull_request.base.ref }}
        run: |
          DIFF=$(git diff "origin/${BASE_REF}...HEAD" | head -c 200000 || echo "")
          CHANGED=$(git diff --name-only "origin/${BASE_REF}...HEAD" | tr '\n' ',' | sed 's/,$//')
          jq -n \
            --arg repo_owner "$REPO_OWNER" \
            --arg repo_name "$REPO_NAME" \
            --arg pr_number "$PR_NUMBER" \
            --arg pr_title "${PR_TITLE:-}" \
            --arg pr_body "${PR_BODY:-}" \
            --arg diff "$DIFF" \
            --arg changed_files "$CHANGED" \
            --arg plan_file_contents "" \
            --arg issue_body "" \
            --arg iteration_count "${{ needs.route.outputs.review_iteration }}" \
            --arg previous_review_comments_json "[]" \
            '{repo_owner: $repo_owner, repo_name: $repo_name, pr_number: $pr_number, pr_title: $pr_title, pr_body: $pr_body, diff: $diff, changed_files: $changed_files, plan_file_contents: $plan_file_contents, issue_body: $issue_body, iteration_count: $iteration_count, previous_review_comments_json: $previous_review_comments_json}' \
            > "$RUNNER_TEMP/context.json"
          echo "path=$RUNNER_TEMP/context.json" >> "$GITHUB_OUTPUT"
      - name: Render compliance prompt
        id: prompt
        uses: niranjan94/shopfloor/router@main
        with:
          helper: render-prompt
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          prompt_file: prompts/review-compliance.md
          context_file: ${{ steps.ctx.outputs.path }}
          base_allowed_tools: "Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*),WebFetch,${{ env.SHOPFLOOR_COMMON_TOOLS }}"
      - id: agent
        uses: anthropics/claude-code-action@1eddb334cfa79fdb21ecbe2180ca1a016e8e7d47 # v1.0.88 -- pinned; v1.0.89+ bug: anthropics/claude-code-action#1205
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.anthropic_api_key }}
          claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}
          allowed_bots: "*"
          prompt: ${{ steps.prompt.outputs.rendered }}
          display_report: ${{ inputs.display_report }}
          plugin_marketplaces: ${{ env.SHOPFLOOR_PLUGIN_MARKETPLACES }}
          claude_args: |
            --model ${{ inputs.review_compliance_model }}
            --effort ${{ inputs.review_compliance_effort }}
            ${{ inputs.review_compliance_max_turns != '' && format('--max-turns {0}', inputs.review_compliance_max_turns) || '' }}
            ${{ inputs.review_compliance_max_budget_usd != '' && format('--max-budget-usd {0}', inputs.review_compliance_max_budget_usd) || '' }}
            --allowedTools "${{ steps.prompt.outputs.allowed_tools }}"
            --disallowedTools "${{ env.SHOPFLOOR_DISALLOWED_TOOLS }}"
            --json-schema '{"type":"object","properties":{"verdict":{"type":"string","enum":["clean","issues_found"]},"summary":{"type":"string"},"comments":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"line":{"type":"integer"},"side":{"type":"string","enum":["LEFT","RIGHT"]},"start_line":{"type":"integer"},"start_side":{"type":"string","enum":["LEFT","RIGHT"]},"body":{"type":"string"},"confidence":{"type":"integer"},"category":{"type":"string"}},"required":["path","line","side","body","confidence","category"]}}},"required":["verdict","summary","comments"]}'

  review-bugs:
    # COPY the review-compliance job above with these substitutions:
    #   - job id: review-bugs
    #   - concurrency group: shopfloor-review-bugs-...
    #   - step "Render compliance prompt" -> "Render bugs prompt"
    #   - prompt_file: prompts/review-bugs.md
    #   - base_allowed_tools: drop WebFetch (match shopfloor.yml line 1414)
    #   - claude_args: review_bugs_model / effort / max_turns / max_budget_usd
    # (Full YAML omitted in the plan to keep it readable; use shopfloor.yml
    # lines 1340-1435 as the exact source. Every review_bugs_* is replicated.)

  review-security:
    # COPY review-compliance with the substitutions for review_security_* per
    # shopfloor.yml lines 1437-1532. base_allowed_tools keeps WebFetch.

  review-smells:
    # COPY review-compliance with the substitutions for review_smells_* per
    # shopfloor.yml lines 1534-1629. base_allowed_tools drops WebFetch.

  review-aggregator:
    needs:
      [route, review-skip-check, review-compliance, review-bugs, review-security, review-smells]
    if: always() && needs.route.outputs.stage == 'review' && needs.review-skip-check.outputs.skip == 'false'
    concurrency:
      group: shopfloor-review-aggregator-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}
      cancel-in-progress: true
    runs-on: ${{ startsWith(inputs.runner_router, '[') && fromJSON(inputs.runner_router) || inputs.runner_router }}
    permissions:
      contents: read
      issues: read
      pull-requests: read
    env:
      SHOPFLOOR_HAS_APP: ${{ secrets.shopfloor_github_app_client_id != '' && secrets.shopfloor_github_app_private_key != '' }}
      SHOPFLOOR_HAS_REVIEW_APP: ${{ secrets.shopfloor_github_app_review_client_id != '' && secrets.shopfloor_github_app_review_private_key != '' }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - name: Mint GitHub App token
        id: app_token
        if: ${{ env.SHOPFLOOR_HAS_APP == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ secrets.shopfloor_github_app_client_id }}
          private-key: ${{ secrets.shopfloor_github_app_private_key }}
      - name: Mint GitHub App token (review app)
        id: app_token_review
        if: ${{ env.SHOPFLOOR_HAS_REVIEW_APP == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ secrets.shopfloor_github_app_review_client_id }}
          private-key: ${{ secrets.shopfloor_github_app_review_private_key }}
      - name: Precheck review preconditions
        id: precheck
        uses: niranjan94/shopfloor/router@main
        with:
          helper: precheck-stage
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          stage: review-aggregator
          # Using the PR number as issue_number is safe because GitHub's issues
          # API treats PRs as issues for label lookups; precheck-stage reads
          # shopfloor:needs-review from the PR's label set.
          issue_number: ${{ needs.route.outputs.impl_pr_number }}
          pr_number: ${{ needs.route.outputs.impl_pr_number }}
          analysed_sha: ${{ github.event.pull_request.head.sha }}
      - name: Log precheck skip
        if: steps.precheck.outputs.skip == 'true'
        run: echo "::notice title=Shopfloor review skipped::${{ steps.precheck.outputs.reason }}"
      - name: Aggregate review
        id: aggregate
        uses: niranjan94/shopfloor/router@main
        if: steps.precheck.outputs.skip != 'true'
        with:
          helper: aggregate-review
          github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          # Falls back to primary App when the secondary review App is unset;
          # review-only PRs are not authored by Shopfloor, so the self-review
          # block does not apply and the primary identity can post reviews.
          review_github_token: ${{ steps.app_token_review.outputs.token || steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
          # issue_number is intentionally omitted; aggregate-review's
          # labelTarget falls back to pr_number.
          pr_number: ${{ needs.route.outputs.impl_pr_number }}
          confidence_threshold: ${{ inputs.review_confidence_threshold }}
          max_iterations: ${{ inputs.max_review_iterations }}
          compliance_output: ${{ needs.review-compliance.outputs.structured_output }}
          bugs_output: ${{ needs.review-bugs.outputs.structured_output }}
          security_output: ${{ needs.review-security.outputs.structured_output }}
          smells_output: ${{ needs.review-smells.outputs.structured_output }}
          workflow_run_url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          analysed_sha: ${{ github.event.pull_request.head.sha }}
```

**Expand the three "COPY" stubs** (review-bugs, review-security, review-smells) by literally copying the `review-compliance` block above and substituting per the comments. This keeps the four reviewer jobs byte-identical in structure to `shopfloor.yml`.

- [ ] **Step 2: Validate workflow syntax**

Run: `pnpx action-validator .github/workflows/shopfloor-review.yml` (if installed) OR just `pnpx @github/actions-workflow-parser .github/workflows/shopfloor-review.yml`. If neither is available, lean on `yamllint` or the `actionlint` binary if present. Alternatively skip and rely on the dogfood workflow to surface parse errors on push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/shopfloor-review.yml
git commit -m "feat(workflow): add shopfloor-review.yml reusable review-only workflow"
```

---

## Task 7: Dogfood caller `.github/workflows/dogfood-review.yml`

**Files:**

- Create: `.github/workflows/dogfood-review.yml`

Mirrors the shape of `.github/workflows/dogfood.yml` but wires the review-only workflow to `pull_request` events.

- [ ] **Step 1: Create the file**

Write `.github/workflows/dogfood-review.yml`:

```yaml
name: Shopfloor Review on Shopfloor
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

jobs:
  review:
    uses: ./.github/workflows/shopfloor-review.yml
    # Same read-only ceiling as dogfood.yml; all writes flow through the
    # Shopfloor App installation token.
    permissions:
      contents: read
      issues: read
      pull-requests: read
    secrets: inherit
```

**Do not** add a `trigger_label:` input here; we want Shopfloor to review every non-Shopfloor PR opened on this repo by default. Shopfloor-authored PRs are excluded inside the router (`resolveReviewOnly` returns `stage:"none"` when PR metadata is present), so the full pipeline (`dogfood.yml`) keeps ownership of its own PRs.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/dogfood-review.yml
git commit -m "chore(workflow): dogfood shopfloor-review.yml via dogfood-review.yml"
```

---

## Task 8: Documentation

**Files:**

- Modify: `docs/shopfloor/configuration.md` — append a "Review-only workflow" section.
- Modify: `docs/shopfloor/install.md` — under the install/setup section, mention the review-only workflow as an optional companion.

- [ ] **Step 1: Add configuration section**

Append to `docs/shopfloor/configuration.md`:

````markdown
## Review-only workflow

`shopfloor-review.yml` is a second reusable workflow that runs Shopfloor's four-reviewer matrix (compliance / bugs / security / smells) plus the aggregator on PRs that were NOT created by Shopfloor's implement stage. Use it to run agent reviews on PRs from human contributors or from other automations.

It is deliberately separate from `shopfloor.yml`: the full pipeline is issue-driven and operates only on Shopfloor-authored PRs; the review-only workflow operates on arbitrary PRs and skips any PR that carries Shopfloor PR metadata (so the two workflows never double-review the same PR).

### Minimal caller

```yaml
# .github/workflows/review.yml
name: Shopfloor Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

jobs:
  review:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor-review.yml@v1
    permissions:
      contents: read
      issues: read
      pull-requests: read
    secrets: inherit
```

### Inputs

A subset of `shopfloor.yml`'s inputs applies:

- Per-reviewer model / max-turns / max-budget / enabled / effort knobs (`review_compliance_*`, `review_bugs_*`, `review_security_*`, `review_smells_*`).
- `review_timeout_minutes`, `review_confidence_threshold`, `max_review_iterations`.
- `use_bedrock`, `use_vertex`, `use_foundry`, `display_report`, `runner_router`, `runner_review`.
- `trigger_label` — optional. When set, only PRs carrying this label are reviewed.

### Secrets

Same set as the full pipeline. The second review App (`shopfloor_github_app_review_*`) is **optional** here. When unset, reviews post under the primary App's identity — which is safe because Shopfloor does not author these PRs, so the self-review restriction does not apply.

### State tracking

The review iteration counter is written into the PR body as `Shopfloor-Review-Iteration: N` on the first REQUEST_CHANGES. Labels (`shopfloor:needs-review`, `shopfloor:review-requested-changes`, `shopfloor:review-approved`, `shopfloor:review-stuck`) are applied to the PR itself.

A human-authored revision cycle works like this:

1. Contributor opens the PR → review runs.
2. Aggregator posts REQUEST_CHANGES with inline comments.
3. Contributor pushes a fix.
4. `pull_request.synchronize` re-enters the workflow; review runs again.
5. Aggregator either APPROVEs or bumps the iteration.

There is no implement agent in this workflow — revisions are always human-authored.

### Excluding review-only for a PR

Add the `shopfloor:skip-review` label to the PR (or have the caller gate via `trigger_label`).
````

- [ ] **Step 2: Add install mention**

In `docs/shopfloor/install.md`, find the section that describes caller workflow setup and add a short paragraph pointing at `shopfloor-review.yml` for repos that want agent reviews on human-contributor PRs. One paragraph is enough — link to the configuration section.

- [ ] **Step 3: Run prettier**

Run: `pnpm format`

Expected: any needed formatting applied.

- [ ] **Step 4: Commit**

```bash
git add docs/shopfloor/configuration.md docs/shopfloor/install.md
git commit -m "docs(configuration): document review-only workflow"
```

---

## Task 9: Rebuild router dist

**Files:**

- Modify: `router/dist/index.cjs`
- Modify: `router/dist/index.cjs.map`

The project convention commits the built bundle.

- [ ] **Step 1: Rebuild**

Run: `pnpm --filter @shopfloor/router build`

Expected: `router/dist/index.cjs` regenerated.

- [ ] **Step 2: Run full test suite + typecheck**

Run: `pnpm test && pnpm -r typecheck`

Expected: all tests pass, no type errors.

- [ ] **Step 3: Run formatters**

Run: `pnpm format`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add router/dist/index.cjs router/dist/index.cjs.map
git commit -m "chore(router): rebuild dist"
```

---

## Verification checklist

Before declaring done, run and confirm:

- [ ] `pnpm test` — all green.
- [ ] `pnpm -r typecheck` — clean.
- [ ] `pnpm format:check` — clean.
- [ ] `git grep -n "resolveReviewOnly" router/` finds the new function and tests.
- [ ] `git grep -n "review_only" router/action.yml router/src/helpers/route.ts` both match.
- [ ] Dogfood workflows parse on push: confirm the Actions tab shows both `Shopfloor on Shopfloor` and `Shopfloor Review on Shopfloor` as valid workflows after the PR is opened.
- [ ] Open a draft PR from a non-Shopfloor branch in this repo → `shopfloor-review.yml` runs, routes to `stage:"none"` with reason `pr_is_draft`.
- [ ] Un-draft → reviews run, aggregator posts APPROVE or REQUEST_CHANGES; the `shopfloor:needs-review` / `shopfloor:review-*` labels appear on the PR itself.
- [ ] Open a Shopfloor impl PR (via the normal issue pipeline) → `shopfloor-review.yml` routes to `stage:"none"` with reason `pr_has_shopfloor_metadata_use_full_pipeline`; the full pipeline's review matrix owns it.

---

## Non-goals / deferred

- No new `pull_request_review` trigger in the review-only caller — revisions come from `synchronize` on human pushes.
- No composite-action extraction of the reviewer matrix to share between `shopfloor.yml` and `shopfloor-review.yml` (GitHub Actions does not support nested reusable workflows; see spec "Trade-offs").
- No support for review-only on issue-comment-driven rerun commands.
- No new skip-review helper variants — existing `shopfloor:skip-review` label on the PR is sufficient.
