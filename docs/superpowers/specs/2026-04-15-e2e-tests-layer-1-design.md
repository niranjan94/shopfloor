# E2E tests — Layer 1: in-process scenario tests

**Status:** Draft
**Date:** 2026-04-15
**Author:** brainstormed with Claude
**Related:** `2026-04-15-e2e-tests-layer-2-design.md` (separate, deferred)

## Summary

Add an end-to-end test layer that drives the Shopfloor router (`router/src/index.ts`) through full GitHub issue lifecycles in a single process, using a stateful in-memory GitHub fake. Tests read like narratives ("issue gets triaged, plan PR opens, plan merges, impl PR opens, review approves, merge"), are deterministic, and run in milliseconds with no Docker, no network, and no real Claude calls.

This is "Layer 1" of a two-layer e2e strategy. Layer 1 covers the state machine and cross-helper contracts. Layer 2 (separate spec) covers `shopfloor.yml` workflow wiring via `act-js` + `mock-github`. The two layers are implementation-independent. **Layer 1 ships first.**

## Goals

- **Catch state machine regressions** that span multiple helpers — metadata round-trips, label drift, retry loops, stage transitions — which the existing per-helper unit tests cannot see by construction.
- **Catch cross-helper contract violations** — when one helper writes a value (e.g., a slug in the issue body) that another helper reads later, scenario tests prove the round-trip works end-to-end.
- **Provide a story-shaped regression net** for every active issue lifecycle: quick, medium, large, clarification, stage-PR rework, impl review retry, review-stuck.
- **Document the system implicitly** through readable scenario files. A new contributor reading `medium-happy-path.test.ts` should understand the canonical flow without reading any implementation.
- **Stay fast and dependency-light.** Whole Layer 1 suite adds <1s to `pnpm test`. No new runtime dependencies; minimal devDependencies.

## Non-goals

- **Real `claude-code-action` invocations.** The agent is stubbed in every scenario. We never call Anthropic. Prompt rendering quality is covered by the existing `prompt-render.test.ts`.
- **Real GitHub API calls.** No live repo, no test App installation, no PAT in CI.
- **Workflow YAML wiring.** That's Layer 2's job. Layer 1 cannot see job-level `if:` conditions, output flow between jobs, or the `has_review_app` ternary pattern.
- **GitHub-server-only behaviors.** The `secrets.GITHUB_TOKEN` does-not-fire-downstream-workflows behavior and the `actions/checkout` extraheader credential override are GitHub-internal. Neither layer catches them; we accept this and document it.
- **Migration of existing helper unit tests.** The per-helper tests in `router/test/helpers/` stay where they are. Layer 1 is purely additive.
- **The `mcp-servers/shopfloor-mcp` package.** Out of scope; that package has its own tests.
- **Performance / load testing.** Not what this is for.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: in-process TS scenarios   (THIS SPEC)             │
│                                                             │
│  ScenarioHarness drives main() through event sequences.    │
│  Stateful FakeGitHub behind a vitest-mocked getOctokit().  │
│  Test code plays the role of claude-code-action by         │
│  queueing strongly-typed agent responses.                  │
│                                                             │
│  Catches: state machine, cross-helper contracts, label     │
│  drift, retry loops, metadata round-trips.                 │
└─────────────────────────────────────────────────────────────┘
                            │ (independent)
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: act-js + mock-github       (separate spec)        │
│                                                             │
│  Real shopfloor.yml runs in Docker via nektos/act.         │
│  Catches: YAML wiring, output gating, env var flow.        │
└─────────────────────────────────────────────────────────────┘
```

### Key insight: the agent does not write files

Verified by reading the helpers: `apply-triage-decision`, `aggregate-review`, `apply-impl-postwork`, and `open-stage-pr` all read agent output via `core.getInput()`, not from files. The workflow YAML wires `claude-code-action.outputs.foo -> router.with.foo`. This means the harness's "agent stub" does not need filesystem fakery — it just queues the next helper's input map.

### Key insight: the router never touches git or the filesystem

Verified by `Grep` over `router/src`. All `git checkout/add/commit/push` lives in `shopfloor.yml` step bodies. The router is a pure "events in -> Octokit calls out" state machine. Layer 1 therefore needs zero filesystem fakery beyond temp files for `GITHUB_EVENT_PATH` / `GITHUB_OUTPUT` / `RUNNER_TEMP`.

### Three components

1. **`FakeGitHub`** — a stateful in-memory simulator of the GitHub API surface that `GitHubAdapter` uses, with semantic rules (label uniqueness, self-review forbidden, open-PR-per-head uniqueness, etc).
2. **`ScenarioHarness`** — drives `main()` via env var lifecycle, plays the agent via a queue, hand-scripts the workflow job graph.
3. **Scenario files** — narrative tests, one per issue lifecycle.

---

## FakeGitHub

The core asset of Layer 1. Reused by every scenario.

### State model

```ts
interface FakeState {
  repo: { owner: string; repo: string };
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment>;
  reviews: Map<number, Review>;
  reviewComments: Map<number, ReviewComment>; // keyed by comment id
  statuses: Map<string, Map<string, Status>>; // sha -> context -> latest
  branches: Set<string>;
  nextIssueNumber: number; // shared issue/PR counter, matches GitHub
  nextCommentId: number;
  nextReviewId: number;
  authIdentity: string; // primary App identity
  reviewAuthIdentity?: string; // secondary review App identity
  eventLog: WriteEvent[]; // chronological mutations, for failure messages
}
```

Entity shapes:

```ts
interface Label {
  name: string;
  color: string;
  description?: string;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[]; // names; must reference labels.has(name)
  author: string;
  createdAt: string;
}

