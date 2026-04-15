# E2E tests — Layer 2: workflow YAML tests via act-js + mock-github

**Status:** Draft (deferred — implement after Layer 1)
**Date:** 2026-04-15
**Author:** brainstormed with Claude
**Related:** `2026-04-15-e2e-tests-layer-1-design.md` (implement first)

## Summary

Add a small, focused suite of workflow-level tests that run `shopfloor.yml` in Docker via [`@kie/act-js`](https://github.com/kiegroup/act-js) (a wrapper around nektos/act) with [`@kie/mock-github`](https://github.com/kiegroup/mock-github) providing local repos, env vars, and HTTP API interception. The goal is to catch the YAML wiring bugs that Layer 1 cannot see by construction: job-level `if:` conditions, output flow between jobs, secret-derived flag patterns, and `claude_args` env var expansion.

This is "Layer 2" of a two-layer e2e strategy. **It depends on Layer 1 only for shared event fixtures.** Layer 1 ships first; Layer 2 ships independently after.

## Scope and motivation

Read this first so we don't accidentally re-litigate the framing.

### What Layer 2 sees that Layer 1 doesn't

`act` runs **one event through one workflow invocation per test**. It does NOT simulate "label flip in job A triggers a fresh workflow run for job B" — that's GitHub-server-side behavior. Every Layer 2 test is therefore single-webhook in scope: _given this event payload, did the workflow execute the right job graph and produce the right outputs?_

That constraint shapes the catalog. Layer 2 tests answer **wiring** questions, not lifecycle questions. Lifecycles stay in Layer 1.

| Concern                                                  | Layer 1 catches                  | Layer 2 catches    |
| -------------------------------------------------------- | -------------------------------- | ------------------ |
| Helper logic, state machine, retry loops                 | ✓                                |                    |
| Job-graph drift between code and YAML                    | partial (via assertion mismatch) | ✓                  |
| `if:` conditionals on job-level outputs                  |                                  | ✓                  |
| Secret-to-output-string flag pattern (`has_review_app`)  |                                  | ✓                  |
| Env var flow between `run:` steps                        |                                  | ✓                  |
| `claude_args` parsing of `${{ runner.temp }}` literals   |                                  | ✓                  |
| `persist-credentials: false` invariant on every checkout |                                  | ✓ (YAML lint)      |
| `secrets.GITHUB_TOKEN` does-not-fire-downstream behavior | ✗                                | ✗ (GitHub-only)    |
| `actions/checkout` extraheader credential override       | ✗                                | ✗ (GitHub-only)    |
| Real claude-code-action prompt behavior                  | ✗ (separate suite)               | ✗ (separate suite) |

The two ✗-✗ rows are accepted as residual risk. Dogfooding via `dogfood.yml` catches them informally. We document this clearly in the README so contributors don't think Layer 2 is more comprehensive than it is.

### Why now (or at least, why eventually)

The CLAUDE.md "GitHub Actions gotchas" section catalogues seven hard-earned lessons. Five of them are workflow-wiring bugs (the other two are GitHub-server-only and unreachable from any test layer). Those five are the failure mode this layer exists to prevent.

## Goals

- **Catch YAML wiring regressions** for the gotchas in CLAUDE.md that Layer 1 cannot see.
- **Pin invariants permanently** via tests that fail loudly when someone "fixes" them back to the broken pattern. Specifically: `persist-credentials: false` on every checkout, the `has_review_app` output-string pattern, and `${{ runner.temp }}` literal expansion in claude_args.
- **Stay tightly scoped.** Five tests for v1, plus one optional sixth. Adding more is cheap once the harness exists, but five gives full coverage of the failure modes Layer 1 can't see.
- **Be opt-in by default.** The Docker tax is real. Default `pnpm test` should not pay it.

## Non-goals

- **Lifecycle testing.** Multi-event flows stay in Layer 1.
- **Replacing dogfooding.** `dogfood.yml` continues to be the only thing that exercises real claude-code-action and real GitHub-server behavior.
- **Catching every YAML gotcha.** Some are GitHub-server-only and unreachable.
- **Building Layer 1 capabilities.** This spec assumes Layer 1's `FakeGitHub` and `ScenarioHarness` exist; they are not used by Layer 2 directly. The only shared asset is the `router/test/fixtures/events/*.json` directory.

## Dependencies on Layer 1

- **Reused:** `router/test/fixtures/events/*.json` (the existing webhook payload fixtures).
- **Not reused:** `FakeGitHub`, `ScenarioHarness`, `job-graph.ts`, agent stub, vitest setup file, dual-token model. Layer 2 has its own harness and its own mocking model.
- **Implementation order:** Layer 1 must ship first because it provides the fixtures we patch. Once shipped, Layer 2 has no further dependency on Layer 1 development.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  router/test/workflow/                                      │
│                                                             │
│  vitest test files import a shared act-runner.ts harness    │
│  that:                                                      │
│    1. Builds a temp git repo via mock-github MockGithub,    │
│       copying .github/ from this repo into it               │
│    2. Sets up Moctokit with queued API responses            │
│    3. Invokes act-js Act.runEventAndJob() in Docker         │
│    4. Stubs claude-code-action steps via mockSteps          │
│    5. Asserts on the returned Step[] array                  │
└─────────────────────────────────────────────────────────────┘
```

### What about the YAML lint test (W5)?

W5 is a special case. It does not need `act`, Docker, or Moctokit. It parses `shopfloor.yml` with a YAML library and walks every step. It runs in **~10ms** in the default `pnpm test` run, even though it's nominally a "Layer 2" concern. Treat it as a YAML invariant test, not a workflow execution test.

## Setup

```ts
// router/test/workflow/helpers/act-runner.ts
import { Act } from "@kie/act-js";
import { MockGithub, Moctokit } from "@kie/mock-github";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../..",
);

