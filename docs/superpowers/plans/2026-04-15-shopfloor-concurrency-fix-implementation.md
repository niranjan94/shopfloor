# Shopfloor concurrency and staleness fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-04-15-shopfloor-concurrency-fix.md`](../specs/2026-04-15-shopfloor-concurrency-fix.md)

**Goal:** Replace workflow-level concurrency with per-stage groups, make routing and mutations resilient to stale queued decisions, and eliminate the silent-drop hole that stalls the pipeline after a webhook burst.

**Architecture:** Four cooperating layers — per-stage concurrency groups (correctness), router live-label refetch (optimisation), a new `precheck-stage` helper that re-validates preconditions at job start (correctness), and transient `-running`/`implementing` mutex marker labels (correctness). Plus an orthogonal state-machine bug fix for `resolvePullRequestEvent` dropping `issueNumber` on merge, and in-helper precondition assertions as the belt-and-suspenders backstop.

**Tech Stack:** TypeScript (router action), vitest (tests), GitHub Actions YAML (workflow). No new runtime dependencies.

**Branch:** `shopfloor/fix/concurrency-staleness` (create locally, no worktree — user-level `CLAUDE.md` forbids worktrees).

**Conventional Commits landing order (one commit per task):**

1. `fix(state): populate issueNumber on PR merge events`
2. `feat(state): support live-label override in StateContext`
3. `feat(router): route helper fetches live labels from the API`
4. `feat(labels): add transient stage-running marker labels`
5. `feat(router): add precheck-stage helper`
6. `feat(helpers): add in-helper precondition assertions`
7. `feat(workflow): per-stage concurrency groups and precheck wiring`
8. `docs(spec): close the concurrency-fix spec`
9. `docs(troubleshooting): runbook for stalled pipeline recovery`

Each commit is independently green under `pnpm test` and `pnpm exec tsc --noEmit`. Run both after every task before committing.

**Non-goals (explicitly out of scope — do not do these as part of this plan):**

- Rewriting `resolveStage`'s control flow. Only additive changes.
- Grouping the four review matrix cells. They stay un-grouped per spec §5.1.
- Building a TTL / heartbeat lock mechanism. Label mutexes only.
- Any E2E harness work. Closing §2.1's failure mode on a live dogfood run is the acceptance criterion.

---

## Pre-flight

- [ ] **Step 1: Verify you are on `main` with a clean tree**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: `main`, clean working tree. If there are uncommitted changes unrelated to this plan, stop and ask.

- [ ] **Step 2: Create the implementation branch**

```bash
git checkout -b shopfloor/fix/concurrency-staleness
```

- [ ] **Step 3: Install and verify baseline green**

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm exec tsc --noEmit
```

Expected: all tests pass, typecheck clean. If anything is red before you start, stop and ask — you need a green baseline to compare against.

---

## Task 1: Populate `issueNumber` on PR merge (state bugfix)

**Why:** Under per-stage concurrency the `handle-merge` job's concurrency group name must include an issue number; today `resolvePullRequestEvent` drops that field on the merge branch, which collapses every `handle-merge` across every issue into a single global group. Orthogonal to the concurrency design, but latent until we rewire the groups. Spec §4.4, §6.1.

**Files:**

- Modify: `router/src/state.ts:292-297`
- Test: `router/test/state.test.ts`
- Fixtures: `router/test/fixtures/events/` (reuse existing PR-merge fixture if present; if not, add one)

- [ ] **Step 1: Locate or add a PR-merge fixture**

```bash
ls router/test/fixtures/events/ | grep -i merge
```

If an existing fixture covers `pull_request.closed merged=true` with a body containing `Shopfloor-Issue: #42` and `Shopfloor-Stage: spec`, reuse it. Otherwise create `router/test/fixtures/events/pr-closed-merged-spec.json` with minimum fields required by `PullRequestPayload` and a body parsable by `parsePrMetadata`.

- [ ] **Step 2: Add the failing test**

Append to `router/test/state.test.ts` inside the existing `describe("resolveStage", …)`:

```ts
test("pull_request.closed merged=true returns issueNumber from PR body metadata", () => {
  const decision = resolveStage(ctx("pull_request", "pr-closed-merged-spec"));
  expect(decision.stage).toBe("none");
  expect(decision.reason).toBe("pr_merged_spec_triggered_label_flip");
  expect(decision.issueNumber).toBe(42);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm test -- router/test/state.test.ts
```

Expected: FAIL — `decision.issueNumber` is `undefined`.

- [ ] **Step 4: Fix `resolvePullRequestEvent`**

In `router/src/state.ts`, inside the merge branch of `resolvePullRequestEvent`:

```ts
if (payload.action === "closed" && pr.merged) {
  return {
    stage: "none",
    issueNumber: meta.issueNumber,
    reason: `pr_merged_${meta.stage}_triggered_label_flip`,
  };
}
```

- [ ] **Step 5: Re-run the test**

```bash
pnpm test -- router/test/state.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add router/src/state.ts router/test/state.test.ts router/test/fixtures/events/
git commit -m "fix(state): populate issueNumber on PR merge events"
```

---

## Task 2: Support live-label override in `StateContext`

**Why:** The route helper needs to pass fresh labels from an API fetch into the pure state machine without breaking existing tests that build payloads inline. Additive field, no behaviour change when unset. Spec §5.2, §6.2.

**Files:**

- Modify: `router/src/types.ts` (StateContext)
- Modify: `router/src/state.ts` (`resolveIssueEvent` label source)
- Test: `router/test/state.test.ts`

- [ ] **Step 1: Add `liveLabels` to `StateContext`**

In `router/src/types.ts`, extend `StateContext`:

```ts
export interface StateContext {
  eventName: string;
  payload: EventPayload;
  shopfloorBotLogin?: string;
  triggerLabel?: string;
  /**
   * Optional live label set for the issue, fetched from the GitHub API at
   * route-run time. When present, the state machine uses this instead of
   * the payload's (event-time) label snapshot so a route job can observe
   * writes made by an earlier group-mate's stage job.
   */
  liveLabels?: string[];
}
```

- [ ] **Step 2: Use `liveLabels` in `resolveIssueEvent`**

In `router/src/state.ts`, introduce a helper that prefers `ctx.liveLabels` and plumb it through `resolveIssueEvent`. Change `resolveStage` to forward the context:

```ts
case "issues":
  return resolveIssueEvent(
    ctx.payload as IssuePayload,
    ctx.triggerLabel,
    ctx.liveLabels,
  );
```

