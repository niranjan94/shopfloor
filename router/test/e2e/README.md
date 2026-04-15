# Layer 1 E2E Tests

In-process scenario tests that drive the router's `main()` function through
full stage sequences using a stateful fake GitHub backend.

## Mental model

Layer 1 tests run entirely inside a single Vitest process. Each test constructs
a `FakeGitHub` to stand in for every Octokit call, delivers a webhook payload
via `harness.deliverEvent()`, queues stubbed agent responses, and calls
`harness.runStage(stage)`. The harness replays the corresponding entry in
`job-graph.ts` step by step, invoking each router helper by calling `main()`
in-process with `INPUT_*` env vars set, then returns after every helper in
the stage has executed. Assertions go against the FakeGitHub state.

Layer 1 does **not** exercise the YAML workflow wiring in
`.github/workflows/shopfloor.yml`. Job-level `if:` conditions, secret plumbing,
`actions/checkout` settings, and the actual claude-code-action invocation are
all outside its scope. That is Layer 2's job (forthcoming).

Per-helper unit tests verify helpers in isolation. They cannot catch regressions
that only surface when the state machine feeds one helper's output into the next.
Layer 1 catches those cross-helper regressions and validates the complete label
lifecycle end to end.

## Directory layout

```
router/test/e2e/
  README.md                     this file
  setup.ts                      global vi.mock + stale-env tripwire
  scenarios/                    one file per scenario
  harness/
    scenario-harness.ts         public API for scenario tests
    job-graph.ts                workflow mirror (stage -> ordered steps)
    agent-stub.ts               queued agent response stubs
    env.ts                      env snapshot/restore helpers
    fixtures.ts                 loadEvent() helper
    parse-output.ts             GITHUB_OUTPUT parser
  fake-github/
    index.ts                    FakeGitHub class (public API)
    state.ts                    entity types and FakeState shape
    octokit-shim.ts             buildOctokitShim() -- routes calls to state
    errors.ts                   FakeRequestError (mimics Octokit 422 etc.)
    handlers/
      issues.ts                 issues / labels / comments handlers
      pulls.ts                  pull requests / reviews / files handlers
      repos.ts                  statuses / refs handlers
    fake-github.test.ts         unit tests for FakeGitHub semantic rules
```

## How to run

```bash
# Run everything (unit + e2e)
pnpm test

# Run only scenario tests
pnpm test router/test/e2e/scenarios

# Run only fake-github unit tests
pnpm test router/test/e2e/fake-github

# Run only harness self-tests
pnpm test router/test/e2e/harness
```

## Current scenarios

| File | What it covers |
|------|----------------|
| `quick-happy-path` | Triage -> implement -> review approved -> merge -> done |
| `medium-happy-path` | Triage -> plan -> implement -> review approved -> merge -> done |
| `large-happy-path` | Triage -> spec -> plan -> implement -> review approved -> merge -> done |
| `triage-clarification-and-resume` | Triage asks clarifying questions; human answers; triage resumes |
| `spec-pr-changes-requested-rework` | Spec PR receives changes-requested review; spec reruns |
| `impl-review-retry-loop` | Review returns changes-requested; implement revision loop; eventual approval |
| `review-stuck-after-max-iterations` | Review exhausts max iterations; issue labelled stuck |

## Adding a scenario

### 1. Create the file

```
router/test/e2e/scenarios/<name>.test.ts
```

### 2. Set up the harness

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("<name>", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "My issue",
      body: "Details.",
      author: "alice",
      labels: ["shopfloor:enabled"],  // required
    });
  });

  afterEach(async () => harness.dispose());  // required; cleans up tmp dirs and registry
```

### 3. Drive each stage

For each stage: deliver the event, queue agent stubs, seed branches, run, assert.

```typescript
// Deliver the event; stash route outputs
const routeOutputs = await harness.deliverEvent(
  loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
  { trigger_label: "shopfloor:enabled" },
);

// Queue a non-review agent stub (keys become INPUT_* for downstream helpers)
harness.queueAgent("triage", {
  decision_json: JSON.stringify({ status: "classified", complexity: "quick",
    rationale: "single-file fix", clarifying_questions: [] }),
});

// For implement: seed the branch before runStage so open-stage-pr can resolve it
fake.seedBranch(routeOutputs.branch_name, "sha-impl-0");

// Run the stage; pass "implement" and the harness picks first-run vs revision
await harness.runStage("triage"); // or "spec", "plan", "implement", "review", "handle-merge"