interface Pull {
  number: number; // shares numbering pool with issues
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  labels: string[];
  author: string; // critical for self-review enforcement
  files: string[]; // pre-seeded by harness; listFiles returns this
  createdAt: string;
  mergedAt?: string;
}

interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
}

interface Review {
  id: number;
  prNumber: number;
  commitId: string; // emitted as `commit_id` via the shim
  // `event` is the input verb the API takes; `state` is the field the API returns.
  // Both are tracked because the adapter reads `state`.
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  user: { login: string };
  submittedAt: string; // emitted as `submitted_at` via the shim
}

interface ReviewComment {
  id: number;
  prNumber: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  user: { login: string };
}

interface Status {
  sha: string;
  context: string; // e.g. "shopfloor/review"
  state: "pending" | "success" | "failure" | "error";
  description: string;
  targetUrl?: string;
  updatedAt: string;
}
```

`WriteEvent` is a discriminated union covering every mutation the fake performs (`addLabel`, `removeLabel`, `createComment`, `createPr`, `updatePr`, `createReview`, `setStatus`, `closeIssue`, etc). The `eventLog` is the single most important debugging affordance — when a scenario assertion fails, it dumps the log and you immediately see what the router did in what order.

### API surface

Mapped directly to what `GitHubAdapter` calls (verified by reading `router/src/github.ts`). Every method below is implemented as a method on `FakeGitHub` AND exposed via the Octokit-shape shim.

| Octokit method             | FakeGitHub semantics                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues.addLabels`         | Validates label exists in `labels` (else 422 "Label does not exist"). Pushes onto `issue.labels` if not present. Idempotent.                                                                                                                                                                                                                                     |
| `issues.removeLabel`       | Throws 404 if label not on issue (matches the adapter's catch-and-ignore).                                                                                                                                                                                                                                                                                       |
| `issues.createComment`     | Allocates `nextCommentId`. Returns `{ data: { id } }`.                                                                                                                                                                                                                                                                                                           |
| `issues.updateComment`     | 404 if comment id unknown.                                                                                                                                                                                                                                                                                                                                       |
| `issues.listLabelsForRepo` | Returns all labels; pagination honored.                                                                                                                                                                                                                                                                                                                          |
| `issues.createLabel`       | 422 if label already exists (matches the adapter's catch).                                                                                                                                                                                                                                                                                                       |
| `issues.update`            | Patches `state` and/or `body`. Logs `closeIssue` on state flip.                                                                                                                                                                                                                                                                                                  |
| `issues.get`               | Returns issue with labels reshaped as `[{ name }]` (Octokit envelope).                                                                                                                                                                                                                                                                                           |
| `pulls.create`             | Strict: requires `head` branch in `branches`; rejects duplicate open PR with same head (422 "A pull request already exists").                                                                                                                                                                                                                                    |
| `pulls.list`               | Filters by `state` and `head` (matches `owner:branch` format the adapter passes).                                                                                                                                                                                                                                                                                |
| `pulls.update`             | Patches title/body.                                                                                                                                                                                                                                                                                                                                              |
| `pulls.get`                | Full PR shape.                                                                                                                                                                                                                                                                                                                                                   |
| `pulls.listFiles`          | Returns harness-seeded `files`. Pagination honored.                                                                                                                                                                                                                                                                                                              |
| `pulls.createReview`       | **Self-review enforcement:** if the review user identity matches the PR author identity and `event !== "COMMENT"`, throws 422 "Can not approve your own pull request".                                                                                                                                                                                           |
| `pulls.listReviews`        | Returns reviews for the PR. Each row carries `id`, `user.login`, `body`, `commit_id`, `state` (`APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`), and `submitted_at` — used by `listPrReviews` and `getPrReviewsAtSha` in `router/src/github.ts`, consumed by `build-revision-context.ts` for the impl review retry loop. The fake's row shape MUST include all of these or the impl-review-retry-loop scenario crashes on undefined fields. |
| `pulls.listReviewComments` | Returns review-comment threads for the PR with `id`, `path`, `line`, `body`, `user.login`. Used by `listPrReviewComments` in the adapter; required by the impl review retry loop scenario. Pagination honored.                                                                                                                                                   |
| `issues.listComments`      | Returns issue comments with `id`, `body`, `user.login`, `created_at`. Used by `listIssueComments` in the adapter. Pagination honored.                                                                                                                                                                                                                            |
| `repos.createCommitStatus` | Upserts `(sha, context) -> status`. Truncates description at 140 chars (matches GitHub).                                                                                                                                                                                                                                                                         |

### Semantic rules (the "generous" part)

These rules make the fake catch contract violations a minimal mock would miss:

1. **Label uniqueness on issue.** Adding the same label twice is a no-op.
2. **Repo label registry is authoritative.** `addLabels` rejects unknown labels with 422. The router must `createLabel` (or `bootstrap-labels`) first. Catches "stage flow added a new label without bootstrapping it" bugs. **This is stricter than real GitHub** (which auto-creates), an intentional trade-off.
3. **PR/branch consistency.** `pulls.create` rejects if the head branch isn't in `fake.branches`. Harness adds branches via `fake.seedBranch(name, sha)` before stage-PR scenarios.
4. **Open-PR-per-head uniqueness.** Two open PRs with the same head are forbidden. Forces the adapter's `findOpenPrByHead` upsert path to be exercised correctly.
5. **Self-review forbidden.** This is the CLAUDE.md gotcha encoded as a rule. Test setup uses two distinct identities (`shopfloor[bot]` and `shopfloor-review[bot]`) to mirror production.
6. **State transitions for issues.** `closed -> open` allowed. Comments allowed on closed issues.
7. **PR merge state.** `merged: true` implies `state: "closed"`. Helper `fake.mergePr(number, sha)` for harness convenience (the router doesn't merge PRs in production).
8. **Status check latest-wins per `(sha, context)`.** `fake.statusFor(sha, "shopfloor/review")` returns the most recent.
9. **Description truncation at 140 chars.** Mirrors GitHub. Catches the bug where `setReviewStatus` is fed an unbounded description.
10. **Identity injection.** `new FakeGitHub({ authIdentity, reviewAuthIdentity })`. The harness binds the appropriate identity per Octokit instance so PRs are authored as one App and reviews are posted by the other.

### Error shape

Every rejection throws an error that looks like `@octokit/request-error`:

```ts
class FakeRequestError extends Error {
  status: number;
  response: { data: { message: string; documentation_url: string } };
}
```

`status` is the property the adapter checks (`removeLabel`, `createLabel`).

### Octokit shim

`octokit-shim.ts` builds an `OctokitLike` whose `rest.{issues,pulls,repos}` methods are thin wrappers around `FakeGitHub`. Each wrapper validates the input has the expected `owner`/`repo`, delegates to the corresponding fake method, and wraps the return in `{ data: ... }` to match Octokit's response envelope.

The harness wires this up via `vi.mock("@actions/github", ...)` so that `getOctokit(token)` returns the shim. Token is used as a key into a token-to-fake map so the primary and review identities resolve to different shims of the _same_ underlying `FakeGitHub` (different `authIdentity`, shared state).

```ts
const fake = new FakeGitHub({ owner: "o", repo: "r" });
const primary = fake.asOctokit("shopfloor[bot]");
const review = fake.asOctokit("shopfloor-review[bot]");

vi.mocked(getOctokit).mockImplementation((token: string) => {
  if (token === "primary-token") return primary;
  if (token === "review-token") return review;
  throw new Error(`unknown token in test: ${token}`);
});
```

### Snapshot and assertion helpers

```ts
fake.issue(42);
fake.pr(101);
fake.labelsOn(42); // string[]
fake.commentsOn(42); // Comment[]
fake.reviewsOn(101); // Review[]
fake.statusFor(sha, "shopfloor/review");
fake.openPrs(); // Pull[]
fake.snapshot(); // serializable; safe for vitest snapshot
fake.eventLog(); // WriteEvent[]
fake.eventLogSummary(); // pretty-printed string for error messages
fake.tick(); // advance internal clock 1s; returns ISO string
```

`snapshot()` deliberately omits internal counters and the event log so snapshot files diff cleanly across reorderings of those internals.

### Construction and seeding

```ts
const fake = new FakeGitHub({
  owner: "o",
  repo: "r",
  authIdentity: "shopfloor[bot]",
  reviewAuthIdentity: "shopfloor-review[bot]",
});

// The trigger label is the ONLY label needed before bootstrap. Once
// `harness.bootstrap()` runs the real bootstrap-labels helper, all the
// shopfloor:* labels exist in the fake's registry. Scenarios that want
// to test pre-bootstrap state can call fake.seedLabels(...) directly
// and skip harness.bootstrap().
fake.seedLabels([{ name: "shopfloor:trigger", color: "ededed" }]);
fake.seedIssue({
  number: 42,
  title: "Add foo",
  body: "...",
  author: "alice",
  labels: [],
});
fake.seedBranch("main", "sha-main-0");
```

`harness.bootstrap()` invokes the real `runBootstrapLabels` helper against the fake, which creates all `shopfloor:*` labels through the same code path production uses. This is what makes the registry authoritative once bootstrap runs: every scenario gets the real label set without duplicating the list. `fake.seedLabels(...)` exists as an escape hatch for tests that want to bypass bootstrap or add non-shopfloor labels (e.g., the issue's own user labels). Branch and issue seeding remains explicit because the router does not create those.

### Tests for the fake

`router/test/e2e/fake-github/fake-github.test.ts` covers each semantic rule in isolation: "addLabel rejects unknown label," "self-review throws 422," "duplicate open PR rejected," etc. ~15-20 small tests. Without these, a buggy fake silently corrupts every scenario.

### Approximate size

| File                                         | Approx LoC |
| -------------------------------------------- | ---------- |
| `state.ts` (entity types + WriteEvent union) | 120        |
| `errors.ts`                                  | 30         |
| `handlers/issues.ts`                         | 150        |
| `handlers/pulls.ts`                          | 180        |
| `handlers/repos.ts`                          | 30         |
| `octokit-shim.ts`                            | 120        |
| `index.ts` (FakeGitHub class wiring)         | 200        |
| **Total**                                    | **~830**   |

---

## ScenarioHarness

The driver. Three responsibilities: env var lifecycle, agent simulation, job-graph dispatch.

### Target ergonomics

What a scenario should look like. If scenarios don't read this cleanly, the design is wrong:

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness";
import { loadEvent } from "../harness/fixtures";

describe("medium issue happy path", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({ owner: "acme", repo: "widgets" });
    harness = new ScenarioHarness({ fake });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "Add foo",
      body: "Need to add foo support.",
      author: "alice",
    });
  });

  test("triage -> plan -> impl -> review -> merged", async () => {
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "medium",
        rationale: "two files, well-defined surface",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");

    expect(fake.labelsOn(42)).toEqual(["shopfloor:needs-plan"]);
    expect(fake.issue(42).body).toMatch(/Shopfloor-Slug: add-foo/);

    // ... continues
  });
});
```

No env var setting, no module mocking, no `JSON.stringify` of webhook bodies, no manual chaining of helpers. All of that lives in the harness.

### Review stage agent fan-out

The review stage is the only stage where the workflow runs multiple parallel agents (verified at `.github/workflows/shopfloor.yml` lines 1010-1473). Four reviewer jobs (`review-compliance`, `review-bugs`, `review-security`, `review-smells`) each invoke `claude-code-action`, and their outputs become the `compliance_output`, `bugs_output`, `security_output`, `smells_output` inputs to `aggregate-review` in the `review-aggregator` job. The harness models this with a dedicated bundle type:

```ts
type AgentRole = "compliance" | "bugs" | "security" | "smells";