In `resolveIssueEvent`, replace the first line that builds `labels`:

```ts
function resolveIssueEvent(
  payload: IssuePayload,
  triggerLabel?: string,
  liveLabels?: string[],
): RouterDecision {
  const labels = liveLabels
    ? new Set(liveLabels)
    : issueLabelSet(payload.issue);
  // …rest unchanged
```

**Critical:** `payload.label.name` (the "which label was JUST added" trigger gate) is event-authoritative and is NOT touched. Do not replace `payload.label?.name` anywhere.

- [ ] **Step 3: Add tests for the override**

Append to `router/test/state.test.ts`:

```ts
test("liveLabels takes precedence over payload.issue.labels for advancement", () => {
  // Payload's own labels are empty; live labels include needs-spec.
  // The label.name trigger gate still has to pass, so we use a labeled
  // action with shopfloor:needs-spec as the just-added label.
  const decision = resolveStage({
    ...ctx("issues", "issue-labeled-needs-spec"),
    liveLabels: ["shopfloor:needs-spec"],
  });
  expect(decision.stage).toBe("spec");
});

test("liveLabels can expose a stale advancement when payload says no-op", () => {
  // Simulates route job B seeing the state written by stage job A:
  // the event payload shows no state labels but the live fetch returns
  // a post-triage state. The labeled-trigger gate is unrelated here;
  // we drive this via an `edited` action that should resolve to none
  // under both reads but proves liveLabels are consulted.
  const decision = resolveStage({
    ...ctx("issues", "issue-opened-bare"),
    liveLabels: ["shopfloor:quick", "shopfloor:needs-impl"],
  });
  // An opened event with an existing state label should defer to
  // payload flow; confirm it does not crash and does not re-enter
  // triage when a state label is present.
  expect(decision.stage).not.toBe("triage");
});
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm test
pnpm exec tsc --noEmit
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add router/src/types.ts router/src/state.ts router/test/state.test.ts
git commit -m "feat(state): support live-label override in StateContext"
```

---

## Task 3: Route helper fetches live labels from the API

**Why:** Under capacity-limited custom runners, a later route job can observe writes from an earlier route's dispatched stage job before dispatching a duplicate. Pure load-shedding on GitHub-hosted runners; meaningful savings under self-hosted pools. Spec §5.2.

**Files:**

- Create: `router/src/helpers/route.ts` (extract the current inline route logic for testability)
- Modify: `router/src/index.ts` (dispatch to the new helper)
- Test: `router/test/helpers/route.test.ts` (new)

- [ ] **Step 1: Create the route helper**

Create `router/src/helpers/route.ts`:

```ts
import * as core from "@actions/core";
import { context } from "@actions/github";
import { resolveStage } from "../state";
import type { GitHubAdapter } from "../github";
import type { IssuePayload } from "../types";

export async function runRoute(adapter: GitHubAdapter): Promise<void> {
  const triggerLabel = core.getInput("trigger_label") || undefined;

  let liveLabels: string[] | undefined;
  if (context.eventName === "issues") {
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

  const decision = resolveStage({
    eventName: context.eventName,
    payload: context.payload as never,
    triggerLabel,
    liveLabels,
  });

  core.setOutput("stage", decision.stage);
  if (decision.issueNumber !== undefined) {
    core.setOutput("issue_number", String(decision.issueNumber));
  }
  if (decision.complexity) core.setOutput("complexity", decision.complexity);
  if (decision.branchName) core.setOutput("branch_name", decision.branchName);
  if (decision.specFilePath) {
    core.setOutput("spec_file_path", decision.specFilePath);
  }
  if (decision.planFilePath) {
    core.setOutput("plan_file_path", decision.planFilePath);
  }
  if (decision.revisionMode !== undefined) {
    core.setOutput("revision_mode", String(decision.revisionMode));
  }
  if (decision.reviewIteration !== undefined) {
    core.setOutput("review_iteration", String(decision.reviewIteration));
  }
  if (decision.implPrNumber !== undefined) {
    core.setOutput("impl_pr_number", String(decision.implPrNumber));
  }
  if (decision.reason) core.setOutput("reason", decision.reason);
}
```

Scope note: PR events do not consume `issue.labels` in the state machine, so skip the live fetch for them. Keep it issue-only.

- [ ] **Step 2: Wire the helper into `index.ts`**

In `router/src/index.ts`, replace the inline `case "route":` block with:

```ts
case "route":
  return runRoute(adapter);
```

and add the import alongside the other helper imports:

```ts
import { runRoute } from "./helpers/route";
```

- [ ] **Step 3: Add the failing test**

Create `router/test/helpers/route.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { runRoute } from "../../src/helpers/route";
import { makeMockAdapter } from "./_mock-adapter";

vi.mock("@actions/github", () => ({
  context: {
    eventName: "issues",
    payload: {
      action: "labeled",
      issue: {
        number: 42,
        title: "x",
        body: "",
        labels: [], // payload snapshot is EMPTY
        state: "open",
      },
      label: { name: "shopfloor:needs-impl" },
    },
    repo: { owner: "o", repo: "r" },
  },
}));

describe("runRoute", () => {
  let setOutput: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setOutput = vi.spyOn(core, "setOutput").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetches live labels and uses them for state resolution", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:needs-impl" }, { name: "shopfloor:quick" }],
        state: "open",
      },
    });
    await runRoute(bundle.adapter);
    expect(bundle.mocks.getIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42 }),
    );
    expect(setOutput).toHaveBeenCalledWith("stage", "implement");
  });

  test("falls back to payload labels on API error", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockRejectedValueOnce(new Error("boom"));
    await runRoute(bundle.adapter);
    // Payload has empty labels + label.name=shopfloor:needs-impl, so fallback
    // resolves via advancement-gate short-circuit: empty labels means
    // computeStageFromLabels returns null and stage resolves to none.
    expect(setOutput).toHaveBeenCalledWith("stage", "none");
  });
});
```

- [ ] **Step 4: Run the test, expect it to fail on a clean tree then pass once the helper is in**