export interface WorkflowHarnessOpts {
  /** which event to deliver; loaded from router/test/fixtures/events/ */
  eventFixture: string;
  /** inputs to pass to the reusable shopfloor.yml */
  inputs?: Record<string, string>;
  /** secrets to set on the act run */
  secrets?: Record<string, string>;
  /** mock-github config (repo files, branches, env) */
  mockGithub?: MockGithubConfig;
  /** mockSteps overrides for claude-code-action and other steps */
  mockSteps?: Record<string, MockStep[]>;
  /** Moctokit setup callback for queueing API responses */
  setupApi?: (m: Moctokit) => void;
}

export async function runWorkflow(
  opts: WorkflowHarnessOpts,
): Promise<RunResult> {
  const mockGithub = new MockGithub({
    repo: {
      "test-target": {
        pushedBranches: ["main"],
        currentBranch: "main",
        files: [{ src: path.join(REPO_ROOT, ".github"), dest: ".github" }],
      },
    },
    env: { ...opts.env },
    action: { input: { ...opts.inputs } },
  });
  await mockGithub.setup();

  const moctokit = new Moctokit();
  opts.setupApi?.(moctokit);

  const act = new Act(mockGithub.getPath("test-target"))
    .setEvent(loadEventFixture(opts.eventFixture))
    .setSecret("APP_PRIVATE_KEY", "fake-key")
    .setSecret("ANTHROPIC_API_KEY", "fake-key");

  for (const [k, v] of Object.entries(opts.secrets ?? {})) {
    act.setSecret(k, v);
  }

  try {
    return await act.runEventAndJob("issues", "shopfloor", {
      mockApi: moctokit,
      mockSteps: opts.mockSteps,
      cwd: mockGithub.getPath("test-target"),
    });
  } finally {
    await mockGithub.teardown();
  }
}
```

### Things to call out

1. **The mock repo gets the real `.github/` directory copied in** via `MockGithub`'s `files` config. This means the test always runs against current `shopfloor.yml`, no fixture drift.
2. **A synthetic caller workflow** (`router/test/workflow/fixtures/test-caller.yml`) lives alongside the test. It's a tiny `workflow_call`-style caller that maps test inputs into `shopfloor.yml` invocation, mirroring the dogfood workflow's structure but parameterized for tests. We test `test-caller.yml`, which transitively tests `shopfloor.yml`.
3. **Moctokit is request-replay**, so each test enumerates only the API calls it expects. If the workflow makes more calls than mocked, Moctokit fails with "no matching mock" — also a useful signal.
4. **All claude-code-action steps stubbed by default.** Verified by grep: `shopfloor.yml` has eight `id: agent` steps (one per job that runs claude-code-action), all sharing the same `id`. They are distinguished only by their parent job. `@kie/act-js`'s `mockSteps` API keys by `(jobId, stepIdOrName)` — confirm during implementation by reading the act-js source — so the shared map in `mock-step-stubs.ts` is structured as `Record<JobId, MockStep[]>` and each entry stubs the `agent` step for that job:

   ```ts
   const defaultMockSteps: Record<string, MockStep[]> = {
     triage:            [{ id: "agent", mockWith: 'echo \'{"complexity":"medium"}\' >> $GITHUB_OUTPUT' }],
     spec:              [{ id: "agent", mockWith: "..." }],
     plan:              [{ id: "agent", mockWith: "..." }],
     implement:         [{ id: "agent", mockWith: "..." }],
     "review-compliance": [{ id: "agent", mockWith: "..." }],
     "review-bugs":       [{ id: "agent", mockWith: "..." }],
     "review-security":   [{ id: "agent", mockWith: "..." }],
     "review-smells":     [{ id: "agent", mockWith: "..." }],
   };
   ```

   If act-js's `mockSteps` actually keys differently (some versions key only by step id with the result that all eight `agent` steps collide), the implementation switches to the `mockWith` payload being a function that reads `GITHUB_JOB` and dispatches accordingly. **This is the single biggest unknown in the L2 design and must be resolved by reading the @kie/act-js source before locking in the harness shape.** Treat it as a research item in the implementation plan.

5. **Sanity assertion on stub coverage.** Before invoking act, the harness loads the workflow YAML, enumerates the eight `(jobId, agent)` tuples, and asserts every one is covered by a mockStep entry. Without this, a renamed job silently runs the real action (which would call Anthropic in CI). ~30 LoC of harness code, prevents an expensive class of mistakes.

---

## The five tests

Tight, focused, each one answering a single wiring question. Adding more is cheap once the harness exists, but five gives full coverage of the failure modes Layer 1 can't see.

### W1 — `workflow-parses.test.ts`

Smoke test. The cheapest, fastest, most valuable.

```ts
test("shopfloor.yml parses and lists expected jobs", async () => {
  const act = new Act(REPO_ROOT);
  const workflows = await act.list();
  const shopfloor = workflows.find((w) => w.workflowName === "Shopfloor");
  expect(shopfloor).toBeDefined();
  expect(shopfloor!.events).toContain("workflow_call");

  // Verified against .github/workflows/shopfloor.yml: 12 jobs total. The
  // review stage is split into 6 jobs (one skip-check, four parallel
  // reviewers, one aggregator). report-failure is a router *helper*
  // invoked as a step inside other jobs, NOT a standalone job — do not
  // include it here.
  const jobIds = workflows
    .filter((w) => w.workflowName === "Shopfloor")
    .map((w) => w.jobId);
  expect(jobIds).toEqual(
    expect.arrayContaining([
      "route",
      "triage",
      "spec",
      "plan",
      "implement",
      "review-skip-check",
      "review-compliance",
      "review-bugs",
      "review-security",
      "review-smells",
      "review-aggregator",
      "handle-merge",
    ]),
  );
});
```

**Catches:** any YAML parse error, any structural drift in the job set, the "template expression in shell comment" gotcha (parser fails). No Docker required for `act.list()`. Runs in ~500ms.

### W2 — `route-dispatch.test.ts`

The route job's outputs correctly gate downstream jobs.

Sub-tests, one per webhook -> stage mapping (job names verified against `shopfloor.yml`):

- `issue-labeled-trigger-label-added.json` -> route runs -> only `triage` job runs downstream
- `issue-labeled-needs-spec.json` -> route runs -> only `spec` job runs
- `issue-labeled-needs-plan-no-title.json` -> route runs -> only `plan` job runs
- Implement first-run case (route output `revision_mode=false`) -> the implement job runs and the **`Create impl branch`** + **`open_pr`** + inline **`Build implement context`** (`id: ctx`) steps execute; the **`Checkout existing impl branch`**, **`Resolve existing impl PR number`**, and **`Build revision context`** (`id: ctx_revision`) steps are skipped.
- Implement revision-run case (route output `revision_mode=true`, `impl_pr_number` populated) -> the implement job runs and the inverse holds: the revision-mode steps execute and the first-run steps are skipped.
- `pr-ready-for-review-impl.json` -> route runs -> the six review jobs run (`review-skip-check`, `review-compliance`, `review-bugs`, `review-security`, `review-smells`, `review-aggregator`)
- `pr-closed-merged-spec.json` -> route runs -> only the `handle-merge` job runs

Each sub-test asserts on the returned `Step[]`: which jobs reported `status: 0` and which were `skipped`, AND for the implement cases, which **steps within the implement job** ran vs. were skipped. **Catches:** broken `if:` expressions on jobs and on the revision-mode step gates (added in commit `9545585`), output name typos, empty-string ternary bugs, and any future regression of the revision-mode fork.

Note on the review case: when the workflow gates on `review-skip-check`'s output, the four reviewer jobs and aggregator are correctly skipped by act when the skip flag is true. The test should verify both (a) the skip path leaves four reviewers as `skipped` and (b) the non-skip path runs all six. That makes seven sub-tests in total, not five — reframe accordingly during implementation.

### W3 — `has-review-app-gating.test.ts`

The most fragile pattern in the workflow per CLAUDE.md. Highest test ROI.

Two cases:

- With `SHOPFLOOR_GITHUB_APP_REVIEW_APP_ID` secret set -> `route.outputs.has_review_app == 'true'` -> the aggregate step (`id: aggregate` inside the `review-aggregator` job) uses the review token
- Without that secret -> `route.outputs.has_review_app == 'false'` -> aggregate falls back to primary token

Asserts on the resolved `INPUT_REVIEW_GITHUB_TOKEN` env var passed to the aggregator step. The actual step ID is `aggregate` (not `aggregate-review`); the helper invocation is `helper: aggregate-review`. Don't confuse the two when wiring the mockSteps key. Captured via a Moctokit assertion or a mockSteps inspector around the aggregator step.

**Catches:** if anyone "fixes" this back to `if: secrets.foo != ''`, this test fails immediately and the failure message points right at the gotcha.

### W4 — `runner-temp-plumbing.test.ts`

The `$RUNNER_TEMP` / `${{ runner.temp }}` expansion gotcha.

Fires the triage stage. Stubs the `agent` step inside the `triage` job (via `mockSteps.triage[0]`) with a mockStep that writes `decision_json` containing the literal string `${{ runner.temp }}` (which should NOT be expanded by the parser). Asserts the next router step receives the literal string, proving the resolved-path-output-step pattern works.

**Catches:** regression of the `claude_args` env var expansion bug from CLAUDE.md.

### W5 — `checkout-credentials-invariant.test.ts`

YAML lint. Doesn't need Docker. Doesn't need act-js. Just parses the YAML and walks every step.

```ts
test("every actions/checkout step has persist-credentials: false", async () => {
  const yaml = await fs.readFile(
    path.join(REPO_ROOT, ".github/workflows/shopfloor.yml"),
    "utf8",
  );
  const parsed = parseYaml(yaml);
  const violations: string[] = [];
  walkSteps(parsed, (step, location) => {
    if (
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@")
    ) {
      if (step.with?.["persist-credentials"] !== false) {
        violations.push(location);
      }
    }
  });
  expect(violations).toEqual([]);
});
```

**Catches:** any new checkout step that forgets the flag. Permanently encodes the CLAUDE.md gotcha as a test invariant.

This test does NOT need Docker and runs in ~10ms. We put it in `router/test/lint/` (a sibling of `router/test/workflow/`, NOT inside it) so the default vitest include picks it up automatically while the workflow-only exclude does not match it. **It runs in the default `pnpm test`**, not just `pnpm test:workflow`. The expensive ones (W1-W4) stay opt-in. See "File layout" and "Vitest config" below for why this split exists.

### W6 — `agent-output-flow.test.ts` (optional)

End-to-end stub-to-router data flow for one stage.

Triggers the triage stage. Stubs the `agent` step inside the `triage` job (via `mockSteps.triage[0]`) to emit `decision_json: '{"complexity":"medium",...}'` as a step output. Asserts that `apply-triage-decision`'s `INPUT_DECISION_JSON` receives exactly that string and that the step exits successfully.

This is the closest Layer 2 gets to lifecycle testing. It's redundant with Layer 1 in spirit, but it validates the YAML-side wiring (`outputs:` -> `with:`) that Layer 1 cannot see. **Recommendation:** include it. Marginal cost, real value.

---

## File layout

The lint test (W5) lives **outside** `router/test/workflow/` so it is naturally picked up by the default vitest include without needing negation re-include patterns (which vitest's `exclude` does not support). Everything that requires Docker stays in `router/test/workflow/`, which is excluded from the default suite via a flat `exclude` glob.

```
router/test/
├── lint/                                        # NEW — runs in default pnpm test
│   └── checkout-credentials-invariant.test.ts   # W5
└── workflow/                                    # NEW — opt-in via pnpm test:workflow
    ├── README.md                                # what L2 catches and what it doesn't
    ├── helpers/
    │   ├── act-runner.ts                        # WorkflowHarness wrapper
    │   ├── mock-step-stubs.ts                   # canned claude-code-action stubs
    │   └── load-event-fixture.ts                # shared with L1 fixtures dir
    ├── fixtures/
    │   └── test-caller.yml                      # synthetic workflow_call caller
    ├── workflow-parses.test.ts                  # W1
    ├── route-dispatch.test.ts                   # W2
    ├── has-review-app-gating.test.ts            # W3
    ├── runner-temp-plumbing.test.ts             # W4
    └── agent-output-flow.test.ts                # W6 (if included)