interface ReviewAgentBundle {
  compliance: { output: string; failed?: false } | { failed: true; reason: string };
  bugs:       { output: string; failed?: false } | { failed: true; reason: string };
  security:   { output: string; failed?: false } | { failed: true; reason: string };
  smells:     { output: string; failed?: false } | { failed: true; reason: string };
}

// Scenario usage:
harness.queueReviewAgents({
  compliance: { output: JSON.stringify({ verdict: "lgtm", confidence: 95, comments: [] }) },
  bugs:       { output: JSON.stringify({ verdict: "lgtm", confidence: 90, comments: [] }) },
  security:   { output: JSON.stringify({ verdict: "request_changes", confidence: 85, comments: [...] }) },
  smells:     { output: JSON.stringify({ verdict: "lgtm", confidence: 88, comments: [] }) },
});
await harness.runStage("review");
```

`runStage("review")` consumes the entire bundle in one call and threads each role's output to the matching `aggregate-review` input. Forgetting to queue a bundle before `runStage("review")` throws with a clear message naming the missing roles. A reviewer marked `failed: true` simulates the corresponding job timing out or returning empty output, which is what the workflow passes through to `aggregate-review` as an empty input.

### API surface

```ts
class ScenarioHarness {
  constructor(opts: {
    fake: FakeGitHub;
    triggerLabel?: string; // default "shopfloor:trigger"
    workspaceDir?: string; // for RUNNER_TEMP; default tmp.dirSync()
  });