```bash
pnpm test -- router/test/helpers/route.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS after step 1+2, typecheck clean.

- [ ] **Step 5: Rebuild the router bundle**

The committed artifact `router/dist/index.cjs` must match source:

```bash
pnpm --filter @shopfloor/router build
git diff router/dist/index.cjs
```

Expected: non-empty diff reflecting the new route helper. CI guards this on main.

- [ ] **Step 6: Full test + typecheck sweep**

```bash
pnpm test
pnpm exec tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add router/src/helpers/route.ts router/src/index.ts router/test/helpers/route.test.ts router/dist/index.cjs
git commit -m "feat(router): route helper fetches live labels from the API"
```

---

## Task 4: Transient stage-running marker labels

**Why:** Layer 4 mutex. When a long-running stage is mid-run, a second queued advancement event whose precheck would otherwise pass must see the marker and bail out. Also protects against mid-transition crashes where advancement labels are ambiguous. Spec §5.4, §6.3.

**Files:**

- Modify: `router/src/state.ts` (STATE_LABELS)
- Modify: `router/src/helpers/bootstrap-labels.ts` (LABEL_DEFS)
- Modify: `router/src/types.ts` (`ShopfloorLabel` union — optional but keeps types honest)
- Test: `router/test/helpers/bootstrap-labels.test.ts`

- [ ] **Step 1: Add labels to `STATE_LABELS`**

In `router/src/state.ts`, extend `STATE_LABELS`:

```ts
const STATE_LABELS = new Set<string>([
  "shopfloor:triaging",
  "shopfloor:awaiting-info",
  "shopfloor:needs-spec",
  "shopfloor:spec-in-review",
  "shopfloor:needs-plan",
  "shopfloor:plan-in-review",
  "shopfloor:needs-impl",
  "shopfloor:impl-in-review",
  "shopfloor:needs-review",
  "shopfloor:review-requested-changes",
  "shopfloor:review-approved",
  "shopfloor:review-stuck",
  "shopfloor:done",
  "shopfloor:spec-running",
  "shopfloor:plan-running",
  "shopfloor:implementing",
]);
```

Keep a one-line comment above the new entries: `// transient mutex markers (spec §5.4)`. These entries matter for `hasStateLabel` — they count as "an issue is mid-pipeline" so a naked trigger-label event does not re-enter triage while a stage is running.

- [ ] **Step 2: Extend the `ShopfloorLabel` union**

In `router/src/types.ts`, add `"shopfloor:spec-running"`, `"shopfloor:plan-running"`, `"shopfloor:implementing"` to the `ShopfloorLabel` union string literal list.

- [ ] **Step 3: Register the labels in bootstrap**

In `router/src/helpers/bootstrap-labels.ts`, append to `LABEL_DEFS`:

```ts
{
  name: "shopfloor:spec-running",
  color: "fbca04",
  description:
    "Transient marker: a spec stage job is actively running for this issue. Removed automatically when the stage completes.",
},
{
  name: "shopfloor:plan-running",
  color: "fbca04",
  description:
    "Transient marker: a plan stage job is actively running for this issue. Removed automatically when the stage completes.",
},
{
  name: "shopfloor:implementing",
  color: "fbca04",
  description:
    "Transient marker: an implement stage job is actively running for this issue. Removed automatically when the stage completes. If this label is stuck after a crash, remove it manually to unblock retries.",
},
```

- [ ] **Step 4: Update the bootstrap test**

Find the expectation in `router/test/helpers/bootstrap-labels.test.ts` that asserts the created-label count and extend it by 3, or switch it to a set-membership assertion that includes the new names. Do not weaken other assertions.

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm test
pnpm exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add router/src/state.ts router/src/types.ts router/src/helpers/bootstrap-labels.ts router/test/helpers/bootstrap-labels.test.ts
git commit -m "feat(labels): add transient stage-running marker labels"
```

---

## Task 5: `precheck-stage` helper

**Why:** The only layer that runs AFTER the per-stage concurrency queue serializes jobs. It is the sole point where a stale queued decision can observe writes from an earlier group-mate. Fail closed on definitive reads, fail open on transient errors (spec §5.3.2). This is the correctness backstop.

**Files:**

- Create: `router/src/helpers/precheck-stage.ts`
- Create: `router/test/helpers/precheck-stage.test.ts`
- Modify: `router/src/index.ts` (register helper)
- Modify: `router/action.yml` (declare `head_sha` input for the review precheck path and confirm `skip`/`reason` outputs exist)

- [ ] **Step 1: Create the helper skeleton**

Create `router/src/helpers/precheck-stage.ts`:

```ts
import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export type PrecheckStage =
  | "triage"
  | "spec"
  | "plan"
  | "implement"
  | "review-aggregator"
  | "handle-merge";

export interface PrecheckParams {
  stage: PrecheckStage;
  issueNumber: number;
  /** For review-aggregator only: the PR head SHA the matrix analysed. */
  analysedSha?: string;
  /** For review-aggregator only: PR number to read head sha from. */
  prNumber?: number;
  /** For handle-merge only: the merged stage (spec|plan|implement). */
  mergedStage?: "spec" | "plan" | "implement";
}

export interface PrecheckResult {
  skip: boolean;
  reason: string;
}

const TRIAGE_BLOCKING_STATE_LABELS = new Set<string>([
  "shopfloor:quick",
  "shopfloor:medium",
  "shopfloor:large",
  "shopfloor:needs-spec",
  "shopfloor:needs-plan",
  "shopfloor:needs-impl",
  "shopfloor:impl-in-review",
  "shopfloor:needs-review",
  "shopfloor:review-requested-changes",
  "shopfloor:review-approved",
  "shopfloor:review-stuck",
  "shopfloor:done",
]);