// Assert against the fake
expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");
expect(fake.openPrs()).toHaveLength(1);
expect(fake.pr(prNumber).body).toContain("Shopfloor-Issue: #42");
expect(fake.snapshot()).toMatchSnapshot();
```

For review, use `queueReviewAgents` instead:

```typescript
harness.queueReviewAgents({
  compliance: { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
  bugs:       { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
  security:   { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
  smells:     { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
});
```

See `quick-happy-path.test.ts` for a fully annotated reference.

### Constraints

- **Never** use `test.concurrent` anywhere under `scenarios/`. The harness
  sets `process.env.INPUT_*` vars; concurrent tests would trample each other.
  The global tripwire in `setup.ts` will throw on any stale `INPUT_*` leak
  between tests.
- Always call `harness.dispose()` in `afterEach`. It removes the temp dir and
  deregisters the fake from the global `getOctokit` mock registry.

## Adding a fake-github capability

When a helper calls an Octokit method the fake does not yet model:

1. Add the handler in `fake-github/handlers/<area>.ts` (`issues.ts`,
   `pulls.ts`, or `repos.ts`).
2. Add a unit test in `fake-github.test.ts` for the semantic rule being modelled
   (e.g. "APPROVE from the PR author throws 422").
3. Wire it into `octokit-shim.ts` inside `buildOctokitShim`.
4. If it introduces new state, extend `state.ts` with the entity type and a new
   `Map<...>` on `FakeState`.

## Updating the job graph

`job-graph.ts` is a hand-maintained mirror of `.github/workflows/shopfloor.yml`.
When the YAML changes, find the affected `jobGraph.<stage> = [...]` block and
update its step list. If a helper gains a new input, add it to the step's `from`
map using one of the six `InputSource` kinds:

| Kind | Resolves from |
|------|---------------|
| `literal` | Hard-coded string value |
| `route` | Named key from the `route` helper's outputs |
| `agent` | Named key from the queued non-review agent stub |
| `agent-role` | Named key from one of the four review agent stubs |
| `previous` | Named key from a prior step's outputs |
| `fake` | Inline function receiving `StageContext`; used for live fake state |

## Debugging a failing scenario

### Read the ScenarioStepError

When `runStage` throws, the error message includes:

- The stage name and step index
- The step kind and helper name
- The underlying error message
- A full chronological dump of the fake's mutation log at the time of failure

### Inspect the event log

Add this after a failing step to see every mutation (label add/remove, PR
create, comment post, review post, merge):

```typescript
console.log(harness.fake.eventLogSummary());
```

### Common gotchas

**Branch SHA mismatch in revision loops.** After the implement agent runs in a
revision, the job graph's `push_files_revision` fake step automatically calls
`fake.advanceSha(branch)` to model the git push. If you are writing a scenario
that manually advances iterations outside the graph, call `fake.advanceSha`
yourself; otherwise `aggregate-review` and `build-revision-context` will see
the same SHA on consecutive iterations and lose track of which review is
current.

**Self-review forbidden.** GitHub returns 422 when a user submits a review on
their own PR. The fake enforces this rule. If you need a human review in a
scenario (not an aggregated AI review), use a third identity:

```typescript
const humanOctokit = fake.asOctokit("reviewer-human");
```

**Trigger label gate.** Every issue must be seeded with
`labels: ["shopfloor:enabled"]` and every `deliverEvent` call must pass
`{ trigger_label: "shopfloor:enabled" }` in its `extraInputs`. Missing either
causes the route helper to silently no-op.

## What Layer 1 cannot catch

- **YAML workflow wiring.** Job-level `if:` conditions, secret plumbing,
  `persist-credentials`, and `actions/checkout` config. See the forthcoming
  Layer 2 spec.
- **claude-code-action behavior.** The agent is fully stubbed.
- **Production GitHub API edge cases.** Only what the fake models is visible.
- **Network, rate-limiting, and token-scope failures.**

## Global constraints from setup.ts

`setup.ts` runs before every test in the project via Vitest `setupFiles`.

1. **`@actions/github` is mocked globally.** `getOctokit` is replaced with a
   `vi.fn()` that the `ScenarioHarness` wires to the per-test `FakeGitHub`.
   Any call without a registered fake throws immediately.

2. **A `beforeEach` tripwire** throws if any `INPUT_*` env key is present at
   test start. This catches scenarios that forgot `harness.dispose()` in
   `afterEach`, and unit tests that set `INPUT_*` without cleaning up.
   Non-scenario unit tests that set `INPUT_*` must clear them in their own
   `afterEach`.