  // ── Setup ─────────────────────────────────────────────────────────
  async bootstrap(): Promise<void>;

  // ── Driving the router ────────────────────────────────────────────
  async deliverEvent(event: GitHubEvent): Promise<RouteOutputs>;
  async runStage(stage: StageName): Promise<StageOutcome>;
  async invokeHelper(
    helper: HelperName,
    inputs: Record<string, string>,
  ): Promise<HelperOutputs>;

  // ── Agent simulation ──────────────────────────────────────────────
  // Most stages have one agent. The review stage runs FOUR parallel
  // reviewer agents (compliance, bugs, security, smells) whose outputs
  // become the corresponding inputs to aggregate-review. The harness
  // exposes a per-stage queue keyed by agent role.
  queueAgent(
    stage: Exclude<StageName, "review">,
    response: AgentResponse,
  ): void;
  queueReviewAgents(response: ReviewAgentBundle): void;
  queueAgentError(
    stage: StageName,
    role: AgentRole | "default",
    error: AgentError,
  ): void;

  // ── Cleanup ───────────────────────────────────────────────────────
  async dispose(): Promise<void>;
}
```

### How `invokeHelper` works

Pseudocode:

```ts
async invokeHelper(helper, inputs) {
  const restoreEnv = this.envManager.snapshot();
  const outputFile = path.join(this.workspaceDir, `output-${++this.seq}.txt`);
  const eventFile  = path.join(this.workspaceDir, `event-${this.seq}.json`);

  await fs.writeFile(eventFile, JSON.stringify(this.currentEvent));
  await fs.writeFile(outputFile, "");

  process.env.INPUT_HELPER       = helper;
  process.env.INPUT_GITHUB_TOKEN = "primary-token";
  if (helper === "aggregate-review") {
    process.env.INPUT_REVIEW_GITHUB_TOKEN = "review-token";
  }
  for (const [k, v] of Object.entries(inputs)) {
    process.env[`INPUT_${k.toUpperCase()}`] = v;
  }
  process.env.GITHUB_EVENT_PATH  = eventFile;
  process.env.GITHUB_EVENT_NAME  = this.currentEventName;
  process.env.GITHUB_OUTPUT      = outputFile;
  process.env.GITHUB_REPOSITORY  = `${this.fake.owner}/${this.fake.repo}`;
  process.env.RUNNER_TEMP        = this.workspaceDir;

  resetCoreState();

  try {
    await main();
  } finally {
    const outputs = parseGithubOutput(await fs.readFile(outputFile, "utf8"));
    restoreEnv();
    return outputs;
  }
}
```

Three subtleties:

1. **`main()` is imported once** at the top of `scenario-harness.ts`. It's just a function. Vitest module caching is fine because env vars are read at call time.
2. **Module mock of `@actions/github`** is set up via `vitest.setup.ts` (referenced from `vitest.config.ts`). Each test gets its own fake via a per-test registry.
3. **`@actions/core` has internal state.** Between invocations the harness calls `resetCoreState()` to clear `process.exitCode`, captured failure messages, and the `GITHUB_OUTPUT` delimiter state. Without this, a `setFailed` in one helper leaks into the next.

### Job graph

`harness/job-graph.ts` is a hand-maintained TS file:

```ts
type GraphStep =
  | { kind: "helper"; helper: HelperName; from: InputMap }
  | { kind: "agent"; stage: StageName }
  // The triage and review stages contain `run:` shell steps that build
  // a context JSON file via `gh api` calls and write its path into a
  // step output that subsequent helpers read. These are not router
  // helpers; the harness simulates them by writing a synthetic context
  // file to RUNNER_TEMP and exposing its path as a previous-step output.
  | {
      kind: "context";
      id: string;
      build: (ctx: StageContext) => ContextArtifact;
    }
  | { kind: "if"; when: (ctx: StageContext) => boolean; then: GraphStep[] };