export async function precheckStage(
  adapter: GitHubAdapter,
  params: PrecheckParams,
): Promise<PrecheckResult> {
  let labels: Set<string>;
  try {
    const issue = await adapter.getIssue(params.issueNumber);
    labels = new Set(issue.labels.map((l) => l.name));
  } catch (err) {
    // Fail-open on transient read errors (spec §5.3.2). In-helper
    // assertions will catch any truly stale mutation downstream.
    core.warning(
      `precheck-stage: issue read failed for ${params.issueNumber}, falling back to skip=false: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { skip: false, reason: "precheck_read_error_fail_open" };
  }

  switch (params.stage) {
    case "triage": {
      for (const l of labels) {
        if (TRIAGE_BLOCKING_STATE_LABELS.has(l)) {
          return {
            skip: true,
            reason: `triage_already_completed_state_label_${l}_present`,
          };
        }
      }
      return { skip: false, reason: "triage_preconditions_hold" };
    }
    case "spec": {
      if (!labels.has("shopfloor:needs-spec")) {
        return {
          skip: true,
          reason: "spec_needs_spec_label_absent",
        };
      }
      if (labels.has("shopfloor:spec-running")) {
        return {
          skip: true,
          reason: "spec_already_in_progress",
        };
      }
      return { skip: false, reason: "spec_preconditions_hold" };
    }
    case "plan": {
      if (!labels.has("shopfloor:needs-plan")) {
        return {
          skip: true,
          reason: "plan_needs_plan_label_absent",
        };
      }
      if (labels.has("shopfloor:plan-running")) {
        return {
          skip: true,
          reason: "plan_already_in_progress",
        };
      }
      return { skip: false, reason: "plan_preconditions_hold" };
    }
    case "implement": {
      const needsImpl = labels.has("shopfloor:needs-impl");
      const revisionMode = labels.has("shopfloor:review-requested-changes");
      if (!needsImpl && !revisionMode) {
        return {
          skip: true,
          reason: "implement_neither_needs_impl_nor_revision_label_present",
        };
      }
      if (labels.has("shopfloor:implementing")) {
        return {
          skip: true,
          reason: "implement_already_in_progress",
        };
      }
      return { skip: false, reason: "implement_preconditions_hold" };
    }
    case "review-aggregator": {
      if (!labels.has("shopfloor:needs-review")) {
        return {
          skip: true,
          reason: "review_needs_review_label_absent",
        };
      }
      if (params.analysedSha && params.prNumber !== undefined) {
        try {
          const pr = await adapter.getPr(params.prNumber);
          if (pr.head.sha !== params.analysedSha) {
            return {
              skip: true,
              reason: `review_head_sha_drift_expected_${params.analysedSha.slice(0, 7)}_got_${pr.head.sha.slice(0, 7)}`,
            };
          }
        } catch (err) {
          core.warning(
            `precheck-stage: review PR fetch failed, falling open: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return { skip: false, reason: "precheck_pr_read_error_fail_open" };
        }
      }
      return { skip: false, reason: "review_preconditions_hold" };
    }
    case "handle-merge": {
      switch (params.mergedStage) {
        case "spec":
          if (labels.has("shopfloor:needs-plan")) {
            return {
              skip: true,
              reason: "handle_merge_spec_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_spec_preconditions_hold",
          };
        case "plan":
          if (labels.has("shopfloor:needs-impl")) {
            return {
              skip: true,
              reason: "handle_merge_plan_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_plan_preconditions_hold",
          };
        case "implement":
          if (labels.has("shopfloor:done")) {
            return {
              skip: true,
              reason: "handle_merge_impl_transition_already_applied",
            };
          }
          return {
            skip: false,
            reason: "handle_merge_impl_preconditions_hold",
          };
        default:
          return {
            skip: true,
            reason: `handle_merge_unknown_merged_stage_${params.mergedStage}`,
          };
      }
    }
  }
}

export async function runPrecheckStage(adapter: GitHubAdapter): Promise<void> {
  const stage = core.getInput("stage", { required: true }) as PrecheckStage;
  const issueNumber = Number(core.getInput("issue_number", { required: true }));
  const analysedSha = core.getInput("analysed_sha") || undefined;
  const prNumberInput = core.getInput("pr_number");
  const prNumber = prNumberInput ? Number(prNumberInput) : undefined;
  const mergedStageInput = core.getInput("merged_stage");
  const mergedStage = mergedStageInput
    ? (mergedStageInput as "spec" | "plan" | "implement")
    : undefined;

  const result = await precheckStage(adapter, {
    stage,
    issueNumber,
    analysedSha,
    prNumber,
    mergedStage,
  });

  core.setOutput("skip", result.skip ? "true" : "false");
  core.setOutput("reason", result.reason);
  if (result.skip) {
    core.notice(`precheck-stage: skipping ${stage} — ${result.reason}`);
  } else {
    core.info(`precheck-stage: ${stage} preconditions hold — ${result.reason}`);
  }
}
```

- [ ] **Step 2: Register the helper in `index.ts`**

In `router/src/index.ts`, add alongside other helper imports:

```ts
import { runPrecheckStage } from "./helpers/precheck-stage";
```

And a new case in the switch:

```ts
case "precheck-stage":
  return runPrecheckStage(adapter);
```

Add `precheck-stage` to the `helper` input description list in `router/action.yml`.

- [ ] **Step 3: Add inputs/outputs to `action.yml`**

In `router/action.yml`, add under the existing `stage` input section (the input already exists but repurpose description) and add:

```yaml
analysed_sha:
  {
    description: "For precheck-stage review-aggregator: the HEAD SHA the matrix analysed",
    required: false,
  }
```

Outputs block already has `skip`. Add `reason` if not present (it may not be — check the file; the current outputs only list `reason` once under the route case, which should be fine to reuse).

Review existing outputs section — `skip` and `reason` already exist. No new outputs required.

- [ ] **Step 4: Write tests covering every branch**

Create `router/test/helpers/precheck-stage.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { precheckStage } from "../../src/helpers/precheck-stage";
import { makeMockAdapter } from "./_mock-adapter";

function withLabels(
  bundle: ReturnType<typeof makeMockAdapter>,
  labels: string[],
): void {
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: labels.map((name) => ({ name })),
      state: "open",
    },
  });
}