```

## Vitest config

Two configs. The default config excludes `router/test/workflow/**` outright. A separate `vitest.workflow.config.ts` runs only the workflow tests via `pnpm test:workflow`.

```ts
// vitest.config.ts (diff to existing config)
test: {
  include: [
    "router/test/**/*.test.ts",         // unchanged — picks up router/test/lint/**
    "mcp-servers/**/test/**/*.test.ts", // unchanged
    "test/e2e/**/*.test.ts",             // unchanged
  ],
  exclude: [
    "node_modules/**",                   // unchanged
    "router/test/workflow/**",           // NEW — keep Docker tests out of default
  ],
}
```

```ts
// vitest.workflow.config.ts (NEW file)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["router/test/workflow/**/*.test.ts"],
    testTimeout: 60_000, // act + Docker is slow
    retry: 1, // tolerate one Docker hiccup
  },
});
```

This split avoids vitest's lack of negation re-include in `exclude` (verified: vitest uses anymatch globs and does not interpret leading `!` as re-inclusion the way ripgrep does). Putting the lint test in a sibling directory is a one-line decision that sidesteps an entire class of config drift.

## pnpm scripts

```jsonc
// package.json (diff)
{
  "scripts": {
    "test:workflow": "vitest run --config vitest.workflow.config.ts", // NEW
    "test:workflow:watch": "vitest --config vitest.workflow.config.ts", // NEW
  },
}
```

## New dependencies

```jsonc
"devDependencies": {
  "@kie/act-js": "^2.4.0",
  "@kie/mock-github": "^2.0.0",
  "yaml": "^2.4.0"   // for W5 YAML lint
}
```

`yaml` is the tiny one and only one strictly needed for `pnpm test`. The other two only matter for `pnpm test:workflow` and could be marked `optionalDependencies` if we want contributors to install Layer 2 deps explicitly.

## CI changes

`.github/workflows/ci.yml` gets a new job:

```yaml
test-workflow:
  runs-on: ubuntu-latest
  if: |
    contains(github.event.pull_request.changed_files, '.github/workflows/') ||
    contains(github.event.pull_request.changed_files, 'router/src/index.ts') ||
    contains(github.event.pull_request.changed_files, 'router/src/helpers/route.ts') ||
    contains(github.event.pull_request.changed_files, 'router/test/workflow/')
  steps:
    - uses: actions/checkout@v4
      with:
        persist-credentials: false
    - uses: pnpm/action-setup@v3
    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "pnpm"
    - run: pnpm install --frozen-lockfile
    - run: pnpm test:workflow