interface ContextArtifact {
  // Written to `${RUNNER_TEMP}/<id>.json` and exposed as
  // `previous[<id>].path` for downstream `from: { source: "previous" }`.
  json: unknown;
}

type InputMap = Record<string, InputSource>;
type InputSource =
  | { source: "route"; key: string } // pull from route outputs
  | { source: "agent"; key: string } // pull from queued agent response
  | { source: "previous"; helper: HelperName | string; key: string }
  | { source: "literal"; value: string };

export const jobGraph: Record<StageName, GraphStep[]> = {
  triage: [
    // Mirrors the "Build triage context" run-step in shopfloor.yml that
    // calls `gh api .../comments` and writes RUNNER_TEMP/context.json.
    {
      kind: "context",
      id: "ctx",
      build: (ctx) => ({
        json: {
          issue_number: String(ctx.routeOutputs.issue_number),
          issue_title: ctx.fake.issue(Number(ctx.routeOutputs.issue_number))
            .title,
          issue_body:
            ctx.fake.issue(Number(ctx.routeOutputs.issue_number)).body ?? "",
          // Comments come from the fake's in-memory store, mirroring the
          // gh api call without actually shelling out.
          issue_comments: ctx.fake
            .commentsOn(Number(ctx.routeOutputs.issue_number))
            .map((c) => `**@${c.author}**:\n${c.body}`)
            .join("\n\n---\n\n"),
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
        },
      }),
    },
    {
      kind: "helper",
      helper: "render-prompt",
      from: {
        prompt_file: { source: "literal", value: "prompts/triage.md" },
        context_file: { source: "previous", helper: "ctx", key: "path" },
      },
    },
    { kind: "agent", stage: "triage" },
    {
      kind: "helper",
      helper: "apply-triage-decision",
      from: {
        issue_number: { source: "route", key: "issue_number" },
        decision_json: { source: "agent", key: "decision_json" },
      },
    },
  ],
  plan: [
    /* ... */
  ],
  spec: [
    /* ... */
  ],
  implement: [
    /* ... */
  ],
  review: [
    /* ... */
  ],
  "handle-merge": [
    /* ... */
  ],
};
```

Three things to note:

1. **The graph is hand-maintained.** This is the source of drift if `shopfloor.yml` evolves. We accept this with two mitigations: (a) the graph file lives next to the YAML in the repo so PR reviewers can spot drift; (b) Layer 2 catches drift between graph and YAML once Layer 2 ships.
2. **`InputSource` is typed.** Bad references fail loudly at scenario time, with an error pointing at the graph step. Not silently passing `undefined`.
3. **Every stage uses the `context` step pattern, not just triage.** Verified: `shopfloor.yml` has eight `id: ctx` shell steps (one per stage that runs claude-code-action). Find them with `grep -n "id: ctx$" .github/workflows/shopfloor.yml`. Each writes a JSON context file and exposes its path as `steps.ctx.outputs.path`, which the next `render-prompt` step reads via `context_file:`. The job graph models all eight via the `kind: "context"` step type. The `build` callback for each stage assembles the JSON differently — triage pulls issue comments, the stage agents pull issue body + already-merged previous-stage artifacts, the four reviewers pull PR diff metadata, and so on. The implementation plan should enumerate each context shape by reading the corresponding YAML block.

### Event helpers

`harness/fixtures.ts`:

```ts
export function loadEvent(
  fixtureName: string,
  overrides?: { issueNumber?: number; prNumber?: number; sha?: string },
): GitHubEvent;
```

Reads from the existing `router/test/fixtures/events/*.json`, applies overrides via JSON path patches. Returns a typed event with the webhook event name attached.

The override mechanism is critical: existing fixtures hard-code issue numbers, but a scenario must be able to use any number. We don't fork the fixture files; we patch in memory.

### Output parsing

`parseGithubOutput()` reads the file `@actions/core` writes to. It uses GitHub's own delimiter format:

```
key<<DELIM
value
DELIM
```

A small, well-defined parser (~30 LoC). We don't depend on `@actions/core`'s reader because it's not exported.

### Failure ergonomics

When a scenario fails, the error message must point you at the right place. The harness wraps every helper invocation in a try/catch that, on failure, captures the helper name, stage, step index, and `fake.eventLogSummary()`, then re-throws with a composite message:

```
ScenarioStepError: stage=plan step=2 helper=apply-impl-postwork
  Helper threw: "shopfloor:needs-plan label not present on issue #42"

  GitHub state at time of failure:
    [t+0]   addLabel    issue=42 label=shopfloor:trigger
    [t+1]   removeLabel issue=42 label=shopfloor:trigger
    [t+2]   addLabel    issue=42 label=shopfloor:needs-plan
    [t+3]   updateBody  issue=42
    [t+4]   addLabel    issue=42 label=shopfloor:plan-in-review
    [t+5]   removeLabel issue=42 label=shopfloor:needs-plan
    [t+6]   createPr    pr=100 head=shopfloor/42-plan base=main

  Queued agent responses remaining: []
```

Without this, debugging a 30-step scenario by reading vitest output is misery.

### Approximate size

| File                                         | Approx LoC |
| -------------------------------------------- | ---------- |
| `scenario-harness.ts`                        | 250        |
| `job-graph.ts`                               | 200        |
| `agent-stub.ts`                              | 80         |
| `env.ts` (snapshot/restore + resetCoreState) | 120        |
| `fixtures.ts`                                | 80         |
| `parse-output.ts`                            | 50         |
| **Total**                                    | **~780**   |

Plus ~100 LoC of harness self-tests covering env lifecycle, output parsing, agent queue exhaustion, and `InputSource` resolution.

---

## Scenario catalog

Seven scenarios for v1. Each in a separate `*.test.ts` so failures point at one story.

Picking principles: one scenario per branch of the state machine, every stage covered at least once, every recently-bitten flow covered, no two scenarios that diverge only in agent payload.

### 1. `quick-happy-path.test.ts`

The simplest possible end-to-end. If this breaks, everything is on fire.

- **Path:** triage (`complexity: "quick"`) -> implement -> review approved -> merge -> done
- **Skips:** spec, plan
- **Asserts:** the persistent complexity label `shopfloor:quick` is present from triage onward; the transient stage labels evolve through the sequence `trigger -> needs-impl -> impl-in-review -> needs-review -> review-approved -> done`; one impl PR exists, merged; final issue state closed; no stray PRs. Note: `apply-triage-decision` adds BOTH `shopfloor:<complexity>` and the next-stage label in a single `advanceState` call (see `router/src/helpers/apply-triage-decision.ts:110`), so the complexity label coexists with every transient stage label after triage runs.

### 2. `medium-happy-path.test.ts`

Canonical path. Exercises the most stages without weirdness.

- **Path:** triage (medium) -> plan -> implement -> review approved -> merge
- **Asserts:** persistent `shopfloor:medium` label present from triage onward (coexists with every transient stage label); plan PR is created and merged before impl PR opens; impl PR body contains `Shopfloor-Stage: implement` and `Shopfloor-Review-Iteration: 0`; issue body carries `Shopfloor-Slug:` after triage; no spec stage runs.

### 3. `large-happy-path.test.ts`

The only scenario that exercises the spec stage.

- **Path:** triage (large) -> spec -> plan -> implement -> review approved -> merge
- **Asserts:** persistent `shopfloor:large` label present from triage onward; spec PR opens, gets approved, merges to main; _then_ plan stage runs against the merged spec; metadata round-trip via issue body works across all three stage PRs; spec/plan PRs are not draft, impl PR is.

### 4. `triage-clarification-and-resume.test.ts`

Tests the awaiting-info loop.

- **Path:** triage -> `needs_clarification` -> issue gets `shopfloor:awaiting-info` label + comment with questions -> user replies + removes label -> re-triage -> classified as medium -> normal medium flow
- **Asserts:** comment with questions is posted; `awaiting-info` label is added then removed; second triage doesn't double-post questions; issue body slug is set only once (on the second classification).

### 5. `spec-pr-changes-requested-rework.test.ts`

Tests stage PR review feedback for spec. Plan rework is structurally identical so we don't duplicate it.

- **Path:** triage (large) -> spec PR opened -> reviewer requests changes -> agent re-runs spec -> spec PR updated (NOT recreated) -> approved -> merged -> normal flow continues
- **Critical assertion:** the spec PR's _number_ is the same before and after rework. This is what `findOpenPrByHead` + `pulls.update` guarantees, and exactly what unit tests can't see across a full sequence.
- **Also asserts:** `Shopfloor-Stage: spec` metadata survives the body update; reviewer changes-requested label flow.

### 6. `impl-review-retry-loop.test.ts`

The retry loop feature from commit `4fd8fe0`. The reason this whole project might be worth doing.

- **Path:** triage -> implement -> review iteration 0 requests changes -> implement re-runs (iteration 1) -> review iteration 1 approves -> merge
- **Critical assertions:**
  - The impl PR body's `Shopfloor-Review-Iteration` increments from 0 to 1 and is preserved across the re-run (this is what `preserveBodyIfExists` is for in `openStagePr`).
  - The same impl PR is reused (same number).
  - The triage mutex + retry flow doesn't deadlock.
  - Two review records exist on the PR, one per iteration, distinguished by `commit_id`.
  - Final state: `review-approved -> done`.

### 7. `review-stuck-after-max-iterations.test.ts`

Tests the failure boundary of the retry loop.

- **Path:** triage -> implement -> review requests changes -> repeat to `max_iterations` (3) -> aggregator marks `review-stuck`
- **Asserts:** label sequence ends at `shopfloor:review-stuck`, not `done`; the issue stays open; `report-failure` posts a comment; impl PR is left open (not merged).

### Coverage matrix

| Scenario          | triage | spec | plan | impl | review-once | review-loop | failure |
| ----------------- | ------ | ---- | ---- | ---- | ----------- | ----------- | ------- |
| 1 quick-happy     | ✓      |      |      | ✓    | ✓           |             |         |
| 2 medium-happy    | ✓      |      | ✓    | ✓    | ✓           |             |         |
| 3 large-happy     | ✓      | ✓    | ✓    | ✓    | ✓           |             |         |
| 4 clarify-resume  | ✓      |      | ✓    | ✓    | ✓           |             | partial |
| 5 spec-rework     | ✓      | ✓    | ✓    | ✓    | ✓           |             |         |
| 6 impl-retry-loop | ✓      |      | ✓    | ✓    |             | ✓           |         |
| 7 review-stuck    | ✓      |      | ✓    | ✓    |             | ✓           | ✓       |

Every helper is exercised by at least two scenarios. `aggregate-review` is exercised by all five that reach review. `bootstrap-labels` runs in every `beforeEach`.

### Snapshot strategy

Every scenario ends with `expect(fake.snapshot()).toMatchSnapshot()`. Catches drift in observable state we forgot to assert on explicitly. Targeted `expect(...)` calls inside the scenario body remain — the snapshot is a backstop. Snapshots live next to the test file in `__snapshots__/`.

### Per-scenario time budget

Each scenario should run in **under 100ms**. No I/O beyond temp files; no Docker; the fake is in-memory. Whole Layer 1 suite should add **<1s** to `pnpm test`. If a single scenario gets slower than 200ms, that's a signal something's wrong (probably the harness spinning up too much per step).

### Scenarios deliberately not in v1

- **Failed triage recovery.** Small variant of #4; defer.
- **Concurrent edits** (issue closed mid-stage). Race; not deterministic; defer.
- **Skip-review label flow.** Single-branch detour off #2; can be added as #8 if desired, but not required for v1.
- **`route` ignoring irrelevant label flips.** Belongs in `route.test.ts` unit tests.
- **Bootstrap idempotency.** Covered by `bootstrap-labels.test.ts` unit test.

---

## File layout

```
router/test/
├── e2e/                                         # NEW
│   ├── README.md
│   ├── setup.ts                                 # vitest setup file (mocks @actions/github)
│   ├── fake-github/
│   │   ├── index.ts
│   │   ├── state.ts
│   │   ├── errors.ts
│   │   ├── octokit-shim.ts
│   │   ├── handlers/
│   │   │   ├── issues.ts
│   │   │   ├── pulls.ts
│   │   │   └── repos.ts
│   │   └── fake-github.test.ts
│   ├── harness/
│   │   ├── scenario-harness.ts
│   │   ├── job-graph.ts
│   │   ├── agent-stub.ts
│   │   ├── env.ts
│   │   ├── fixtures.ts
│   │   ├── parse-output.ts
│   │   └── scenario-harness.test.ts
│   └── scenarios/
│       ├── __snapshots__/
│       ├── quick-happy-path.test.ts
│       ├── medium-happy-path.test.ts
│       ├── large-happy-path.test.ts
│       ├── triage-clarification-and-resume.test.ts
│       ├── spec-pr-changes-requested-rework.test.ts
│       ├── impl-review-retry-loop.test.ts
│       └── review-stuck-after-max-iterations.test.ts
├── helpers/                                     # existing — unchanged
├── fixtures/                                    # existing — unchanged, reused
└── ...
```

Nothing existing moves. The new code is fully additive.

## Test commands

```jsonc
// package.json (diff)
{
  "scripts": {
    "test": "vitest run", // unchanged; now includes e2e scenarios
    "test:watch": "vitest", // unchanged
    "test:e2e": "vitest run router/test/e2e", // NEW
    "test:e2e:watch": "vitest router/test/e2e", // NEW
  },
}
```

`pnpm test` continues to be the one command contributors run. `test:e2e` is a convenience for working on scenarios in isolation.

## Vitest config diff

The existing `vitest.config.ts` already globs `router/test/**/*.test.ts`, so `router/test/e2e/**/*.test.ts` is picked up automatically with no `include` change. Only `setupFiles` needs to be added:

```ts
// vitest.config.ts (only the new field)
test: {
  include: [
    "router/test/**/*.test.ts",        // existing — already matches e2e/
    "mcp-servers/**/test/**/*.test.ts", // existing
    "test/e2e/**/*.test.ts",            // existing top-level dir, untouched
  ],
  setupFiles: ["router/test/e2e/setup.ts"], // NEW
  // ... rest unchanged
}
```

`setup.ts` does the global `vi.mock("@actions/github", ...)`. Existing tests are unaffected because the mock only intercepts `getOctokit` calls made through the active `FakeGitHub` registry; tests that don't register a fake bypass it entirely (the mock falls through to a no-op stub that throws if called, ensuring accidental calls fail loudly rather than silently).

## New dependencies

```jsonc
"devDependencies": {
  "tmp": "^0.2.3",
  "@types/tmp": "^0.2.6"
}
```

That's it. The fake is hand-written, the harness uses `node:fs`, `node:path`, and `tmp`. No `nock`, no `msw`, no `mock-github`, no `act-js`. Layer 1 deliberately stays dependency-light.

## CI changes

`.github/workflows/ci.yml` needs **zero changes** — `pnpm test` already runs there and the new scenarios join automatically. Total CI time delta: well under one second.

To verify during implementation: confirm `ci.yml` runs `pnpm test` directly (vs `pnpm --filter router test`). If the latter, a tweak may be needed.

## Documentation

A new `router/test/e2e/README.md` covering:

1. Mental model — what Layer 1 is, what it isn't, why it exists alongside per-helper unit tests.
2. Adding a scenario — step-by-step from fixture choice to assertions.
3. Adding a fake-github capability — when you need a new Octokit method, where to add the handler, the semantic rule, and the unit test.
4. Updating the job graph — when `shopfloor.yml` changes, how to mirror it in `job-graph.ts`.
5. Debugging a failing scenario — reading `eventLogSummary()`, the `ScenarioStepError` format, common gotchas.
6. What this can't catch — explicit pointer to the (forthcoming) Layer 2 spec for YAML wiring concerns.

---

## Conventional commits plan

The implementation is split into commits that each leave the repo passing. Reviewers should be able to hold each commit in their head.

1. `test(e2e): scaffold fake-github state model and errors`
2. `test(e2e): implement fake-github issues handler with semantic rules`
3. `test(e2e): implement fake-github pulls handler with semantic rules`
4. `test(e2e): implement fake-github repos handler and snapshot helpers`
5. `test(e2e): scaffold scenario harness with env lifecycle and output parsing`
6. `test(e2e): add agent stub queue and event fixture loader`
7. `test(e2e): hand-script job graph and runStage dispatch`
8. `test(e2e): wire @actions/github mock via vitest setup file`
9. `test(e2e): scenario - quick happy path`
10. `test(e2e): scenario - medium happy path`
11. `test(e2e): scenario - large happy path with spec`
12. `test(e2e): scenario - triage clarification and resume`
13. `test(e2e): scenario - spec PR changes requested rework`
14. `test(e2e): scenario - impl review retry loop`
15. `test(e2e): scenario - review stuck after max iterations`
16. `docs(e2e): add README for layer 1 e2e tests`
17. `chore(test): add pnpm test:e2e and test:e2e:watch scripts`

If we discover the harness needs a new capability mid-scenario (very likely — scenarios always reveal harness gaps), we slot a `test(e2e): extend harness for X` commit between the relevant scenario commits rather than batching changes into a giant blob.

---

## Open questions and risks

These need explicit handling in the implementation plan, not buried in code:

1. **`@actions/core` internal state reset.** I've sketched `resetCoreState()` but haven't read the actual `@actions/core` source to confirm what state needs resetting. The plan should include a research step before locking in the harness. Risk: undiscovered state leaks between helpers cause flaky scenarios.

2. **Vitest concurrency + shared mock.** Vitest runs test files in parallel by default. If two scenario files run concurrently and both manipulate `process.env.INPUT_*`, they trample each other. The harness must serialize scenarios within a file (default behavior) AND scenarios must not use `test.concurrent`. **Decision:** ban `test.concurrent` in `e2e/scenarios/**` via a comment in the README and a setup-file assertion that throws if `process.env.INPUT_*` exists at the start of a scenario.

3. **Snapshot file size.** A full `fake.snapshot()` after a 30-step scenario could be hundreds of lines. Acceptable, but watch for snapshots dominating PR diffs. Mitigation: snapshot only the _delta from initial seed_. Decide during scenario #1 implementation.

4. **Branch SHA progression.** The harness needs deterministic SHAs (`sha-plan-0`, `sha-plan-merged`, etc.) for assertions to be stable. Add `fake.advanceSha(branch)` for predictable values.

5. **Helper signature drift.** The hand-scripted job graph uses helper input names as strings. A typo or rename surfaces as a runtime error, not a compile-time error. Mitigation: type the `InputMap` against a `HelperInputMap` literal type derived from each helper's actual `getInput` calls. ~50 LoC of typing work, big payoff.

6. **Identity binding for the dual-token model.** Need to verify by reading the workflow YAML and `aggregate-review` that `aggregate-review` is the only helper that uses `review_github_token`. If others use it, the harness needs to expand its token map.

---

## Cross-spec dependencies

- **L1 depends on:** existing `router/src/index.ts`, `GitHubAdapter`, helpers, fixture files. Nothing new.
- **L2 depends on:** L1 event fixtures (reused), nothing else from L1. The fake and harness are L1-only assets.
- **Implementation order:** L1 first (this spec). L2 ships any time after, independently. We are not blocked on L2 to get value from L1.

---

## Aggregate size estimate

| Component                                          | LoC           |
| -------------------------------------------------- | ------------- |
| FakeGitHub (incl. handlers, shim, errors, state)   | ~830          |
| Harness (incl. job graph, fixtures, output parser) | ~780          |
| Harness self-tests                                 | ~100          |
| FakeGitHub self-tests                              | ~250          |
| 7 scenarios @ ~200 LoC avg                         | ~1400         |
| README                                             | ~150          |
| **Total new code**                                 | **~3500 LoC** |

For a project of Shopfloor's complexity and the leverage scenario tests provide, this is a reasonable budget.