describe("precheckStage", () => {
  describe("triage", () => {
    test("no state labels -> skip=false", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, []);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("triaging label present -> skip=false (allowed in-progress marker)", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:triaging"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("awaiting-info present -> skip=false", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:awaiting-info"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("advancement already applied -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:quick", "shopfloor:needs-impl"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toMatch(/needs-impl/);
    });
  });

  describe("spec", () => {
    test("needs-spec present, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-spec"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("marker present -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-spec", "shopfloor:spec-running"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("spec_already_in_progress");
    });

    test("needs-spec absent -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:spec-in-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("spec_needs_spec_label_absent");
    });
  });

  describe("plan", () => {
    test("needs-plan present, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan"]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "plan",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(false);
    });

    test("marker present -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan", "shopfloor:plan-running"]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "plan",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(true);
    });
  });

  describe("implement", () => {
    test("needs-impl, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-impl"]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "implement",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(false);
    });

    test("revision label (changes requested), no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, [
        "shopfloor:impl-in-review",
        "shopfloor:review-requested-changes",
      ]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "implement",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(false);
    });

    test("implementing marker -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-impl", "shopfloor:implementing"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "implement",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("implement_already_in_progress");
    });

    test("already advanced past needs-impl -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:impl-in-review"]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "implement",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(true);
    });
  });

  describe("review-aggregator", () => {
    test("needs-review present, no SHA check -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      expect(
        (
          await precheckStage(bundle.adapter, {
            stage: "review-aggregator",
            issueNumber: 42,
          })
        ).skip,
      ).toBe(false);
    });

    test("head sha drift -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      bundle.mocks.getPr.mockResolvedValueOnce({
        data: {
          head: { sha: "newsha" },
          labels: [],
          state: "open",
          draft: false,
          merged: false,
          body: "",
        },
      });
      const r = await precheckStage(bundle.adapter, {
        stage: "review-aggregator",
        issueNumber: 42,
        prNumber: 99,
        analysedSha: "oldsha1234567",
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toMatch(/drift/);
    });

    test("head sha match -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      bundle.mocks.getPr.mockResolvedValueOnce({
        data: {
          head: { sha: "samesha" },
          labels: [],
          state: "open",
          draft: false,
          merged: false,
          body: "",
        },
      });
      const r = await precheckStage(bundle.adapter, {
        stage: "review-aggregator",
        issueNumber: 42,
        prNumber: 99,
        analysedSha: "samesha",
      });
      expect(r.skip).toBe(false);
    });
  });

  describe("handle-merge", () => {
    test("spec transition already applied -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "spec",
      });
      expect(r.skip).toBe(true);
    });

    test("spec transition not yet applied -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:spec-in-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "spec",
      });
      expect(r.skip).toBe(false);
    });

    test("impl merge already done -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:done"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "implement",
      });
      expect(r.skip).toBe(true);
    });
  });

  describe("fail policy", () => {
    test("API read error -> fail open (skip=false)", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockRejectedValueOnce(new Error("boom"));
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
      expect(r.reason).toBe("precheck_read_error_fail_open");
    });
  });
});
```

- [ ] **Step 5: Run tests, typecheck, rebuild bundle**

```bash
pnpm test -- router/test/helpers/precheck-stage.test.ts
pnpm test
pnpm exec tsc --noEmit
pnpm --filter @shopfloor/router build
```

Expected: all green, bundle rebuilt.

- [ ] **Step 6: Commit**

```bash
git add router/src/helpers/precheck-stage.ts router/src/index.ts router/action.yml router/test/helpers/precheck-stage.test.ts router/dist/index.cjs
git commit -m "feat(router): add precheck-stage helper"
```

---

## Task 6: In-helper precondition assertions

**Why:** Belt-and-suspenders backstop. Even if precheck passes, state may mutate between precheck and the helper call. These assertions refuse to apply a transition whose preconditions no longer hold. Spec §5.3.3.

**Files (modify):**

- `router/src/helpers/advance-state.ts`
- `router/src/helpers/apply-triage-decision.ts`
- `router/src/helpers/apply-impl-postwork.ts`
- `router/src/helpers/aggregate-review.ts`
- `router/src/helpers/handle-merge.ts`

**Test files (modify):**

- `router/test/helpers/advance-state.test.ts`
- `router/test/helpers/apply-triage-decision.test.ts`
- `router/test/helpers/apply-impl-postwork.test.ts`
- `router/test/helpers/aggregate-review.test.ts`
- `router/test/helpers/handle-merge.test.ts`

### 6a: `advance-state` asserts `from_labels` present

- [ ] **Step 1: Add test**

Append to `router/test/helpers/advance-state.test.ts`:

```ts
test("throws when a from_label is not currently on the issue", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:other" }], state: "open" },
  });
  await expect(
    advanceState(
      bundle.adapter,
      42,
      ["shopfloor:needs-spec"],
      ["shopfloor:spec-in-review"],
    ),
  ).rejects.toThrow(/shopfloor:needs-spec/);
  expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
});
```

(If the existing test file imports a different symbol, match its pattern. If a baseline "happy path" test exists that does not prime `getIssue`, you must add `bundle.mocks.getIssue.mockResolvedValueOnce(...)` with the expected labels present so that test still passes after the assertion lands.)

- [ ] **Step 2: Implement the assertion**

Update `router/src/helpers/advance-state.ts`:

```ts
export async function advanceState(
  adapter: GitHubAdapter,
  issueNumber: number,
  fromLabels: string[],
  toLabels: string[],
): Promise<void> {
  if (fromLabels.length > 0) {
    const issue = await adapter.getIssue(issueNumber);
    const current = new Set(issue.labels.map((l) => l.name));
    const missing = fromLabels.filter((l) => !current.has(l));
    if (missing.length === fromLabels.length) {
      throw new Error(
        `advance-state: none of the expected from_labels are present on issue #${issueNumber}: [${fromLabels.join(", ")}]. Refusing to apply stale transition.`,
      );
    }
    // Soft case: at least one expected label is present. Remove only those
    // that are actually there; log the absent ones so the operator can tell.
    if (missing.length > 0) {
      core.warning(
        `advance-state: some from_labels not present on issue #${issueNumber}: [${missing.join(", ")}]`,
      );
    }
  }
  for (const l of fromLabels) await adapter.removeLabel(issueNumber, l);
  for (const l of toLabels) await adapter.addLabel(issueNumber, l);
}
```

Add `import * as core from "@actions/core";` at the top if not already imported.

Rationale for "soft" handling when some but not all are present: the existing `apply-triage-decision` call passes `["shopfloor:triaging", "shopfloor:awaiting-info"]` as `from_labels`, expecting at most one to be present. Strict full-set presence would regress that call site. Hard-fail only when ALL expected from-labels are missing (indicating a fully stale transition).

- [ ] **Step 3: Make existing tests prime getIssue as needed**

Before step 4, audit every test in `router/test/helpers/advance-state.test.ts` and every test that goes through `advanceState` indirectly (in apply-triage-decision, handle-merge, apply-impl-postwork, aggregate-review test files) and add `bundle.mocks.getIssue.mockResolvedValueOnce({ data: { labels: ..., state: "open" } })` before the call. This is the tedious part — budget 10-15 minutes for it.

- [ ] **Step 4: Run tests, adjust until green**

```bash
pnpm test -- router/test/helpers
```

Expected: all green. Fix each red test by priming `getIssue` with the correct labels for that scenario.

### 6b: `apply-triage-decision` asserts no unexpected state label

- [ ] **Step 1: Add test**

Append to `router/test/helpers/apply-triage-decision.test.ts`:

```ts
test("throws when a non-triaging state label is already present", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:needs-impl" }],
      state: "open",
    },
  });
  await expect(
    applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "…",
        clarifying_questions: [],
      },
    }),
  ).rejects.toThrow(/shopfloor:needs-impl/);
  expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add the assertion**

At the top of `applyTriageDecision`, before the branch on `decision.status`:

```ts
const issue = await adapter.getIssue(issueNumber);
const current = new Set(
  (issue.labels as Array<{ name: string }>).map((l) => l.name),
);
const UNEXPECTED = [
  "shopfloor:needs-spec",
  "shopfloor:spec-in-review",
  "shopfloor:needs-plan",
  "shopfloor:plan-in-review",
  "shopfloor:needs-impl",
  "shopfloor:impl-in-review",
  "shopfloor:needs-review",
  "shopfloor:review-requested-changes",
  "shopfloor:review-approved",
  "shopfloor:review-stuck",
  "shopfloor:done",
];
for (const l of UNEXPECTED) {
  if (current.has(l)) {
    throw new Error(
      `apply-triage-decision: refusing to re-triage issue #${issueNumber}: unexpected state label '${l}' is already present.`,
    );
  }
}
```

- [ ] **Step 3: Run tests until green, keeping existing tests primed with the triaging-only label set**

### 6c: `apply-impl-postwork` asserts `implementing` marker present, removes it

- [ ] **Step 1: Test**

Append to `router/test/helpers/apply-impl-postwork.test.ts`:

```ts
test("throws when shopfloor:implementing marker is not present", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:needs-impl" }], state: "open" },
  });
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      labels: [],
      state: "open",
      draft: false,
      merged: false,
      head: { sha: "x" },
      body: "",
    },
  });
  await expect(
    applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: "t",
      prBody: "b",
    }),
  ).rejects.toThrow(/implementing/);
});

test("removes shopfloor:implementing as part of the transition", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [
        { name: "shopfloor:needs-impl" },
        { name: "shopfloor:implementing" },
      ],
      state: "open",
    },
  });
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      labels: [],
      state: "open",
      draft: false,
      merged: false,
      head: { sha: "x" },
      body: "",
    },
  });
  await applyImplPostwork(bundle.adapter, {
    issueNumber: 42,
    prNumber: 45,
    prTitle: "t",
    prBody: "b",
  });
  expect(bundle.mocks.removeLabel).toHaveBeenCalledWith(
    expect.objectContaining({ name: "shopfloor:implementing" }),
  );
});
```

- [ ] **Step 2: Implement**

In `router/src/helpers/apply-impl-postwork.ts`, at the top of `applyImplPostwork`:

```ts
const issue = await adapter.getIssue(params.issueNumber);
const current = new Set(
  (issue.labels as Array<{ name: string }>).map((l) => l.name),
);
if (!current.has("shopfloor:implementing")) {
  throw new Error(
    `apply-impl-postwork: refusing to finalize implement for issue #${params.issueNumber}: shopfloor:implementing marker is not present. Either the impl job did not add it (wiring bug) or a crash left the issue in an ambiguous state.`,
  );
}
```

And add the removal alongside the existing removes near the end of the happy path:

```ts
await adapter.removeLabel(params.issueNumber, "shopfloor:implementing");
```

### 6d: `aggregate-review` asserts head-SHA match

- [ ] **Step 1: Test**

Append to `router/test/helpers/aggregate-review.test.ts`:

```ts
test("exits no-op when PR head SHA has drifted from the analysed SHA", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      head: { sha: "newsha" },
      body: "Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
    },
  });
  await aggregateReview(bundle.adapter, {
    issueNumber: 42,
    prNumber: 45,
    confidenceThreshold: 80,
    maxIterations: 3,
    analysedSha: "oldsha",
    reviewerOutputs: {
      compliance: fixture("compliance-issues"),
      bugs: fixture("bugs-clean"),
      security: fixture("security-clean"),
      smells: fixture("smells-clean"),
    },
  });
  expect(bundle.mocks.createReview).not.toHaveBeenCalled();
  expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement**

Add `analysedSha?: string` to `AggregateReviewParams`. In `aggregateReview`, right after `headSha = pr.head.sha`:

```ts
if (params.analysedSha && params.analysedSha !== headSha) {
  core.notice(
    `aggregateReview: PR #${params.prNumber} head sha drifted (analysed ${params.analysedSha}, current ${headSha}); exiting no-op.`,
  );
  return;
}
```

Thread `analysed_sha` from `runAggregateReview`:

```ts
analysedSha: core.getInput("analysed_sha") || undefined,
```

Add `analysed_sha` input description under the aggregate-review block in `router/action.yml`:

```yaml
analysed_sha:
  {
    description: "For aggregate-review: PR HEAD SHA that the matrix cells analysed. Aggregator exits no-op if the PR has since advanced.",
    required: false,
  }
```

### 6e: `handle-merge` asserts transition not already applied

- [ ] **Step 1: Test**

Append to `router/test/helpers/handle-merge.test.ts`:

```ts
test("is idempotent when spec transition is already applied", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:needs-plan" }],
      state: "open",
    },
  });
  await handleMerge(bundle.adapter, {
    issueNumber: 42,
    mergedStage: "spec",
    prNumber: 7,
  });
  expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
  expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
  expect(bundle.mocks.createComment).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement**

At the top of `handleMerge`:

```ts
const issue = await adapter.getIssue(params.issueNumber);
const current = new Set(
  (issue.labels as Array<{ name: string }>).map((l) => l.name),
);
const alreadyApplied =
  (params.mergedStage === "spec" && current.has("shopfloor:needs-plan")) ||
  (params.mergedStage === "plan" && current.has("shopfloor:needs-impl")) ||
  (params.mergedStage === "implement" && current.has("shopfloor:done"));
if (alreadyApplied) {
  core.info(
    `handle-merge: ${params.mergedStage} transition already applied for issue #${params.issueNumber}, exiting no-op`,
  );
  return;
}
```

Add `import * as core from "@actions/core";` if not already imported.

### 6f: Cleanup and commit

- [ ] **Step 1: Full sweep**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm --filter @shopfloor/router build
```

Expected: all green, bundle up-to-date.

- [ ] **Step 2: Commit**

```bash
git add router/src/helpers/ router/test/helpers/ router/action.yml router/dist/index.cjs
git commit -m "feat(helpers): add in-helper precondition assertions"
```

---

## Task 7: Workflow — per-stage concurrency groups and precheck wiring

**Why:** The single biggest change. Removes workflow-level concurrency, adds per-stage groups, threads precheck into every mutating job, adds marker-label creation. Spec §5.1, §5.5, §8.2.

**Files:**

- Modify: `.github/workflows/shopfloor.yml`

**Rules to not violate while editing the workflow (hard-earned — see CLAUDE.md gotchas):**