```

This keeps the median PR fast and only pays the Docker tax when the change could plausibly break workflow wiring. GitHub-hosted runners include Docker; no extra setup needed.

The exact `if:` filter logic above may need tweaking — `contains(...changed_files, ...)` doesn't actually work in GitHub Actions expressions. The real implementation will use `dorny/paths-filter@v3` or the `tj-actions/changed-files` action. Decision deferred to implementation.

## Documentation

A new `router/test/workflow/README.md` covering:

1. **What L2 catches** — the table from this spec.
2. **What L2 cannot catch** — the ✗-✗ rows, with explicit pointers to dogfooding.
3. **Running locally** — Docker requirement, `pnpm test:workflow`, expected runtime.
4. **Adding a test** — when to add to L2 vs L1 (decision tree).
5. **Updating mock step stubs** — when claude-code-action step IDs change in `shopfloor.yml`.
6. **Pinning act version** — how and why.

---

## Conventional commits plan

1. `chore(deps): add @kie/act-js, @kie/mock-github, yaml as devDependencies`
2. `test(workflow): scaffold act-runner harness with mock-github setup`
3. `test(workflow): add canned claude-code-action mock step stubs`
4. `test(workflow): add test-caller.yml synthetic workflow_call caller`
5. `test(workflow): W5 - checkout persist-credentials YAML lint invariant`
6. `test(workflow): W1 - shopfloor.yml parses and lists expected jobs`
7. `test(workflow): W2 - route dispatch gates downstream jobs correctly`
8. `test(workflow): W3 - has_review_app gating with and without review secret`
9. `test(workflow): W4 - runner.temp plumbing preserves literal in agent output`
10. `test(workflow): W6 - agent output flows to next router step`
11. `chore(test): add pnpm test:workflow script and vitest workflow config`
12. `ci(workflow): add path-gated test-workflow job to ci.yml`
13. `docs(workflow): add README for layer 2 e2e tests`

13 commits. Each one is reviewable in isolation. W5 lands early because it's the cheapest, fastest test and earns its keep immediately.

---

## Risks specific to Layer 2

1. **`act` version drift.** nektos/act updates frequently and occasionally changes expression evaluation. Pin via the `@kie/act-js` package version + a `.actrc` in the repo root that pins the underlying nektos/act binary version.

2. **Docker availability in CI.** GitHub-hosted runners include it. Self-hosted runners may not. The CI job uses `runs-on: ubuntu-latest` to guarantee a hosted runner. Documented in the README.

3. **mock-github expects git ≥2.28.** Documented in README. CI runners satisfy this trivially.

4. **mockSteps fragility.** If a step is renamed in `shopfloor.yml`, the mockStep stub by-name match silently turns into a no-op (the real step runs instead — which would call Anthropic in CI). Mitigation: the harness loads the workflow YAML before each test, enumerates the claude-code-action step IDs, and asserts every one is covered by a mockStep. ~20 LoC of harness code, prevents a class of expensive mistakes.

5. **Flake budget.** Docker startup is occasionally slow. We retry W1-W4 once on failure (`retry: 1` in `vitest.workflow.config.ts`). If a test flakes more than once, we investigate rather than bumping the retry count.

6. **Path-filter conditional in CI.** GitHub Actions doesn't natively support `contains(github.event.pull_request.changed_files, ...)`. The implementation needs a real path-filter action (`dorny/paths-filter` or `tj-actions/changed-files`). Specified during implementation.

7. **`act` is not GitHub.** A workflow that passes act can still fail on real GitHub. This is the residual risk dogfooding addresses. We document this prominently in the L2 README so contributors don't gain false confidence.

8. **Cost of Moctokit being request-replay.** For tests that need stateful sequences across many calls, Moctokit gets verbose. For the tests in this spec, all are single-webhook with bounded API call counts, so this is fine. If we ever want a long-running L2 test (we shouldn't), we'd reach for a stateful adapter — but at that point we're rebuilding L1 in Docker, which is exactly wrong.

---

## Aggregate size estimate

| Component                   | LoC          |
| --------------------------- | ------------ |
| `act-runner.ts`             | ~150         |
| `mock-step-stubs.ts`        | ~120         |
| `test-caller.yml`           | ~30          |
| W1                          | ~30          |
| W2 (5 sub-tests)            | ~150         |
| W3                          | ~120         |
| W4                          | ~80          |
| W5 (no Docker, fast)        | ~60          |
| W6 (optional)               | ~80          |
| `vitest.workflow.config.ts` | ~20          |
| README                      | ~100         |
| **Total new code**          | **~940 LoC** |

Plus ~30 lines of CI YAML and ~15 lines of `package.json` diff.

## Time and cost summary

- **W5 (YAML lint):** ~10ms, runs in `pnpm test`
- **W1 (`act.list()`):** ~500ms, runs in `pnpm test:workflow`
- **W2-W4, W6 (each spins act + Docker):** ~10-30s per test
- **Total `pnpm test:workflow` runtime:** ~1-2 minutes
- **CI cost:** opt-in job runs only on PRs that touch workflow files or router routing code

This pricing model keeps the median PR fast while ensuring workflow-touching PRs get rigorous wiring validation.