1. `secrets` context is not available in job-level `if:` expressions. Do not introduce `if: secrets.foo` anywhere.
2. Every `actions/checkout` must keep `persist-credentials: false`.
3. `$RUNNER_TEMP` in claude_args is not expanded — use `${{ runner.temp }}`.
4. Template expressions inside `run:` shell comments are still parsed. Do not leave `${{ }}` in a shell comment.
5. Empty strings are falsy in expression ternaries. If you need a conditional string default, emit it via a `run:` step output.

### 7a: Remove workflow-level concurrency, add per-stage groups

- [ ] **Step 1: Delete the workflow-level `concurrency:` block** (currently at `.github/workflows/shopfloor.yml:87-89`).

- [ ] **Step 2: Add `concurrency:` to each mutating job**

Per spec §5.1, the groups are:

| Job                 | Group                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `triage`            | `shopfloor-triage-${{ needs.route.outputs.issue_number }}`               |
| `spec`              | `shopfloor-spec-${{ needs.route.outputs.issue_number }}`                 |
| `plan`              | `shopfloor-plan-${{ needs.route.outputs.issue_number }}`                 |
| `implement`         | `shopfloor-implement-${{ needs.route.outputs.issue_number }}`            |
| `review-aggregator` | `shopfloor-implement-${{ needs.route.outputs.issue_number }}` **shared** |
| `handle-merge`      | `shopfloor-implement-${{ needs.route.outputs.issue_number }}` **shared** |

All use `cancel-in-progress: false`. Example:

```yaml
triage:
  needs: route
  if: needs.route.outputs.stage == 'triage'
  concurrency:
    group: shopfloor-triage-${{ needs.route.outputs.issue_number }}
    cancel-in-progress: false
  runs-on: ubuntu-latest
  # …rest unchanged
```

`route`, `review-skip-check`, and the four matrix cells (`review-compliance`, `review-bugs`, `review-security`, `review-smells`) stay un-grouped.

### 7b: Add the precheck step to every mutating job

The precheck runs after `actions/checkout` and the App token mint (so the router has a token to call the API with) and before any mutation. Capture its id so subsequent steps can gate on it.

- [ ] **Step 1: `triage` job**

Insert after the `Mint GitHub App token` step and before `Build triage context`:

```yaml
- name: Precheck triage preconditions
  id: precheck
  uses: ./router
  with:
    helper: precheck-stage
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    stage: triage
    issue_number: ${{ needs.route.outputs.issue_number }}
- name: Log precheck skip
  if: steps.precheck.outputs.skip == 'true'
  run: echo "::notice title=Shopfloor triage skipped::${{ steps.precheck.outputs.reason }}"
```

Gate every subsequent step in the job on `if: steps.precheck.outputs.skip != 'true'`. That includes:

- `Build triage context`
- `Render triage prompt`
- `agent` (claude-code-action)
- `Apply triage decision`

The failure-handling step (`Report failure` with `if: failure()`) stays un-gated so precheck-internal errors still surface.

**Watch out:** preserving `if: success()` / `if: failure()` semantics. Change them to combined conditions:

```yaml
if: success() && steps.precheck.outputs.skip != 'true'
```

or

```yaml
if: failure() && steps.precheck.outputs.skip != 'true'
```

- [ ] **Step 2: `spec` job**

After the `Mint GitHub App token` + `Reconfigure git remote` steps, insert:

```yaml
- name: Precheck spec preconditions
  id: precheck
  uses: ./router
  with:
    helper: precheck-stage
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    stage: spec
    issue_number: ${{ needs.route.outputs.issue_number }}
- name: Log precheck skip
  if: steps.precheck.outputs.skip == 'true'
  run: echo "::notice title=Shopfloor spec skipped::${{ steps.precheck.outputs.reason }}"
- name: Mark spec as running
  if: steps.precheck.outputs.skip != 'true'
  uses: ./router
  with:
    helper: advance-state
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    issue_number: ${{ needs.route.outputs.issue_number }}
    from_labels: ""
    to_labels: shopfloor:spec-running
```

Gate every subsequent step in the job on `if: steps.precheck.outputs.skip != 'true'` (or combined with existing `success()` / `failure()`).

**Also** update the existing `Advance state to spec-in-review` step's `from_labels` to include the marker so it is cleared atomically:

```yaml
from_labels: shopfloor:needs-spec,shopfloor:triaging,shopfloor:spec-running
to_labels: shopfloor:spec-in-review
```

- [ ] **Step 3: `plan` job**

Same shape as `spec`. Marker label is `shopfloor:plan-running`. Update the terminal `Advance state to plan-in-review` step to include the marker in `from_labels`.

- [ ] **Step 4: `implement` job**

Same shape, more wiring. Marker label is `shopfloor:implementing`. The `Create impl branch` / initial push step and everything downstream must be gated on the precheck skip.

- Insert the precheck step after the pre-agent token mint, before `Create impl branch`.
- Insert a `Mark implement as running` step that adds `shopfloor:implementing` via `advance-state` (from_labels empty, to_labels `shopfloor:implementing`), gated on `if: steps.precheck.outputs.skip != 'true'`. Place it right after the precheck so any subsequent crash before completion still leaves the marker visible (intentional — precheck on the next queued run will then bail).
- The existing `Apply impl postwork` step already handles removing `shopfloor:implementing` via the Task 6c change, so no further wiring is needed there.
- Gate every downstream step on `if: <existing condition> && steps.precheck.outputs.skip != 'true'`. The post-agent `Mint post-agent GitHub App token`, `Reconfigure git remote with App token for push`, `Push impl commits`, `Mark impl PR ready for review`, `Finalize progress comment`, `Apply impl postwork`, and `Report failure` steps all need the guard added.

  **Exception:** `Finalize progress comment` uses `if: always()`. Change it to:

  ```yaml
  if: always() && steps.precheck.outputs.skip != 'true'
  ```

- [ ] **Step 5: `review-aggregator` job**

The review-aggregator precheck needs the analysed SHA. Add a step that reads the PR head SHA from the payload (for the `pull_request.synchronize`/`ready_for_review` event, `${{ github.event.pull_request.head.sha }}` is the SHA the matrix cells just ran against).

```yaml
- name: Precheck review preconditions
  id: precheck
  uses: ./router
  with:
    helper: precheck-stage
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    stage: review-aggregator
    issue_number: ${{ needs.route.outputs.issue_number }}
    pr_number: ${{ needs.route.outputs.impl_pr_number }}
    analysed_sha: ${{ github.event.pull_request.head.sha }}
```

Gate the aggregator's single `- uses: ./router` step with `if: steps.precheck.outputs.skip != 'true'`. Pass `analysed_sha` into the aggregate-review helper invocation so the in-helper assertion has the same reference:

```yaml
- if: steps.precheck.outputs.skip != 'true'
  uses: ./router
  with:
    helper: aggregate-review
    # …existing inputs…
    analysed_sha: ${{ github.event.pull_request.head.sha }}
```

- [ ] **Step 6: `handle-merge` job**

```yaml
- name: Precheck handle-merge preconditions
  id: precheck
  uses: ./router
  with:
    helper: precheck-stage
    github_token: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
    stage: handle-merge
    issue_number: ${{ needs.route.outputs.issue_number }}
    merged_stage: ${{ steps.parse_merged_stage.outputs.merged_stage }}
```

Place this step AFTER `parse_merged_stage` (which computes `merged_stage`) and AFTER the app_token mint. Gate the terminal `- uses: ./router` helper on `if: steps.precheck.outputs.skip != 'true'`.

### 7c: Workflow validation

- [ ] **Step 1: Parse-check the YAML**

```bash
pnpm dlx @action-validator/cli .github/workflows/shopfloor.yml
```

(If `@action-validator/cli` is unavailable, use `actionlint` or `yamllint` — any YAML parser that rejects bad expressions. At minimum, `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml'))"` catches pure-YAML breakage.)

- [ ] **Step 2: Grep audit for the `secrets` in job `if:` gotcha**

```bash
pnpm exec grep -nE '^\s*if:.*secrets\.' .github/workflows/shopfloor.yml || true
```

Expected: zero matches inside a job-level `if:`. Matches inside step-level `if:` or `env:` are fine.

Actually skip the pnpm exec — use the Grep tool during implementation instead; `rg` works too.

- [ ] **Step 3: Grep audit for missing precheck gates**

For each of `triage`, `spec`, `plan`, `implement`, `review-aggregator`, `handle-merge`, visually inspect the job and count non-`precheck` steps. Every such step should have `steps.precheck.outputs.skip != 'true'` in its `if:`. This is the "missing guard leaves a mutation live" gotcha from spec §9.1.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): per-stage concurrency groups and precheck wiring"
```

---

## Task 8: Close the spec

- [ ] **Step 1: Flip spec status to Accepted**

In `docs/superpowers/specs/2026-04-15-shopfloor-concurrency-fix.md`, change `**Status:** Draft, pending review` to `**Status:** Accepted`. In §15, link the 8 landed commits by SHA once known:

```bash
git log --oneline -9 main..HEAD
```

Copy the SHAs into §15.

- [ ] **Step 2: Prettier**

```bash
pnpm format
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-15-shopfloor-concurrency-fix.md
git commit -m "docs(spec): close the concurrency-fix spec"
```

---

## Task 9: Troubleshooting runbook

- [ ] **Step 1: Add recovery section to troubleshooting**

Open `docs/shopfloor/troubleshooting.md`. Append:

````markdown
## Stalled pipeline recovery

**Symptom:** An issue is carrying `shopfloor:needs-spec` / `shopfloor:needs-plan` / `shopfloor:needs-impl` but the corresponding stage job never ran, OR a stage job shows a precheck-skip notice with `reason=*_already_in_progress` after a crash.

**Cause:** One of:

1. GitHub dropped the advancement `labeled` event (the original §2.1 failure mode this fix closes — should no longer occur).
2. A runner crashed mid-stage and left a `shopfloor:spec-running` / `plan-running` / `implementing` marker label orphaned. Subsequent stage jobs will precheck-skip until the marker is cleared.

**Recovery:**

```bash
# Replace <N> with the issue number.
N=123

# 1. If there is an orphaned marker, remove it:
gh issue edit $N --remove-label shopfloor:implementing \
  --remove-label shopfloor:spec-running \
  --remove-label shopfloor:plan-running

# 2. Re-fire the advancement event by cycling the expected next-state label:
EXPECTED=shopfloor:needs-impl   # or needs-spec / needs-plan as appropriate
gh issue edit $N --remove-label "$EXPECTED"
gh issue edit $N --add-label "$EXPECTED"
```

The add-label event is delivered via the Shopfloor GitHub App's installation token by `gh` on behalf of you (not via `GITHUB_TOKEN`), so the downstream workflow fires cleanly. The per-stage concurrency queue is empty by this point, so the new stage job runs without contention.
````

- [ ] **Step 2: Prettier**

```bash
pnpm format
```

- [ ] **Step 3: Commit**

```bash
git add docs/shopfloor/troubleshooting.md
git commit -m "docs(troubleshooting): runbook for stalled pipeline recovery"
```

---

## Post-tasks: Final verification and handoff

- [ ] **Step 1: Full sweep**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm format:check
pnpm --filter @shopfloor/router build
git diff router/dist/index.cjs
```

Expected: all green, dist bundle matches source (no diff after build).

- [ ] **Step 2: Commit the rebuilt bundle if it drifted**

If `git diff router/dist/index.cjs` shows changes after the final build, amending is forbidden — create a new commit:

```bash
git add router/dist/index.cjs
git commit -m "chore(router): rebuild dist bundle"
```

Better: rebuild after every task that touches `router/src/**` so the dist never drifts across the branch history.

- [ ] **Step 3: Sanity-check the commit ordering**

```bash
git log --oneline main..HEAD
```

Expected: nine or ten commits matching the order in the top-of-plan table.

- [ ] **Step 4: Push when the user asks**

Do not push without explicit user instruction. The branch is local-only until then.

- [ ] **Step 5: After merge, dogfood monitoring**

For the next 2-3 Shopfloor runs on real issues:

1. Watch the Actions tab for `precheck-stage: skipping …` notices. Expected on genuine duplicate-event / redelivery scenarios. Unexpected on first-runs, which would indicate a precondition is too tight.
2. If a first-run precheck-skips, the fail-closed policy is over-eager; file a follow-up issue and tighten the precondition.
3. Closing §2.1's failure mode on a live dogfood run is the acceptance criterion per spec §10.

---

## Appendix: Skills to pull in

- For any task in §6 where a test is getting complex, use **superpowers:test-driven-development** — the red/green/refactor discipline keeps in-helper assertions from over-specifying.
- For the workflow surgery in §7, use **superpowers:debugging** if a CI run fails on the first attempt. Do not guess at what broke; read the run log.
- Once all tasks are complete, use **superpowers:finishing-a-development-branch** to route the branch to its landing option (PR vs direct merge on main vs something else).
