# E2E tests Layer 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process scenario test layer that drives `router/src/index.ts:main` through full GitHub issue lifecycles using a stateful in-memory GitHub fake, catching state-machine and cross-helper regressions that per-helper unit tests cannot see.

**Architecture:** A hand-rolled `FakeGitHub` simulates the Octokit surface that `GitHubAdapter` calls, with semantic rules (label registry, self-review forbidden, open-PR-per-head uniqueness). A `ScenarioHarness` drives `main()` by setting `INPUT_*` env vars, snapshotting/restoring between calls, and walking a hand-scripted job graph that mirrors `.github/workflows/shopfloor.yml`. Tests are narrative TS files that queue strongly-typed agent responses and assert on the fake's state.

**Tech Stack:** TypeScript, vitest, vi.mock for `@actions/github`, `tmp` for workspace dirs, `node:fs` / `node:path` for file seeding. No Docker, no network, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-15-e2e-tests-layer-1-design.md`

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `router/src/index.ts` | Modify | Export `main()` so the harness can import and invoke it; preserve auto-run when loaded as a module entrypoint. |
| `router/test/e2e/setup.ts` | Create | Vitest setup file. Owns the per-test FakeGitHub registry and the global `vi.mock("@actions/github", ...)`. |
| `router/test/e2e/fake-github/state.ts` | Create | Entity types (`Label`, `Issue`, `Pull`, `Comment`, `Review`, `ReviewComment`, `Status`), `FakeState`, `WriteEvent` discriminated union. Pure types/data. |
| `router/test/e2e/fake-github/errors.ts` | Create | `FakeRequestError` class shaped like `@octokit/request-error`. |
| `router/test/e2e/fake-github/handlers/issues.ts` | Create | All `octokit.rest.issues.*` semantics: label registry validation, label uniqueness, comment id allocation, issue body update, listComments pagination. |
| `router/test/e2e/fake-github/handlers/pulls.ts` | Create | All `octokit.rest.pulls.*` semantics: branch existence check, open-PR-per-head uniqueness, self-review enforcement, listReviews / listReviewComments / listFiles pagination, review row shape including `commit_id`/`state`/`submitted_at`. |
| `router/test/e2e/fake-github/handlers/repos.ts` | Create | `repos.createCommitStatus` with 140-char description truncation and latest-wins per `(sha, context)`. |
| `router/test/e2e/fake-github/octokit-shim.ts` | Create | Builds an `OctokitLike` shim around a `FakeGitHub` keyed by an identity, so the same fake serves both primary and review-app tokens. |
| `router/test/e2e/fake-github/index.ts` | Create | `FakeGitHub` class wiring state + handlers, snapshot/assertion helpers, seed helpers, `asOctokit(identity)`. |
| `router/test/e2e/fake-github/fake-github.test.ts` | Create | Per-rule unit tests for each semantic rule the fake enforces. |
| `router/test/e2e/harness/env.ts` | Create | `EnvManager.snapshot()`, `resetCoreState()` (clears `process.exitCode`, GITHUB_OUTPUT delimiter state, `core` failure cache). |
| `router/test/e2e/harness/parse-output.ts` | Create | Parses the `GITHUB_OUTPUT` delimited file format into a `Record<string, string>`. |
| `router/test/e2e/harness/agent-stub.ts` | Create | Typed FIFO queue per stage role for the harness agent simulator (`AgentResponse`, `AgentError`, `ReviewAgentBundle`). |
| `router/test/e2e/harness/fixtures.ts` | Create | `loadEvent(name, overrides)` reading from `router/test/fixtures/events/`, JSON-path patches, attaches event name. |
| `router/test/e2e/harness/job-graph.ts` | Create | Hand-scripted job graph mirroring `.github/workflows/shopfloor.yml` for every stage. Typed `InputMap`/`InputSource`. |
| `router/test/e2e/harness/scenario-harness.ts` | Create | `ScenarioHarness` class. `bootstrap()`, `deliverEvent()`, `runStage()`, `invokeHelper()`, `seedFile()`, `dispose()`. Wraps every helper invocation with `ScenarioStepError` to surface `eventLogSummary()`. |
| `router/test/e2e/harness/scenario-harness.test.ts` | Create | Self-tests: env snapshot/restore, output parsing, agent queue exhaustion, `InputSource` resolution, `resetCoreState` correctness. |
| `router/test/e2e/scenarios/quick-happy-path.test.ts` | Create | Scenario 1 (commit 9). |
| `router/test/e2e/scenarios/medium-happy-path.test.ts` | Create | Scenario 2 (commit 10). |
| `router/test/e2e/scenarios/large-happy-path.test.ts` | Create | Scenario 3 (commit 11). |
| `router/test/e2e/scenarios/triage-clarification-and-resume.test.ts` | Create | Scenario 4 (commit 12). |
| `router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts` | Create | Scenario 5 (commit 13). |
| `router/test/e2e/scenarios/impl-review-retry-loop.test.ts` | Create | Scenario 6 (commit 14). Exercises `revision_mode` fork. |
| `router/test/e2e/scenarios/review-stuck-after-max-iterations.test.ts` | Create | Scenario 7 (commit 15). |
| `router/test/e2e/scenarios/__snapshots__/*` | Create | Auto-managed by vitest. |
| `router/test/e2e/README.md` | Create | Developer docs (commit 16). |
| `vitest.config.ts` | Modify | Add `setupFiles: ["router/test/e2e/setup.ts"]`. The existing `router/test/**/*.test.ts` glob already picks up `e2e/**/*.test.ts`. |
| `package.json` | Modify | Add `tmp` + `@types/tmp` devDeps and `test:e2e` / `test:e2e:watch` scripts (commit 17). |

**Mapping to the spec's 17-commit conventional-commits plan:** Phase 0 prep (Tasks 0a, 0b) is unscheduled fixup that does not get its own headline commit and lands as part of Task 1's commit (state model). Phase 1 (Tasks 1-4) maps 1:1 to commits 1-4. Phase 2 (Tasks 5-8) maps to commits 5-8. Phase 3 (Tasks 9-15) maps to commits 9-15. Phase 4 (Tasks 16-17) maps to commits 16-17. If a scenario task uncovers a missing harness capability, slot a `test(e2e): extend harness for X` commit between the relevant scenario commits rather than batching changes.

---

## Phase 0: Prep

These items are research and refactor that must happen before the FakeGitHub work but do not get their own commits — they ride along with Task 1.

### Task 0a: Export `main()` from `router/src/index.ts`

**Files:**
- Modify: `router/src/index.ts`

The harness needs to `import { main } from "../../../src/index"` and call it once per helper invocation. Currently `main` is a private function and is auto-invoked at module load time. We need to export it AND make sure the auto-invoke still happens when the file is loaded by the action runtime (which loads `dist/index.cjs`, not the TS source).

The simplest pattern: export `main` and keep the trailing `main().catch(...)` call. For test scenarios, the auto-call happens once when the harness imports the module, but the env vars are not yet set, so it will currently just fall into the `Unknown helper: route` branch (helper defaults to `route`) and then fail because `github_token` is required. We do NOT want that side effect leaking into tests.

**The fix:** wrap the auto-invocation in an env guard. The action runtime sets `GITHUB_ACTIONS=true` for every workflow run; tests do not (and the harness will not). Use that as the guard.

- [ ] **Step 1: Read the file**

Run: `cat router/src/index.ts` (or equivalent Read tool call).

Confirm the current shape: `async function main()` then `main().catch(...)`.

- [ ] **Step 2: Modify `index.ts` to export and guard auto-run**

Replace the function declaration line and the trailing call:

```ts
// before
async function main(): Promise<void> {
  // ...
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});

// after
export async function main(): Promise<void> {
  // ...
}

if (process.env.GITHUB_ACTIONS === "true") {
  main().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
```

- [ ] **Step 3: Verify the build still works**

Run: `pnpm --filter @shopfloor/router build`
Expected: clean build, `router/dist/index.cjs` updated.

- [ ] **Step 4: Verify existing tests still pass**

Run: `pnpm test`
Expected: green. No new tests yet; this just confirms nothing regressed.

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

(No commit yet. This change rides along with Task 1.)

### Task 0b: Research `@actions/core` internal state for `resetCoreState()`

**Files:** none yet (this task is investigation; the result drives `router/test/e2e/harness/env.ts` later).

The harness must reset all `@actions/core` internal state between helper invocations or `setFailed` from one helper will leak into the next. The spec flags this as a research item; we do it now so the harness lands with a correct implementation.

- [ ] **Step 1: Find the @actions/core source on disk**

Run: `find router/node_modules/@actions/core/lib -type f -name "*.js"`
Expected: a handful of files (`core.js`, `command.js`, `file-command.js`, `summary.js`, `oidc-utils.js`, etc.)

- [ ] **Step 2: Identify the mutable state**

Open `router/node_modules/@actions/core/lib/core.js` and `file-command.js`. Look for:
- Module-level variables (none for `core.js` proper — it reads env vars on demand)
- `process.exitCode` writes (in `setFailed`)
- The GITHUB_OUTPUT delimiter state. `file-command.js` writes via `fs.appendFileSync` and uses a `prepareKeyValueMessage(key, value)` helper that generates a fresh delimiter per call. There is NO module-level cache.

- [ ] **Step 3: Identify env vars set by `core` calls**

Run: `grep -n "process.env" router/node_modules/@actions/core/lib/core.js`
Look for any `process.env.STATE_*` or `process.env.INPUT_*` writes via `exportVariable` / `saveState`. `exportVariable` writes to `GITHUB_ENV`; `saveState` writes to `GITHUB_STATE`. The router does not call these, but record them as candidates if a future helper does.

- [ ] **Step 4: Write down the reset list**

Based on the inspection, the reset list is:
1. `process.exitCode = undefined` (cleared between invocations so a `setFailed` does not leak).
2. Truncate the file at `process.env.GITHUB_OUTPUT` to length 0 before each invocation (the harness already creates a fresh file per invocation, so this is automatic — no explicit truncation needed, but document it).
3. Truncate `process.env.GITHUB_STATE` and `process.env.GITHUB_ENV` similarly if they ever get set (currently none of the router helpers use them; document this assumption in `env.ts` and add a runtime check that throws if either var is set at the start of a helper invocation, so a future helper that starts using them gets caught).

- [ ] **Step 5: Note findings inline**

Write a comment block at the top of the eventual `harness/env.ts` (added in Task 5) summarizing what `resetCoreState` resets and why. The plan task for `env.ts` references this comment.

(No commit. The findings are encoded in Task 5's `env.ts` implementation.)

---

## Phase 1: FakeGitHub fundamentals

### Task 1: Scaffold fake-github state model and errors

Maps to commit 1: `test(e2e): scaffold fake-github state model and errors`.

**Files:**
- Modify: `router/src/index.ts` (the Task 0a edit lands here)
- Create: `router/test/e2e/fake-github/state.ts`
- Create: `router/test/e2e/fake-github/errors.ts`

This commit only adds types and a value class. There is no behavior to TDD against yet, so no test file is added in this commit. The next commit (issues handler) starts the TDD cycles.

- [ ] **Step 1: Create `errors.ts`**

```ts
// router/test/e2e/fake-github/errors.ts

/**
 * Mirrors @octokit/request-error closely enough for GitHubAdapter's
 * `(err as { status?: number }).status` checks (removeLabel, createLabel)
 * to behave the same way against the fake.
 */
export class FakeRequestError extends Error {
  readonly status: number;
  readonly response: {
    data: { message: string; documentation_url: string };
  };

  constructor(status: number, message: string) {
    super(message);
    this.name = "FakeRequestError";
    this.status = status;
    this.response = {
      data: {
        message,
        documentation_url: "https://docs.github.com/rest",
      },
    };
  }
}
```

- [ ] **Step 2: Create `state.ts`**

Encode every entity shape and the `WriteEvent` discriminated union. Use the spec's `## FakeGitHub` -> `### State model` section as the source of truth. Translate verbatim:

```ts
// router/test/e2e/fake-github/state.ts

export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  author: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  labels: string[];
  author: string;
  files: string[];
  createdAt: string;
  mergedAt?: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
}

export interface Review {
  id: number;
  prNumber: number;
  commitId: string;
  // `event` is the input verb the createReview API takes; `state` is what
  // listReviews returns. Real GitHub returns LOWERCASE state strings, and
  // both build-revision-context.ts and state.ts filter on the lowercase
  // value (verified against existing fixtures in
  // router/test/helpers/build-revision-context.test.ts). The fake MUST
  // emit lowercase or the impl-review-retry-loop scenario crashes inside
  // build-revision-context with "PR has no REQUEST_CHANGES review".
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  state: "approved" | "changes_requested" | "commented";
  body: string;
  user: { login: string };
  submittedAt: string;
}

export interface ReviewComment {
  id: number;
  prNumber: number;
  reviewId: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
  user: { login: string };
}

export interface Status {
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string;
  targetUrl?: string;
  updatedAt: string;
}

export type WriteEvent =
  | { kind: "addLabel"; issue: number; label: string; t: number }
  | { kind: "removeLabel"; issue: number; label: string; t: number }
  | { kind: "createLabel"; name: string; t: number }
  | { kind: "createComment"; issue: number; id: number; t: number }
  | { kind: "updateComment"; id: number; t: number }
  | { kind: "updateIssueBody"; issue: number; t: number }
  | { kind: "closeIssue"; issue: number; t: number }
  | { kind: "openIssue"; issue: number; t: number }
  | { kind: "createPr"; pr: number; head: string; base: string; t: number }
  | { kind: "updatePr"; pr: number; fields: string[]; t: number }
  | { kind: "mergePr"; pr: number; sha: string; t: number }
  | {
      kind: "createReview";
      pr: number;
      id: number;
      event: Review["event"];
      user: string;
      t: number;
    }
  | { kind: "createReviewComment"; id: number; reviewId: number; t: number }
  | { kind: "setStatus"; sha: string; context: string; t: number };

export interface FakeState {
  repo: { owner: string; repo: string };
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment>;
  reviews: Map<number, Review>;
  reviewComments: Map<number, ReviewComment>;
  statuses: Map<string, Map<string, Status>>;
  branches: Map<string, string>; // branch -> head sha
  nextNumber: number; // shared issue/PR pool, matches GitHub
  nextCommentId: number;
  nextReviewId: number;
  nextReviewCommentId: number;
  authIdentity: string;
  reviewAuthIdentity?: string;
  eventLog: WriteEvent[];
  clock: number; // monotonically incrementing tick for tests
}

export function newFakeState(opts: {
  owner: string;
  repo: string;
  authIdentity?: string;
  reviewAuthIdentity?: string;
}): FakeState {
  return {
    repo: { owner: opts.owner, repo: opts.repo },
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    reviews: new Map(),
    reviewComments: new Map(),
    statuses: new Map(),
    branches: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextReviewId: 1,
    nextReviewCommentId: 1,
    authIdentity: opts.authIdentity ?? "shopfloor[bot]",
    reviewAuthIdentity: opts.reviewAuthIdentity,
    eventLog: [],
    clock: 0,
  };
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean. (No imports yet from these files, so any type error will be self-contained.)

- [ ] **Step 4: Run existing tests to confirm no regression from the index.ts edit**

Run: `pnpm test`
Expected: every existing test passes.

- [ ] **Step 5: Commit**

```bash
git add router/src/index.ts router/test/e2e/fake-github/state.ts router/test/e2e/fake-github/errors.ts
git commit -m "$(cat <<'EOF'
test(e2e): scaffold fake-github state model and errors

Establishes the type foundation for Layer 1 in-process e2e scenario tests:
entity shapes (Issue, Pull, Review, etc.), the FakeState container, the
WriteEvent discriminated union for the chronological mutation log, and a
FakeRequestError class shaped like @octokit/request-error so adapter
status-code branches behave the same against the fake.

Also exports `main` from router/src/index.ts behind a GITHUB_ACTIONS guard
so the upcoming scenario harness can import and invoke it without
auto-running at module load.
EOF
)"
```

---

### Task 2: Implement fake-github issues handler with semantic rules

Maps to commit 2: `test(e2e): implement fake-github issues handler with semantic rules`.

**Files:**
- Create: `router/test/e2e/fake-github/handlers/issues.ts`
- Create: `router/test/e2e/fake-github/fake-github.test.ts`

The issues handler is large enough to TDD method-by-method. Each method gets a failing test, then a minimal implementation. We commit once at the end of the task.

The handler is written as a free function that takes `state: FakeState` plus the call args. The eventual `FakeGitHub` class wires these together. This split keeps the handler files small and the class wiring trivial.

- [ ] **Step 1: Write failing test for `addLabels` rejecting unknown labels**

Create `router/test/e2e/fake-github/fake-github.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { newFakeState } from "./state";
import { FakeRequestError } from "./errors";
import { addLabels } from "./handlers/issues";

describe("issues.addLabels", () => {
  test("rejects unknown label with 422", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "alice",
      createdAt: "2026-04-15T00:00:00Z",
    });
    expect(() =>
      addLabels(state, { issue_number: 1, labels: ["never-bootstrapped"] }),
    ).toThrow(FakeRequestError);
    try {
      addLabels(state, { issue_number: 1, labels: ["never-bootstrapped"] });
    } catch (err) {
      expect((err as FakeRequestError).status).toBe(422);
    }
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm test router/test/e2e/fake-github/fake-github.test.ts`
Expected: FAIL — `Cannot find module './handlers/issues'`.

- [ ] **Step 3: Create `handlers/issues.ts` with the minimal `addLabels`**

```ts
// router/test/e2e/fake-github/handlers/issues.ts
import { FakeRequestError } from "../errors";
import type { FakeState } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

function requireIssue(state: FakeState, n: number) {
  const issue = state.issues.get(n);
  if (!issue) {
    throw new FakeRequestError(404, `Issue #${n} not found`);
  }
  return issue;
}

export function addLabels(
  state: FakeState,
  params: { issue_number: number; labels: string[] },
): { id: number; name: string }[] {
  const issue = requireIssue(state, params.issue_number);
  for (const label of params.labels) {
    if (!state.labels.has(label)) {
      throw new FakeRequestError(422, `Label does not exist: ${label}`);
    }
    if (!issue.labels.includes(label)) {
      issue.labels.push(label);
      state.eventLog.push({
        kind: "addLabel",
        issue: issue.number,
        label,
        t: nextTick(state),
      });
    }
  }
  return issue.labels.map((name, idx) => ({ id: idx + 1, name }));
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm test router/test/e2e/fake-github/fake-github.test.ts`
Expected: PASS.

- [ ] **Step 5: Add idempotency test for `addLabels`**

Append to the same `describe`:

```ts
test("is idempotent — adding the same label twice is a no-op", () => {
  const state = newFakeState({ owner: "o", repo: "r" });
  state.labels.set("shopfloor:triaging", { name: "shopfloor:triaging", color: "ededed" });
  state.issues.set(1, {
    number: 1, title: "x", body: null, state: "open", labels: [],
    author: "a", createdAt: "2026-04-15T00:00:00Z",
  });
  addLabels(state, { issue_number: 1, labels: ["shopfloor:triaging"] });
  addLabels(state, { issue_number: 1, labels: ["shopfloor:triaging"] });
  expect(state.issues.get(1)!.labels).toEqual(["shopfloor:triaging"]);
  expect(state.eventLog.filter((e) => e.kind === "addLabel")).toHaveLength(1);
});
```

Run the test, confirm PASS (the existing implementation already handles this).

- [ ] **Step 6: TDD `removeLabel` (404 if not on issue)**

```ts
import { removeLabel } from "./handlers/issues";

describe("issues.removeLabel", () => {
  test("throws 404 when label is not on the issue", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:foo", { name: "shopfloor:foo", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    expect(() => removeLabel(state, { issue_number: 1, name: "shopfloor:foo" }))
      .toThrow(FakeRequestError);
    try {
      removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    } catch (err) {
      expect((err as FakeRequestError).status).toBe(404);
    }
  });
  test("removes the label when present", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:foo", { name: "shopfloor:foo", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: ["shopfloor:foo"],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    expect(state.issues.get(1)!.labels).toEqual([]);
  });
});
```

Run, confirm FAIL with "removeLabel is not exported", then add the implementation:

```ts
export function removeLabel(
  state: FakeState,
  params: { issue_number: number; name: string },
): void {
  const issue = requireIssue(state, params.issue_number);
  const idx = issue.labels.indexOf(params.name);
  if (idx === -1) {
    throw new FakeRequestError(404, `Label not found on issue #${params.issue_number}`);
  }
  issue.labels.splice(idx, 1);
  state.eventLog.push({
    kind: "removeLabel",
    issue: issue.number,
    label: params.name,
    t: nextTick(state),
  });
}
```

Run, confirm PASS.

- [ ] **Step 7: TDD `createComment`**

Test (it allocates a fresh id, increments the next-id counter, returns `{id}`-shaped data, and logs):

```ts
import { createComment } from "./handlers/issues";

describe("issues.createComment", () => {
  test("allocates a fresh id and returns it", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    const a = createComment(state, { issue_number: 1, body: "hello" });
    const b = createComment(state, { issue_number: 1, body: "world" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(state.comments.get(1)!.body).toBe("hello");
    expect(state.comments.get(2)!.body).toBe("world");
  });
});
```

Run, confirm fail. Implement:

```ts
export function createComment(
  state: FakeState,
  params: { issue_number: number; body: string },
): { id: number } {
  requireIssue(state, params.issue_number);
  const id = state.nextCommentId++;
  state.comments.set(id, {
    id,
    issueNumber: params.issue_number,
    body: params.body,
    author: state.authIdentity,
  });
  state.eventLog.push({
    kind: "createComment",
    issue: params.issue_number,
    id,
    t: nextTick(state),
  });
  return { id };
}
```

Run, confirm PASS.

- [ ] **Step 8: TDD `updateComment`**

```ts
import { updateComment } from "./handlers/issues";

describe("issues.updateComment", () => {
  test("404 if comment id unknown", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    expect(() => updateComment(state, { comment_id: 999, body: "x" }))
      .toThrow(FakeRequestError);
  });
  test("updates the body", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.comments.set(1, { id: 1, issueNumber: 1, body: "old", author: "x" });
    updateComment(state, { comment_id: 1, body: "new" });
    expect(state.comments.get(1)!.body).toBe("new");
  });
});
```

Implement:

```ts
export function updateComment(
  state: FakeState,
  params: { comment_id: number; body: string },
): void {
  const c = state.comments.get(params.comment_id);
  if (!c) throw new FakeRequestError(404, `Comment #${params.comment_id} not found`);
  c.body = params.body;
  state.eventLog.push({ kind: "updateComment", id: c.id, t: nextTick(state) });
}
```

- [ ] **Step 9: TDD `createLabel` (422 if already exists, otherwise registers)**

```ts
import { createLabel } from "./handlers/issues";

describe("issues.createLabel", () => {
  test("registers a new label", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createLabel(state, { name: "shopfloor:foo", color: "ededed" });
    expect(state.labels.has("shopfloor:foo")).toBe(true);
  });
  test("throws 422 when label already exists", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createLabel(state, { name: "shopfloor:foo", color: "ededed" });
    expect(() => createLabel(state, { name: "shopfloor:foo", color: "ededed" }))
      .toThrow(FakeRequestError);
  });
});
```

Implement:

```ts
export function createLabel(
  state: FakeState,
  params: { name: string; color: string; description?: string },
): void {
  if (state.labels.has(params.name)) {
    throw new FakeRequestError(422, `Label already exists: ${params.name}`);
  }
  state.labels.set(params.name, {
    name: params.name,
    color: params.color,
    description: params.description,
  });
  state.eventLog.push({ kind: "createLabel", name: params.name, t: nextTick(state) });
}
```

- [ ] **Step 10: TDD `listLabelsForRepo` (returns all, pagination honored)**

```ts
import { listLabelsForRepo } from "./handlers/issues";

describe("issues.listLabelsForRepo", () => {
  test("returns all labels", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("a", { name: "a", color: "ededed" });
    state.labels.set("b", { name: "b", color: "ededed" });
    expect(listLabelsForRepo(state, { per_page: 100 }).map((l) => l.name).sort())
      .toEqual(["a", "b"]);
  });
});
```

Implement:

```ts
export function listLabelsForRepo(
  state: FakeState,
  params: { per_page?: number; page?: number } = {},
): Label[] {
  const all = Array.from(state.labels.values());
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}
```

(Add `import type { Label } from "../state";` at the top of `handlers/issues.ts`.)

- [ ] **Step 11: TDD `update` (state and body patch)**

```ts
import { updateIssue } from "./handlers/issues";

describe("issues.update", () => {
  test("closes an open issue and logs", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: "b", state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, state: "closed" });
    expect(state.issues.get(1)!.state).toBe("closed");
    expect(state.eventLog.some((e) => e.kind === "closeIssue")).toBe(true);
  });
  test("updates the body without changing state", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: "old", state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, body: "new" });
    expect(state.issues.get(1)!.body).toBe("new");
  });
});
```

Implement:

```ts
export function updateIssue(
  state: FakeState,
  params: { issue_number: number; state?: "open" | "closed"; body?: string },
): void {
  const issue = requireIssue(state, params.issue_number);
  if (params.state !== undefined && params.state !== issue.state) {
    issue.state = params.state;
    state.eventLog.push({
      kind: params.state === "closed" ? "closeIssue" : "openIssue",
      issue: issue.number,
      t: nextTick(state),
    });
  }
  if (params.body !== undefined) {
    issue.body = params.body;
    state.eventLog.push({
      kind: "updateIssueBody",
      issue: issue.number,
      t: nextTick(state),
    });
  }
}
```

- [ ] **Step 12: TDD `get` (Octokit envelope shape)**

```ts
import { getIssue } from "./handlers/issues";

describe("issues.get", () => {
  test("returns labels reshaped to [{name}]", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:triaging", { name: "shopfloor:triaging", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: "b", state: "open", labels: ["shopfloor:triaging"],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    const data = getIssue(state, { issue_number: 1 });
    expect(data.labels).toEqual([{ name: "shopfloor:triaging" }]);
    expect(data.title).toBe("x");
    expect(data.body).toBe("b");
    expect(data.state).toBe("open");
  });
});
```

Implement:

```ts
export function getIssue(
  state: FakeState,
  params: { issue_number: number },
): {
  labels: Array<{ name: string }>;
  state: "open" | "closed";
  title: string;
  body: string | null;
} {
  const issue = requireIssue(state, params.issue_number);
  return {
    labels: issue.labels.map((name) => ({ name })),
    state: issue.state,
    title: issue.title,
    body: issue.body,
  };
}
```

- [ ] **Step 13: TDD `listComments` (returns user/created_at/body, pagination)**

```ts
import { listComments } from "./handlers/issues";

describe("issues.listComments", () => {
  test("returns comments for the issue", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    state.comments.set(1, { id: 1, issueNumber: 1, body: "hi", author: "alice" });
    state.comments.set(2, { id: 2, issueNumber: 99, body: "elsewhere", author: "bob" });
    const out = listComments(state, { issue_number: 1, per_page: 100, page: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("hi");
    expect(out[0].user).toEqual({ login: "alice" });
  });
});
```

Implement:

```ts
export function listComments(
  state: FakeState,
  params: { issue_number: number; per_page?: number; page?: number },
): Array<{ user: { login: string }; created_at: string; body: string }> {
  const all = Array.from(state.comments.values())
    .filter((c) => c.issueNumber === params.issue_number)
    .map((c) => ({
      user: { login: c.author },
      // The fake does not distinguish per-comment created_at; surface a
      // deterministic ISO timestamp derived from the comment id so tests
      // that round-trip on this field stay stable.
      created_at: `2026-04-15T00:00:${String(c.id).padStart(2, "0")}Z`,
      body: c.body,
    }));
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}
```

- [ ] **Step 14: Run the full fake-github.test.ts**

Run: `pnpm test router/test/e2e/fake-github/fake-github.test.ts`
Expected: all issues-handler tests pass.

- [ ] **Step 15: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 16: Commit**

```bash
git add router/test/e2e/fake-github/handlers/issues.ts router/test/e2e/fake-github/fake-github.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): implement fake-github issues handler with semantic rules

Adds the issues subset of the in-memory GitHub fake: addLabels (with
authoritative label registry validation, idempotency), removeLabel
(404 when missing, mirroring the adapter's catch-and-ignore branch),
createComment (id allocation), updateComment, createLabel (422 on
duplicate), listLabelsForRepo, update (state + body), get (Octokit
envelope shape), listComments (pagination).

Each method is covered by a fake-github.test.ts case that exercises
the semantic rule the handler enforces, so a regression in the fake
itself is caught in isolation rather than corrupting every scenario.
EOF
)"
```

---

### Task 3: Implement fake-github pulls handler with semantic rules

Maps to commit 3: `test(e2e): implement fake-github pulls handler with semantic rules`.

**Files:**
- Create: `router/test/e2e/fake-github/handlers/pulls.ts`
- Modify: `router/test/e2e/fake-github/fake-github.test.ts` (append more describes)

The pulls handler is the most rule-laden file in the fake. Eight Octokit methods, four semantic rules.

- [ ] **Step 1: TDD `pulls.create` (rejects unknown head branch)**

Append to `fake-github.test.ts`:

```ts
import { createPr } from "./handlers/pulls";

describe("pulls.create", () => {
  test("rejects when the head branch does not exist", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    expect(() =>
      createPr(state, {
        base: "main",
        head: "shopfloor/42-foo",
        title: "T",
        body: "B",
        draft: false,
      }),
    ).toThrow(FakeRequestError);
  });
});
```

Run, confirm fail. Create `handlers/pulls.ts`:

```ts
// router/test/e2e/fake-github/handlers/pulls.ts
import { FakeRequestError } from "../errors";
import type { FakeState, Pull } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

function requirePr(state: FakeState, n: number): Pull {
  const pr = state.pulls.get(n);
  if (!pr) throw new FakeRequestError(404, `Pull #${n} not found`);
  return pr;
}

export function createPr(
  state: FakeState,
  params: {
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
  },
): { number: number; html_url: string } {
  if (!state.branches.has(params.head)) {
    throw new FakeRequestError(
      422,
      `Head branch ${params.head} does not exist on ${state.repo.owner}/${state.repo.repo}`,
    );
  }
  const headSha = state.branches.get(params.head)!;
  const baseSha = state.branches.get(params.base) ?? "sha-base-0";
  // Open-PR-per-head uniqueness
  for (const existing of state.pulls.values()) {
    if (
      existing.head.ref === params.head &&
      existing.state === "open" &&
      !existing.merged
    ) {
      throw new FakeRequestError(
        422,
        `A pull request already exists for ${state.repo.owner}:${params.head}`,
      );
    }
  }
  const n = state.nextNumber++;
  const pr: Pull = {
    number: n,
    title: params.title,
    body: params.body,
    state: "open",
    draft: params.draft ?? false,
    merged: false,
    base: { ref: params.base, sha: baseSha },
    head: { ref: params.head, sha: headSha },
    labels: [],
    author: state.authIdentity,
    files: [],
    createdAt: `2026-04-15T00:00:${String(n).padStart(2, "0")}Z`,
  };
  state.pulls.set(n, pr);
  state.eventLog.push({
    kind: "createPr",
    pr: n,
    head: params.head,
    base: params.base,
    t: nextTick(state),
  });
  return {
    number: n,
    html_url: `https://github.com/${state.repo.owner}/${state.repo.repo}/pull/${n}`,
  };
}
```

Run, confirm PASS.

- [ ] **Step 2: Open-PR-per-head uniqueness test**

```ts
test("open-PR-per-head uniqueness: second open PR for same head is rejected", () => {
  const state = newFakeState({ owner: "o", repo: "r" });
  state.branches.set("main", "sha-main-0");
  state.branches.set("shopfloor/42-foo", "sha-foo-0");
  createPr(state, { base: "main", head: "shopfloor/42-foo", title: "T", body: "B" });
  expect(() =>
    createPr(state, { base: "main", head: "shopfloor/42-foo", title: "T2", body: "B2" }),
  ).toThrow(/already exists/);
});
```

Run, confirm PASS (the existing implementation already handles this).

- [ ] **Step 3: TDD `pulls.list` (filter by state and head:`owner:branch`)**

```ts
import { listPrs } from "./handlers/pulls";

describe("pulls.list", () => {
  test("filters by head with owner:branch format", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("shopfloor/42-foo", "sha-foo-0");
    state.branches.set("shopfloor/43-bar", "sha-bar-0");
    createPr(state, { base: "main", head: "shopfloor/42-foo", title: "A", body: "" });
    createPr(state, { base: "main", head: "shopfloor/43-bar", title: "B", body: "" });
    const result = listPrs(state, { head: "o:shopfloor/42-foo", state: "open" });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });
});
```

Implement:

```ts
export function listPrs(
  state: FakeState,
  params: {
    head?: string;
    state?: "open" | "closed" | "all";
    per_page?: number;
  },
): Array<{ number: number; html_url: string }> {
  const stateFilter = params.state ?? "open";
  let result = Array.from(state.pulls.values());
  if (stateFilter !== "all") {
    result = result.filter((p) => p.state === stateFilter);
  }
  if (params.head) {
    // GitHub format: "owner:branch"
    const [, headRef] = params.head.split(":");
    result = result.filter((p) => p.head.ref === headRef);
  }
  const per = params.per_page ?? 30;
  return result.slice(0, per).map((p) => ({
    number: p.number,
    html_url: `https://github.com/${state.repo.owner}/${state.repo.repo}/pull/${p.number}`,
  }));
}
```

- [ ] **Step 4: TDD `pulls.update` (title/body patch)**

```ts
import { updatePr } from "./handlers/pulls";

describe("pulls.update", () => {
  test("patches title and body", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "old", body: "old" });
    updatePr(state, { pull_number: 1, title: "new-t", body: "new-b" });
    expect(state.pulls.get(1)!.title).toBe("new-t");
    expect(state.pulls.get(1)!.body).toBe("new-b");
  });
});
```

Implement:

```ts
export function updatePr(
  state: FakeState,
  params: { pull_number: number; title?: string; body?: string },
): void {
  const pr = requirePr(state, params.pull_number);
  const fields: string[] = [];
  if (params.title !== undefined) {
    pr.title = params.title;
    fields.push("title");
  }
  if (params.body !== undefined) {
    pr.body = params.body;
    fields.push("body");
  }
  state.eventLog.push({
    kind: "updatePr",
    pr: pr.number,
    fields,
    t: nextTick(state),
  });
}
```

- [ ] **Step 5: TDD `pulls.get` (full PR shape)**

```ts
import { getPr } from "./handlers/pulls";

describe("pulls.get", () => {
  test("returns full PR shape", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    const data = getPr(state, { pull_number: 1 });
    expect(data.head).toEqual(expect.objectContaining({ ref: "h", sha: "sha-h-0" }));
    expect(data.state).toBe("open");
    expect(data.draft).toBe(false);
    expect(data.merged).toBe(false);
  });
});
```

Implement (returns the same shape `GitHubAdapter.getPr` consumes — see `router/src/github.ts`):

```ts
export function getPr(
  state: FakeState,
  params: { pull_number: number },
): {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  body: string | null;
} {
  const pr = requirePr(state, params.pull_number);
  return {
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    labels: pr.labels.map((name) => ({ name })),
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    body: pr.body,
  };
}
```

- [ ] **Step 6: TDD `pulls.listFiles` (returns harness-seeded files, pagination)**

```ts
import { listFiles } from "./handlers/pulls";

describe("pulls.listFiles", () => {
  test("returns the seeded file list", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    state.pulls.get(1)!.files = ["src/a.ts", "src/b.ts"];
    const data = listFiles(state, { pull_number: 1 });
    expect(data.map((d) => d.filename)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
```

Implement:

```ts
export function listFiles(
  state: FakeState,
  params: { pull_number: number; per_page?: number; page?: number },
): Array<{ filename: string }> {
  const pr = requirePr(state, params.pull_number);
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return pr.files
    .slice((page - 1) * per, page * per)
    .map((filename) => ({ filename }));
}
```

- [ ] **Step 7: TDD `pulls.createReview` self-review enforcement**

This is THE critical rule.

```ts
import { createReview } from "./handlers/pulls";

describe("pulls.createReview", () => {
  test("rejects REQUEST_CHANGES when reviewer matches PR author", () => {
    const state = newFakeState({
      owner: "o", repo: "r",
      authIdentity: "shopfloor[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    expect(() =>
      createReview(state, {
        pull_number: 1,
        commit_id: "sha-h-0",
        event: "REQUEST_CHANGES",
        body: "no",
        comments: [],
        actor: "shopfloor[bot]",
      }),
    ).toThrow(/Can not approve your own pull request/);
  });
  test("allows REQUEST_CHANGES from a distinct identity", () => {
    const state = newFakeState({
      owner: "o", repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-h-0",
      event: "REQUEST_CHANGES",
      body: "fix this",
      comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "rename" }],
      actor: "shopfloor-review[bot]",
    });
    expect(state.reviews.size).toBe(1);
    expect(state.reviewComments.size).toBe(1);
    const review = Array.from(state.reviews.values())[0];
    expect(review.state).toBe("changes_requested");
    expect(review.user.login).toBe("shopfloor-review[bot]");
  });
  test("allows COMMENT review even from PR author", () => {
    const state = newFakeState({ owner: "o", repo: "r", authIdentity: "shopfloor[bot]" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-h-0",
      event: "COMMENT",
      body: "fyi",
      comments: [],
      actor: "shopfloor[bot]",
    });
    expect(state.reviews.size).toBe(1);
  });
});
```

Implement:

```ts
// LOWERCASE on purpose — see the comment on the Review type in state.ts.
const EVENT_TO_STATE: Record<
  "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "approved" | "changes_requested" | "commented"
> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

export interface CreateReviewParams {
  pull_number: number;
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
    body: string;
  }>;
  /** Identity (login) of whoever is making this call. The shim sets this. */
  actor: string;
}

export function createReview(state: FakeState, params: CreateReviewParams): void {
  const pr = requirePr(state, params.pull_number);
  if (params.event !== "COMMENT" && params.actor === pr.author) {
    throw new FakeRequestError(
      422,
      "Can not approve your own pull request",
    );
  }
  const id = state.nextReviewId++;
  state.reviews.set(id, {
    id,
    prNumber: pr.number,
    commitId: params.commit_id,
    event: params.event,
    state: EVENT_TO_STATE[params.event],
    body: params.body,
    user: { login: params.actor },
    submittedAt: `2026-04-15T00:00:${String(state.clock + 1).padStart(2, "0")}Z`,
  });
  state.eventLog.push({
    kind: "createReview",
    pr: pr.number,
    id,
    event: params.event,
    user: params.actor,
    t: nextTick(state),
  });
  for (const c of params.comments) {
    const cid = state.nextReviewCommentId++;
    state.reviewComments.set(cid, {
      id: cid,
      prNumber: pr.number,
      reviewId: id,
      path: c.path,
      line: c.line,
      side: c.side,
      startLine: c.start_line,
      startSide: c.start_side,
      body: c.body,
      user: { login: params.actor },
    });
    state.eventLog.push({
      kind: "createReviewComment",
      id: cid,
      reviewId: id,
      t: nextTick(state),
    });
  }
}
```

Run all three tests, confirm PASS.

- [ ] **Step 8: TDD `pulls.listReviews` row shape (id/user.login/body/commit_id/state/submitted_at)**

This is the row shape `build-revision-context.ts` consumes — `commit_id`, `state`, `submitted_at` are all required or the impl-review-retry-loop scenario crashes.

```ts
import { listReviews } from "./handlers/pulls";

describe("pulls.listReviews", () => {
  test("returns rows with commit_id, state, and submitted_at", () => {
    const state = newFakeState({
      owner: "o", repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1, commit_id: "sha-1", event: "REQUEST_CHANGES",
      body: "fix", comments: [], actor: "shopfloor-review[bot]",
    });
    const rows = listReviews(state, { pull_number: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        commit_id: "sha-1",
        // Lowercase: real GitHub returns lowercase state strings, and the
        // router (build-revision-context, state.ts) filters on lowercase.
        state: "changes_requested",
        submitted_at: expect.any(String),
        user: { login: "shopfloor-review[bot]" },
        body: "fix",
      }),
    );
  });
});
```

Implement:

```ts
export function listReviews(
  state: FakeState,
  params: { pull_number: number; per_page?: number },
): Array<{
  id: number;
  user: { login: string } | null;
  body: string;
  commit_id: string;
  state: string;
  submitted_at: string;
}> {
  const all = Array.from(state.reviews.values()).filter(
    (r) => r.prNumber === params.pull_number,
  );
  return all.map((r) => ({
    id: r.id,
    user: r.user,
    body: r.body,
    commit_id: r.commitId,
    state: r.state,
    submitted_at: r.submittedAt,
  }));
}
```

- [ ] **Step 9: TDD `pulls.listReviewComments` row shape**

```ts
import { listReviewComments } from "./handlers/pulls";

describe("pulls.listReviewComments", () => {
  test("returns inline comments with pull_request_review_id and path/line/side/body", () => {
    const state = newFakeState({
      owner: "o", repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1, commit_id: "sha-1", event: "REQUEST_CHANGES",
      body: "fix", comments: [
        { path: "src/a.ts", line: 5, side: "RIGHT", body: "rename" },
      ],
      actor: "shopfloor-review[bot]",
    });
    const out = listReviewComments(state, { pull_number: 1, per_page: 100, page: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(
      expect.objectContaining({
        path: "src/a.ts",
        line: 5,
        side: "RIGHT",
        body: "rename",
        pull_request_review_id: 1,
      }),
    );
  });
});
```

Implement:

```ts
export function listReviewComments(
  state: FakeState,
  params: { pull_number: number; per_page?: number; page?: number },
): Array<{
  id: number;
  pull_request_review_id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  body: string;
}> {
  const all = Array.from(state.reviewComments.values())
    .filter((c) => c.prNumber === params.pull_number)
    .map((c) => ({
      id: c.id,
      pull_request_review_id: c.reviewId,
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.startLine ?? null,
      start_side: c.startSide ?? null,
      body: c.body,
    }));
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}
```

- [ ] **Step 10: Run the full pulls handler test suite**

Run: `pnpm test router/test/e2e/fake-github/fake-github.test.ts`
Expected: every issues + pulls test green.

- [ ] **Step 11: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add router/test/e2e/fake-github/handlers/pulls.ts router/test/e2e/fake-github/fake-github.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): implement fake-github pulls handler with semantic rules

Adds the pulls subset of the in-memory GitHub fake: create (with branch
existence check and open-PR-per-head uniqueness), list (head filter in
owner:branch format), update, get, listFiles, createReview (with the
critical self-review forbidden rule that makes the fake catch the dual
App identity contract), listReviews (row shape with commit_id/state/
submitted_at — all consumed by build-revision-context), and
listReviewComments (rows with pull_request_review_id + path/line/side).

Each method is covered by a fake-github.test.ts case that exercises the
semantic rule. The self-review test uses two distinct identities to
mirror production's primary App + review App split.
EOF
)"
```

---

### Task 4: Implement fake-github repos handler, snapshot helpers, and FakeGitHub class wiring

Maps to commit 4: `test(e2e): implement fake-github repos handler and snapshot helpers`.

**Files:**
- Create: `router/test/e2e/fake-github/handlers/repos.ts`
- Create: `router/test/e2e/fake-github/octokit-shim.ts`
- Create: `router/test/e2e/fake-github/index.ts`
- Modify: `router/test/e2e/fake-github/fake-github.test.ts` (append repos + snapshot tests)

This commit closes out the fake. After this, `FakeGitHub` is fully usable from outside the package.

- [ ] **Step 1: TDD `repos.createCommitStatus` (truncation + latest-wins)**

```ts
import { createCommitStatus } from "./handlers/repos";

describe("repos.createCommitStatus", () => {
  test("truncates description to 140 chars", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    const long = "x".repeat(200);
    createCommitStatus(state, {
      sha: "abc",
      state: "pending",
      context: "shopfloor/review",
      description: long,
    });
    const ctxMap = state.statuses.get("abc")!;
    expect(ctxMap.get("shopfloor/review")!.description).toHaveLength(140);
  });
  test("latest-wins per (sha, context)", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createCommitStatus(state, {
      sha: "abc", state: "pending",
      context: "shopfloor/review", description: "first",
    });
    createCommitStatus(state, {
      sha: "abc", state: "success",
      context: "shopfloor/review", description: "second",
    });
    expect(state.statuses.get("abc")!.get("shopfloor/review")!.state).toBe("success");
    expect(state.statuses.get("abc")!.get("shopfloor/review")!.description).toBe("second");
  });
});
```

Run, confirm fail. Create `handlers/repos.ts`:

```ts
// router/test/e2e/fake-github/handlers/repos.ts
import type { FakeState } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

export function createCommitStatus(
  state: FakeState,
  params: {
    sha: string;
    state: "pending" | "success" | "failure" | "error";
    context: string;
    description: string;
    target_url?: string;
  },
): void {
  let perSha = state.statuses.get(params.sha);
  if (!perSha) {
    perSha = new Map();
    state.statuses.set(params.sha, perSha);
  }
  perSha.set(params.context, {
    sha: params.sha,
    context: params.context,
    state: params.state,
    description: params.description.slice(0, 140),
    targetUrl: params.target_url,
    updatedAt: `2026-04-15T00:00:${String(state.clock + 1).padStart(2, "0")}Z`,
  });
  state.eventLog.push({
    kind: "setStatus",
    sha: params.sha,
    context: params.context,
    t: nextTick(state),
  });
}
```

Run, confirm PASS.

- [ ] **Step 2: Create the Octokit shim**

```ts
// router/test/e2e/fake-github/octokit-shim.ts
import type { OctokitLike } from "../../../src/types";
import type { FakeState } from "./state";
import * as issues from "./handlers/issues";
import * as pulls from "./handlers/pulls";
import * as repos from "./handlers/repos";

export interface ShimOptions {
  state: FakeState;
  /** The login of whichever GitHub App is making this call. */
  actor: string;
}

function envelope<T>(data: T): { data: T } {
  return { data };
}

export function buildOctokitShim(opts: ShimOptions): OctokitLike {
  const { state, actor } = opts;
  return {
    rest: {
      issues: {
        async addLabels(p) {
          return envelope(issues.addLabels(state, p));
        },
        async removeLabel(p) {
          issues.removeLabel(state, p);
          return envelope([]);
        },
        async createComment(p) {
          return envelope(issues.createComment(state, p));
        },
        async updateComment(p) {
          issues.updateComment(state, p);
          return envelope({});
        },
        async createLabel(p) {
          issues.createLabel(state, p);
          return envelope({});
        },
        async listLabelsForRepo(p) {
          return envelope(issues.listLabelsForRepo(state, p));
        },
        async update(p) {
          issues.updateIssue(state, p);
          return envelope({});
        },
        async get(p) {
          const data = issues.getIssue(state, p);
          return { data: { ...data, labels: data.labels } } as never;
        },
        async listComments(p) {
          return envelope(issues.listComments(state, p));
        },
      },
      pulls: {
        async create(p) {
          return envelope(pulls.createPr(state, p));
        },
        async list(p) {
          return envelope(pulls.listPrs(state, p));
        },
        async update(p) {
          pulls.updatePr(state, p);
          return envelope({});
        },
        async get(p) {
          return envelope(pulls.getPr(state, p)) as never;
        },
        async listFiles(p) {
          return envelope(pulls.listFiles(state, p));
        },
        async createReview(p) {
          pulls.createReview(state, { ...p, actor, comments: p.comments ?? [] });
          return envelope({});
        },
        async listReviews(p) {
          return envelope(pulls.listReviews(state, p));
        },
        async listReviewComments(p) {
          return envelope(pulls.listReviewComments(state, p));
        },
      },
      repos: {
        async createCommitStatus(p) {
          repos.createCommitStatus(state, p);
          return envelope({});
        },
      },
    },
  } satisfies OctokitLike;
}
```

- [ ] **Step 3: Create the FakeGitHub class wiring**

```ts
// router/test/e2e/fake-github/index.ts
import type { OctokitLike } from "../../../src/types";
import {
  newFakeState,
  type FakeState,
  type Issue,
  type Pull,
  type Comment,
  type Review,
  type Status,
  type WriteEvent,
} from "./state";
import { buildOctokitShim } from "./octokit-shim";
export { FakeRequestError } from "./errors";

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  authIdentity?: string;
  reviewAuthIdentity?: string;
}

export class FakeGitHub {
  private readonly state: FakeState;

  constructor(opts: FakeGitHubOptions) {
    this.state = newFakeState(opts);
  }

  get owner(): string {
    return this.state.repo.owner;
  }
  get repo(): string {
    return this.state.repo.repo;
  }
  /** The login the primary App authenticates as. */
  get primaryIdentity(): string {
    return this.state.authIdentity;
  }
  /** The login the secondary review App authenticates as, if configured. */
  get reviewIdentity(): string | undefined {
    return this.state.reviewAuthIdentity;
  }

  /** Build an OctokitLike shim that authenticates as `actor`. */
  asOctokit(actor: string): OctokitLike {
    return buildOctokitShim({ state: this.state, actor });
  }

  // ── Seeding ────────────────────────────────────────────────────
  seedLabels(labels: Array<{ name: string; color: string; description?: string }>): void {
    for (const l of labels) {
      this.state.labels.set(l.name, l);
    }
  }

  seedIssue(input: {
    number: number;
    title: string;
    body: string | null;
    author: string;
    labels?: string[];
  }): void {
    if (input.number >= this.state.nextNumber) {
      this.state.nextNumber = input.number + 1;
    }
    this.state.issues.set(input.number, {
      number: input.number,
      title: input.title,
      body: input.body,
      state: "open",
      labels: input.labels ?? [],
      author: input.author,
      createdAt: `2026-04-15T00:00:00Z`,
    });
  }

  seedBranch(name: string, sha: string): void {
    this.state.branches.set(name, sha);
  }

  /** For test setups that need a deterministic head SHA progression. */
  advanceSha(branch: string): string {
    const current = this.state.branches.get(branch);
    if (!current) throw new Error(`advanceSha: unknown branch ${branch}`);
    const m = current.match(/^(.+)-(\d+)$/);
    const next = m ? `${m[1]}-${Number(m[2]) + 1}` : `${current}-1`;
    this.state.branches.set(branch, next);
    return next;
  }

  /** Helper used by scenarios; the router never merges PRs in production. */
  mergePr(prNumber: number, sha: string): void {
    const pr = this.state.pulls.get(prNumber);
    if (!pr) throw new Error(`mergePr: pr #${prNumber} not found`);
    pr.merged = true;
    pr.state = "closed";
    pr.mergedAt = `2026-04-15T00:00:${String(this.state.clock + 1).padStart(2, "0")}Z`;
    this.state.eventLog.push({
      kind: "mergePr",
      pr: prNumber,
      sha,
      t: ++this.state.clock,
    });
  }

  // ── Read-side accessors ────────────────────────────────────────
  issue(n: number): Issue {
    const i = this.state.issues.get(n);
    if (!i) throw new Error(`fake.issue(${n}): not found`);
    return i;
  }
  pr(n: number): Pull {
    const p = this.state.pulls.get(n);
    if (!p) throw new Error(`fake.pr(${n}): not found`);
    return p;
  }
  labelsOn(issueNumber: number): string[] {
    return this.issue(issueNumber).labels.slice();
  }
  commentsOn(issueNumber: number): Comment[] {
    return Array.from(this.state.comments.values()).filter(
      (c) => c.issueNumber === issueNumber,
    );
  }
  reviewsOn(prNumber: number): Review[] {
    return Array.from(this.state.reviews.values()).filter(
      (r) => r.prNumber === prNumber,
    );
  }
  statusFor(sha: string, context: string): Status | undefined {
    return this.state.statuses.get(sha)?.get(context);
  }
  openPrs(): Pull[] {
    return Array.from(this.state.pulls.values()).filter((p) => p.state === "open");
  }
  eventLog(): WriteEvent[] {
    return this.state.eventLog.slice();
  }
  eventLogSummary(): string {
    return this.state.eventLog
      .map((e) => `[t+${e.t}] ${JSON.stringify(e)}`)
      .join("\n");
  }

  /**
   * Snapshot suitable for `toMatchSnapshot()`. Internal counters and the
   * event log are deliberately omitted so reorderings do not noisy-diff.
   */
  snapshot(): unknown {
    return {
      labels: Array.from(this.state.labels.keys()).sort(),
      issues: Array.from(this.state.issues.values())
        .sort((a, b) => a.number - b.number)
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels,
          body: i.body,
        })),
      pulls: Array.from(this.state.pulls.values())
        .sort((a, b) => a.number - b.number)
        .map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          merged: p.merged,
          base: p.base.ref,
          head: p.head.ref,
          body: p.body,
        })),
      comments: Array.from(this.state.comments.values()).map((c) => ({
        issue: c.issueNumber,
        body: c.body,
        author: c.author,
      })),
      reviews: Array.from(this.state.reviews.values()).map((r) => ({
        pr: r.prNumber,
        state: r.state,
        commit: r.commitId,
        body: r.body,
        user: r.user.login,
      })),
      statuses: Array.from(this.state.statuses.entries()).map(([sha, m]) => ({
        sha,
        contexts: Array.from(m.entries()).map(([ctx, s]) => ({
          context: ctx,
          state: s.state,
          description: s.description,
        })),
      })),
    };
  }
}
```

- [ ] **Step 4: TDD smoke test for `FakeGitHub.asOctokit` round-trip**

```ts
import { FakeGitHub } from "./index";

describe("FakeGitHub.asOctokit", () => {
  test("addLabels through the shim mutates the underlying state", async () => {
    const fake = new FakeGitHub({ owner: "o", repo: "r" });
    fake.seedLabels([{ name: "shopfloor:trigger", color: "ededed" }]);
    fake.seedIssue({ number: 1, title: "x", body: null, author: "a" });
    const oct = fake.asOctokit("shopfloor[bot]");
    await oct.rest.issues.addLabels({
      owner: "o", repo: "r", issue_number: 1, labels: ["shopfloor:trigger"],
    });
    expect(fake.labelsOn(1)).toEqual(["shopfloor:trigger"]);
  });
  test("snapshot omits internal counters and event log", () => {
    const fake = new FakeGitHub({ owner: "o", repo: "r" });
    fake.seedLabels([{ name: "shopfloor:trigger", color: "ededed" }]);
    fake.seedIssue({ number: 1, title: "x", body: null, author: "a" });
    const snap = fake.snapshot() as Record<string, unknown>;
    expect(snap).toHaveProperty("issues");
    expect(snap).not.toHaveProperty("nextNumber");
    expect(snap).not.toHaveProperty("eventLog");
  });
});
```

Run, confirm PASS. (If not, fix the wiring.)

- [ ] **Step 5: Run the full fake-github.test.ts**

Run: `pnpm test router/test/e2e/fake-github`
Expected: green across issues, pulls, repos, FakeGitHub.

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add router/test/e2e/fake-github/handlers/repos.ts router/test/e2e/fake-github/octokit-shim.ts router/test/e2e/fake-github/index.ts router/test/e2e/fake-github/fake-github.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): implement fake-github repos handler and snapshot helpers

Closes out the in-memory fake: repos.createCommitStatus with the 140-
char description truncation and latest-wins per (sha, context); the
FakeGitHub class wiring all handlers, seed helpers (seedLabels,
seedIssue, seedBranch, advanceSha, mergePr), read-side accessors
(issue, pr, labelsOn, commentsOn, reviewsOn, statusFor, openPrs,
eventLog, eventLogSummary), and a snapshot() shape that omits internal
counters and the event log so vitest snapshots stay stable across
internal reorderings; and the OctokitLike shim that lets the same
FakeGitHub serve both the primary and review App identities by binding
an actor at shim-construction time.
EOF
)"
```

---

## Phase 2: Harness fundamentals

### Task 5: Scaffold scenario harness with env lifecycle and output parsing

Maps to commit 5: `test(e2e): scaffold scenario harness with env lifecycle and output parsing`.

**Files:**
- Create: `router/test/e2e/harness/env.ts`
- Create: `router/test/e2e/harness/parse-output.ts`
- Create: `router/test/e2e/harness/scenario-harness.test.ts`

Note: `scenario-harness.ts` itself comes in Task 7, when the job graph is wired up. This commit lays the foundation: env snapshot/restore, GITHUB_OUTPUT parsing, `resetCoreState`. No `ScenarioHarness` class yet — just the supporting modules and their tests.

- [ ] **Step 1: TDD `parseGithubOutput`**

`@actions/core` writes outputs as:

```
key<<DELIM
value
DELIM
```

Create the test:

```ts
// router/test/e2e/harness/scenario-harness.test.ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { parseGithubOutput } from "./parse-output";

describe("parseGithubOutput", () => {
  test("parses single key/value", () => {
    const raw = "stage<<ghadelim_a\nplan\nghadelim_a\n";
    expect(parseGithubOutput(raw)).toEqual({ stage: "plan" });
  });
  test("parses multiple key/values", () => {
    const raw =
      "stage<<d1\nplan\nd1\n" +
      "issue_number<<d2\n42\nd2\n";
    expect(parseGithubOutput(raw)).toEqual({
      stage: "plan",
      issue_number: "42",
    });
  });
  test("parses multi-line value", () => {
    const raw = "rendered<<DELIM\nline 1\nline 2\nline 3\nDELIM\n";
    expect(parseGithubOutput(raw)).toEqual({
      rendered: "line 1\nline 2\nline 3",
    });
  });
  test("returns empty object for empty file", () => {
    expect(parseGithubOutput("")).toEqual({});
  });
});
```

Run, confirm fail. Implement:

```ts
// router/test/e2e/harness/parse-output.ts

/**
 * Parses the GITHUB_OUTPUT delimited file format `@actions/core` writes.
 * Format: `key<<DELIM\nvalue\nDELIM\n` (multi-line values supported).
 */
export function parseGithubOutput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const m = header.match(/^([A-Za-z0-9_]+)<<(.+)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const delim = m[2];
    const valueLines: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delim) {
      valueLines.push(lines[i]);
      i++;
    }
    out[key] = valueLines.join("\n");
    i++; // skip the closing delim
  }
  return out;
}
```

Run, confirm PASS.

- [ ] **Step 2: TDD env snapshot/restore**

```ts
import { snapshotEnv } from "./env";

describe("snapshotEnv", () => {
  beforeEach(() => {
    delete process.env.SHOPFLOOR_TEST_VAR;
  });
  afterEach(() => {
    delete process.env.SHOPFLOOR_TEST_VAR;
  });
  test("restores added variables to undefined", () => {
    const restore = snapshotEnv();
    process.env.SHOPFLOOR_TEST_VAR = "x";
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBeUndefined();
  });
  test("restores modified variables to original value", () => {
    process.env.SHOPFLOOR_TEST_VAR = "before";
    const restore = snapshotEnv();
    process.env.SHOPFLOOR_TEST_VAR = "after";
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBe("before");
  });
  test("restores deleted variables", () => {
    process.env.SHOPFLOOR_TEST_VAR = "before";
    const restore = snapshotEnv();
    delete process.env.SHOPFLOOR_TEST_VAR;
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBe("before");
  });
});
```

Run, confirm fail. Create `env.ts`:

```ts
// router/test/e2e/harness/env.ts

/**
 * Snapshots process.env at call time and returns a restore function that
 * reverts adds, modifies, and deletes. Used by the harness to make every
 * helper invocation env-clean: INPUT_*, GITHUB_*, RUNNER_TEMP all evaporate
 * when the helper finishes regardless of which path through main() ran.
 */
export function snapshotEnv(): () => void {
  const before = new Map<string, string | undefined>();
  for (const k of Object.keys(process.env)) before.set(k, process.env[k]);
  return () => {
    // 1. Remove anything new
    for (const k of Object.keys(process.env)) {
      if (!before.has(k)) delete process.env[k];
    }
    // 2. Restore everything that existed before
    for (const [k, v] of before.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Resets all @actions/core internal state that can leak between
 * back-to-back helper invocations in the same process. Validated
 * empirically against @actions/core's source (router/node_modules/
 * @actions/core/lib/core.js):
 *
 * 1. process.exitCode — setFailed sets this. If a previous helper called
 *    setFailed and the next helper does not, the test would still see a
 *    non-zero exit code.
 * 2. GITHUB_OUTPUT file — `core.setOutput` appends to whatever path is in
 *    GITHUB_OUTPUT. The harness creates a fresh file per invocation, so
 *    there is nothing to reset here, but we assert the file exists and is
 *    truncated, as a tripwire.
 * 3. GITHUB_STATE / GITHUB_ENV — `saveState` / `exportVariable` write
 *    here. No router helper currently uses them, so we throw if they are
 *    set at invocation time, as a tripwire for future helpers.
 */
export function resetCoreState(): void {
  process.exitCode = undefined;
  if (process.env.GITHUB_STATE !== undefined) {
    throw new Error(
      "resetCoreState: GITHUB_STATE is unexpectedly set. Update env.ts to handle the new helper that uses core.saveState.",
    );
  }
  if (process.env.GITHUB_ENV !== undefined) {
    throw new Error(
      "resetCoreState: GITHUB_ENV is unexpectedly set. Update env.ts to handle the new helper that uses core.exportVariable.",
    );
  }
}
```

Run, confirm PASS.

- [ ] **Step 3: TDD `resetCoreState`**

```ts
import { resetCoreState } from "./env";

describe("resetCoreState", () => {
  test("clears process.exitCode", () => {
    process.exitCode = 1;
    resetCoreState();
    expect(process.exitCode).toBeUndefined();
  });
  test("throws if GITHUB_STATE is set as a tripwire", () => {
    process.env.GITHUB_STATE = "/tmp/x";
    try {
      expect(() => resetCoreState()).toThrow(/GITHUB_STATE/);
    } finally {
      delete process.env.GITHUB_STATE;
    }
  });
});
```

Run, confirm PASS.

- [ ] **Step 4: Run the full harness self-test file**

Run: `pnpm test router/test/e2e/harness/scenario-harness.test.ts`
Expected: green.

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add router/test/e2e/harness/env.ts router/test/e2e/harness/parse-output.ts router/test/e2e/harness/scenario-harness.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): scaffold scenario harness with env lifecycle and output parsing

Adds the foundational pieces of the in-process e2e harness: snapshotEnv
returns a restore function that reverts adds, modifies, and deletes to
process.env across a helper invocation; resetCoreState clears
process.exitCode and asserts as a tripwire that no router helper has
started using core.saveState / core.exportVariable; parseGithubOutput
parses the @actions/core delimited output file format so the harness
can read each helper's setOutput results without depending on @actions/
core's unexported internals. All three pieces are TDD'd in
scenario-harness.test.ts.
EOF
)"
```

---

### Task 6: Add agent stub queue and event fixture loader

Maps to commit 6: `test(e2e): add agent stub queue and event fixture loader`.

**Files:**
- Create: `router/test/e2e/harness/agent-stub.ts`
- Create: `router/test/e2e/harness/fixtures.ts`
- Modify: `router/test/e2e/harness/scenario-harness.test.ts` (append)

- [ ] **Step 1: TDD agent stub queue**

```ts
import { AgentStub } from "./agent-stub";

describe("AgentStub", () => {
  test("FIFO per non-review stage", () => {
    const stub = new AgentStub();
    stub.queue("triage", { decision_json: '{"a":1}' });
    stub.queue("triage", { decision_json: '{"a":2}' });
    expect(stub.consume("triage").decision_json).toBe('{"a":1}');
    expect(stub.consume("triage").decision_json).toBe('{"a":2}');
  });
  test("review bundle returns a per-role record", () => {
    const stub = new AgentStub();
    stub.queueReview({
      compliance: { output: "c" },
      bugs: { output: "b" },
      security: { output: "s" },
      smells: { output: "sm" },
    });
    const bundle = stub.consumeReview();
    expect(bundle.compliance).toEqual({ output: "c" });
    expect(bundle.bugs).toEqual({ output: "b" });
    expect(bundle.security).toEqual({ output: "s" });
    expect(bundle.smells).toEqual({ output: "sm" });
  });
  test("consume throws with a clear message when queue empty", () => {
    const stub = new AgentStub();
    expect(() => stub.consume("triage")).toThrow(
      /no queued agent response for stage 'triage'/,
    );
  });
  test("consumeReview throws naming missing roles", () => {
    const stub = new AgentStub();
    expect(() => stub.consumeReview()).toThrow(/no queued review bundle/);
  });
});
```

Run, confirm fail. Implement:

```ts
// router/test/e2e/harness/agent-stub.ts

export type StageName =
  | "triage"
  | "spec"
  | "plan"
  | "implement"
  | "review"
  | "handle-merge";

export type NonReviewStage = Exclude<StageName, "review">;

export interface AgentResponse {
  /** Maps directly to the `INPUT_*` env var names the next helper reads. */
  [key: string]: string;
}

export type AgentRole = "compliance" | "bugs" | "security" | "smells";

interface ReviewerOk {
  output: string;
  failed?: false;
}

interface ReviewerFailed {
  failed: true;
  reason: string;
}

export type ReviewerResponse = ReviewerOk | ReviewerFailed;

export type ReviewAgentBundle = Record<AgentRole, ReviewerResponse>;

export class AgentStub {
  private byStage: Map<NonReviewStage, AgentResponse[]> = new Map();
  private reviewBundles: ReviewAgentBundle[] = [];

  queue(stage: NonReviewStage, response: AgentResponse): void {
    if (!this.byStage.has(stage)) this.byStage.set(stage, []);
    this.byStage.get(stage)!.push(response);
  }

  queueReview(bundle: ReviewAgentBundle): void {
    this.reviewBundles.push(bundle);
  }

  consume(stage: NonReviewStage): AgentResponse {
    const q = this.byStage.get(stage);
    if (!q || q.length === 0) {
      throw new Error(
        `AgentStub: no queued agent response for stage '${stage}'. Did the scenario forget harness.queueAgent('${stage}', ...) before runStage?`,
      );
    }
    return q.shift()!;
  }

  consumeReview(): ReviewAgentBundle {
    const b = this.reviewBundles.shift();
    if (!b) {
      throw new Error(
        "AgentStub: no queued review bundle. Did the scenario forget harness.queueReviewAgents(...) before runStage('review')?",
      );
    }
    return b;
  }

  /** Returns counts for all stages that still have queued responses. */
  remainingSummary(): string {
    const parts: string[] = [];
    for (const [stage, q] of this.byStage.entries()) {
      if (q.length > 0) parts.push(`${stage}:${q.length}`);
    }
    if (this.reviewBundles.length > 0) {
      parts.push(`review:${this.reviewBundles.length}`);
    }
    return parts.length === 0 ? "(empty)" : parts.join(", ");
  }
}
```

Run, confirm PASS.

- [ ] **Step 2: TDD `loadEvent`**

```ts
import { loadEvent } from "./fixtures";

describe("loadEvent", () => {
  test("loads issue-labeled-trigger and applies issueNumber override", () => {
    const ev = loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 99 });
    expect(ev.eventName).toBe("issues");
    expect((ev.payload as { issue: { number: number } }).issue.number).toBe(99);
  });
  test("attaches event name based on payload shape", () => {
    const ev = loadEvent("pr-review-approved.json");
    expect(ev.eventName).toBe("pull_request_review");
  });
});
```

Run, confirm fail. Implement:

```ts
// router/test/e2e/harness/fixtures.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GitHubEvent {
  eventName: string;
  payload: unknown;
}

export interface LoadEventOverrides {
  issueNumber?: number;
  prNumber?: number;
  sha?: string;
}

const FIXTURE_ROOT = join(__dirname, "..", "..", "fixtures", "events");

function inferEventName(payload: any): string {
  if (payload.review !== undefined && payload.pull_request !== undefined) {
    return "pull_request_review";
  }
  if (payload.pull_request !== undefined) return "pull_request";
  if (payload.issue !== undefined) return "issues";
  throw new Error(
    `loadEvent: cannot infer event name from payload keys: ${Object.keys(payload).join(",")}`,
  );
}

function patchOverrides(payload: any, ov: LoadEventOverrides | undefined): any {
  if (!ov) return payload;
  const next = JSON.parse(JSON.stringify(payload));
  if (ov.issueNumber !== undefined) {
    if (next.issue) next.issue.number = ov.issueNumber;
    if (next.pull_request) next.pull_request.number = ov.issueNumber;
  }
  if (ov.prNumber !== undefined) {
    if (next.pull_request) next.pull_request.number = ov.prNumber;
  }
  if (ov.sha !== undefined) {
    if (next.pull_request) {
      next.pull_request.head = { ...(next.pull_request.head ?? {}), sha: ov.sha };
    }
  }
  return next;
}

export function loadEvent(
  fixtureName: string,
  overrides?: LoadEventOverrides,
): GitHubEvent {
  const raw = readFileSync(join(FIXTURE_ROOT, fixtureName), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const patched = patchOverrides(parsed, overrides);
  return { eventName: inferEventName(patched), payload: patched };
}
```

Run, confirm PASS.

> **Heads up on `__dirname`:** vitest can run in ESM mode where `__dirname` is undefined. If the test fails with `__dirname is not defined`, switch the resolution to `fileURLToPath(new URL("../../fixtures/events/", import.meta.url))`. Do this immediately rather than burning time debugging — it is a known footgun, not a logic error.

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add router/test/e2e/harness/agent-stub.ts router/test/e2e/harness/fixtures.ts router/test/e2e/harness/scenario-harness.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): add agent stub queue and event fixture loader

AgentStub holds a per-stage FIFO of typed agent responses (the strings
the next helper reads via getInput) plus a per-iteration queue of
ReviewAgentBundles for the four-reviewer fan-out (compliance, bugs,
security, smells). Forgetting to queue throws with a message that names
the missing stage or roles, so wiring bugs surface as actionable
errors rather than undefined inputs.

loadEvent reads from router/test/fixtures/events/, applies in-memory
issue/pr/sha overrides, and infers the event name from the payload
shape so scenarios do not have to hard-code it.
EOF
)"
```

---

### Task 7: Hand-script job graph and runStage dispatch

Maps to commit 7: `test(e2e): hand-script job graph and runStage dispatch`.

**Files:**
- Create: `router/test/e2e/harness/job-graph.ts`
- Create: `router/test/e2e/harness/scenario-harness.ts`
- Modify: `router/test/e2e/harness/scenario-harness.test.ts` (append)

This is the heaviest single task. The job graph mirrors `.github/workflows/shopfloor.yml` step-by-step. Read each stage block in the YAML before encoding it. The eight stages with `id: ctx` shell steps are at lines 232 (triage), 367 (spec), 532 (plan), 831 (implement first-run), 889 (implement revision via `id: ctx_revision`), 1135 (review-compliance), 1231 (review-bugs), 1327 (review-security), 1423 (review-smells).

- [ ] **Step 1: Create the typed job-graph types**

```ts
// router/test/e2e/harness/job-graph.ts

import type { FakeGitHub } from "../fake-github";
import type { StageName, AgentRole } from "./agent-stub";

export type HelperName =
  | "route"
  | "bootstrap-labels"
  | "open-stage-pr"
  | "advance-state"
  | "report-failure"
  | "handle-merge"
  | "create-progress-comment"
  | "finalize-progress-comment"
  | "check-review-skip"
  | "aggregate-review"
  | "render-prompt"
  | "apply-triage-decision"
  | "apply-impl-postwork"
  | "precheck-stage"
  | "build-revision-context";

export type InputSource =
  | { source: "literal"; value: string }
  | { source: "route"; key: string }
  | { source: "agent"; key: string }
  | { source: "agent-role"; role: AgentRole; key: string }
  | { source: "previous"; helper: HelperName | string; key: string }
  | { source: "fake"; resolve: (ctx: StageContext) => string };

export type InputMap = Record<string, InputSource>;

export interface StageContext {
  fake: FakeGitHub;
  routeOutputs: Record<string, string>;
  previous: Record<string, Record<string, string>>;
  workspaceDir: string;
  /**
   * The most recent event delivered via harness.deliverEvent. Used by
   * input resolvers that need event-payload data (e.g. handle-merge's
   * pr_number, which the workflow pulls from
   * github.event.pull_request.number, not from a route output).
   */
  currentEvent: { eventName: string; payload: unknown } | null;
}

export interface ContextArtifact {
  /** Written to `${workspaceDir}/<id>.json`; the path is exposed as `previous[id].path`. */
  json: unknown;
}

export type GraphStep =
  | { kind: "helper"; id?: string; helper: HelperName; from: InputMap }
  | { kind: "agent"; stage: StageName }
  | { kind: "context"; id: string; build: (ctx: StageContext) => ContextArtifact }
  | { kind: "if"; when: (ctx: StageContext) => boolean; then: GraphStep[] };

export type StageKey =
  | "triage"
  | "spec"
  | "plan"
  | "implement-first-run"
  | "implement-revision"
  | "review"
  | "handle-merge";

export const jobGraph: Record<StageKey, GraphStep[]> = {
  // Filled in below, one stage at a time.
  triage: [],
  spec: [],
  plan: [],
  "implement-first-run": [],
  "implement-revision": [],
  review: [],
  "handle-merge": [],
};
```

- [ ] **Step 2: Encode the triage stage**

Read `.github/workflows/shopfloor.yml:172-303` to get the exact step order. Translate:

```ts
jobGraph.triage = [
  // shopfloor.yml line ~221: "Mark triage as running"
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:triaging" },
    },
  },
  // line ~230: "Build triage context" — gh api shells out, fake substitutes
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: ctx.fake
            .commentsOn(issueNumber)
            .map((c) => `**@${c.author}**:\n${c.body}`)
            .join("\n\n---\n\n"),
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
        },
      };
    },
  },
  // line ~255: "Render triage prompt"
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/triage.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: { source: "literal", value: "Read,Glob,Grep" },
    },
  },
  // line ~265: claude-code-action — replaced by the agent stub
  { kind: "agent", stage: "triage" },
  // line ~286: "Apply triage decision"
  {
    kind: "helper",
    helper: "apply-triage-decision",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      decision_json: { source: "agent", key: "decision_json" },
    },
  },
];
```

- [ ] **Step 3: Encode the spec stage**

Read `.github/workflows/shopfloor.yml:330-460` (the spec job). Translate similarly. Key inputs to `open-stage-pr`: `issue_number`, `stage=spec`, `branch_name`, `base_branch`, `pr_title`, `pr_body`. Keep `pr_title`/`pr_body` as literal placeholders that the spec scenario can override; the agent's structured output is what fills them in production but the harness pulls from the queued agent response.

Reference: the implement stage YAML for the parallel pattern.

- [ ] **Step 4: Encode the plan stage**

Read `shopfloor.yml:495-650` and translate. Same shape as spec but with stage=plan.

- [ ] **Step 5: Encode `implement-first-run`**

Read `shopfloor.yml:670-1056`. The first-run path:
1. `precheck-stage` (stage=implement)
2. `advance-state` (to=`shopfloor:implementing`)
3. (workflow shell: `git checkout -b` — no-op in fake)
4. `open-stage-pr` (stage=implement, draft=true)
5. `create-progress-comment`
6. context build (the `id: ctx` jq block) — the build callback writes the context file via the fake's data; `spec_file_path`/`plan_file_path` are read from disk via `harness.seedFile`
7. `render-prompt`
8. agent
9. (workflow: `git push` — no-op in fake)
10. `finalize-progress-comment`
11. `apply-impl-postwork`

```ts
jobGraph["implement-first-run"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "implement" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:implementing" },
    },
  },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "implement" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "literal", value: "wip: impl" },
      pr_body: { source: "literal", value: "Shopfloor is implementing." },
      draft: { source: "literal", value: "true" },
    },
  },
  {
    kind: "helper",
    id: "progress",
    helper: "create-progress-comment",
    from: { pr_number: { source: "previous", helper: "open_pr", key: "pr_number" } },
  },
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      // Mirrors the inline jq build at shopfloor.yml lines 829-882. Reads
      // the seeded spec and plan files from disk so scenarios that
      // assert a round-trip on plan/spec content actually exercise the
      // same read path the production workflow uses. Resolves the paths
      // against ctx.workspaceDir if they are not already absolute, since
      // harness.seedFile writes under workspaceDir.
      const fs = require("node:fs");
      const path = require("node:path");
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      const resolveSeeded = (p: string | undefined): string | null => {
        if (!p) return null;
        const abs = path.isAbsolute(p) ? p : path.join(ctx.workspaceDir, p);
        return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
      };
      const specBody = resolveSeeded(ctx.routeOutputs.spec_file_path);
      const planBody = resolveSeeded(ctx.routeOutputs.plan_file_path) ?? "";
      const specSource =
        specBody !== null
          ? `<spec_file_contents>\n${specBody}\n</spec_file_contents>`
          : `<spec_source>\nThere is no spec for this issue. This is the medium-complexity flow, which skips the spec stage by design. The <plan_file_contents> below is your sole source of truth for the design.\n</spec_source>`;
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: "",
          spec_source: specSource,
          plan_file_contents: planBody,
          branch_name: ctx.routeOutputs.branch_name,
          progress_comment_id: ctx.previous.progress?.comment_id ?? "",
          revision_block: "",
          bash_allowlist: "pnpm test:*",
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
        },
      };
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/implement.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: { source: "literal", value: "Read,Edit,Write" },
    },
  },
  { kind: "agent", stage: "implement" },
  {
    kind: "helper",
    helper: "finalize-progress-comment",
    from: {
      comment_id: { source: "previous", helper: "progress", key: "comment_id" },
      terminal_state: { source: "literal", value: "success" },
      final_body: { source: "agent", key: "summary_for_issue_comment" },
    },
  },
  {
    kind: "helper",
    helper: "apply-impl-postwork",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "previous", helper: "open_pr", key: "pr_number" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
      has_review_app: { source: "literal", value: "true" },
    },
  },
];
```

- [ ] **Step 6: Encode `implement-revision`**

Read `shopfloor.yml:711-1056` again, this time focusing on the `revision_mode == 'true'` branches. The revision path:
1. `precheck-stage`
2. `advance-state`
3. (workflow: `git fetch` — no-op)
4. (no `open-stage-pr` — uses `route.outputs.impl_pr_number`)
5. `create-progress-comment` against the existing PR
6. `build-revision-context` (NOT inline jq) — this is the router helper
7. `render-prompt`
8. agent
9. `finalize-progress-comment`
10. `apply-impl-postwork`

```ts
jobGraph["implement-revision"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "implement" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:implementing" },
    },
  },
  {
    kind: "helper",
    id: "progress",
    helper: "create-progress-comment",
    from: { pr_number: { source: "route", key: "impl_pr_number" } },
  },
  {
    kind: "helper",
    id: "ctx_revision",
    helper: "build-revision-context",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      branch_name: { source: "route", key: "branch_name" },
      spec_file_path: { source: "route", key: "spec_file_path" },
      plan_file_path: { source: "route", key: "plan_file_path" },
      progress_comment_id: { source: "previous", helper: "progress", key: "comment_id" },
      bash_allowlist: { source: "literal", value: "pnpm test:*" },
      repo_owner: { source: "fake", resolve: (ctx) => ctx.fake.owner },
      repo_name: { source: "fake", resolve: (ctx) => ctx.fake.repo },
      output_path: { source: "fake", resolve: (ctx) => `${ctx.workspaceDir}/context.json` },
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/implement.md" },
      context_file: { source: "previous", helper: "ctx_revision", key: "path" },
      base_allowed_tools: { source: "literal", value: "Read,Edit,Write" },
    },
  },
  { kind: "agent", stage: "implement" },
  {
    kind: "helper",
    helper: "finalize-progress-comment",
    from: {
      comment_id: { source: "previous", helper: "progress", key: "comment_id" },
      terminal_state: { source: "literal", value: "success" },
      final_body: { source: "agent", key: "summary_for_issue_comment" },
    },
  },
  {
    kind: "helper",
    helper: "apply-impl-postwork",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
      has_review_app: { source: "literal", value: "true" },
    },
  },
];
```

> **Note:** `build-revision-context` writes its context file to `output_path` and emits `path=output_path` via `setOutput`. The graph uses `helper: "ctx_revision"` as the previous-step key, matching the workflow's `id: ctx_revision`.

- [ ] **Step 7: Encode the review stage**

Read `shopfloor.yml:1058-1576`. The review stage runs four parallel reviewer agents whose outputs feed `aggregate-review`. The graph is:
1. `check-review-skip` (sets `skip` output)
2. Four parallel agent dispatches (modeled as a single `kind: "agent"; stage: "review"` step that the harness expands into the four-role bundle)
3. `precheck-stage` (stage=review-aggregator)
4. `aggregate-review`

```ts
jobGraph.review = [
  {
    kind: "helper",
    id: "skip",
    helper: "check-review-skip",
    from: { pr_number: { source: "route", key: "impl_pr_number" } },
  },
  { kind: "agent", stage: "review" },
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "review-aggregator" },
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      analysed_sha: {
        source: "fake",
        resolve: (ctx) => ctx.fake.pr(Number(ctx.routeOutputs.impl_pr_number)).head.sha,
      },
    },
  },
  {
    kind: "helper",
    helper: "aggregate-review",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      confidence_threshold: { source: "literal", value: "80" },
      max_iterations: { source: "literal", value: "3" },
      compliance_output: { source: "agent-role", role: "compliance", key: "output" },
      bugs_output: { source: "agent-role", role: "bugs", key: "output" },
      security_output: { source: "agent-role", role: "security", key: "output" },
      smells_output: { source: "agent-role", role: "smells", key: "output" },
      analysed_sha: {
        source: "fake",
        resolve: (ctx) => ctx.fake.pr(Number(ctx.routeOutputs.impl_pr_number)).head.sha,
      },
    },
  },
];
```

- [ ] **Step 8: Encode the handle-merge stage**

Read `shopfloor.yml:1577-1629`. Simple:

```ts
// The route helper emits `reason: "pr_merged_<stage>_triggered_label_flip"`,
// but precheck-stage and handle-merge both want the bare stage name
// (`spec` | `plan` | `implement`). The real workflow has a `parse_merged_
// stage` shell step (shopfloor.yml lines 1594-1599) that strips the
// `pr_merged_` prefix and `_triggered_label_flip` suffix. We reproduce
// that transform inside the input resolver via the `fake` source kind,
// which is the harness's general-purpose computed-input escape hatch.
//
// Likewise, pr_number is NOT in the route outputs for a merged spec or
// plan PR — `resolvePullRequestEvent` only sets `reason` and `issueNumber`
// on the merged-PR branch. The workflow pulls the PR number from
// github.event.pull_request.number. We pull it from currentEvent.payload.
function parseMergedStage(routeReason: string): string {
  return routeReason
    .replace(/^pr_merged_/, "")
    .replace(/_triggered_label_flip$/, "");
}

function eventPrNumber(ctx: StageContext): string {
  const ev = ctx.currentEvent?.payload as
    | { pull_request?: { number?: number } }
    | undefined;
  const n = ev?.pull_request?.number;
  if (n === undefined) {
    throw new Error(
      "handle-merge graph step: currentEvent has no pull_request.number; deliver a PR-closed event before runStage('handle-merge').",
    );
  }
  return String(n);
}

jobGraph["handle-merge"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "handle-merge" },
      issue_number: { source: "route", key: "issue_number" },
      merged_stage: {
        source: "fake",
        resolve: (ctx) => parseMergedStage(ctx.routeOutputs.reason ?? ""),
      },
    },
  },
  {
    kind: "helper",
    helper: "handle-merge",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      merged_stage: {
        source: "fake",
        resolve: (ctx) => parseMergedStage(ctx.routeOutputs.reason ?? ""),
      },
      pr_number: { source: "fake", resolve: eventPrNumber },
    },
  },
];
```

- [ ] **Step 9: Now create `scenario-harness.ts`**

```ts
// router/test/e2e/harness/scenario-harness.ts
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import * as tmp from "tmp";
import { vi } from "vitest";
import { getOctokit } from "@actions/github";
import { main } from "../../../src/index";
import { runBootstrapLabels } from "../../../src/helpers/bootstrap-labels";
import { GitHubAdapter } from "../../../src/github";
import type { OctokitLike } from "../../../src/types";
import { FakeGitHub } from "../fake-github";
import { snapshotEnv, resetCoreState } from "./env";
import { parseGithubOutput } from "./parse-output";
import { AgentStub, type NonReviewStage, type AgentResponse, type ReviewAgentBundle } from "./agent-stub";
import {
  jobGraph,
  type GraphStep,
  type InputMap,
  type StageContext,
  type StageKey,
} from "./job-graph";
import type { GitHubEvent } from "./fixtures";

const PRIMARY_TOKEN = "primary-token";
const REVIEW_TOKEN = "review-token";

export class ScenarioHarness {
  readonly fake: FakeGitHub;
  readonly workspaceDir: string;
  private readonly tmpHandle: tmp.DirResult;
  private readonly stub = new AgentStub();
  private currentEvent: GitHubEvent | null = null;
  private routeOutputs: Record<string, string> = {};
  private seq = 0;

  constructor(opts: { fake: FakeGitHub; workspaceDir?: string }) {
    this.fake = opts.fake;
    if (opts.workspaceDir) {
      this.workspaceDir = opts.workspaceDir;
      this.tmpHandle = { name: opts.workspaceDir, removeCallback: () => {} } as never;
    } else {
      this.tmpHandle = tmp.dirSync({ unsafeCleanup: true });
      this.workspaceDir = this.tmpHandle.name;
    }
    // Register this fake in the global @actions/github mock so getOctokit
    // routes here for both tokens.
    registerFake(this.fake);
  }

  async bootstrap(): Promise<void> {
    const adapter = new GitHubAdapter(
      this.fake.asOctokit(this.fake.primaryIdentity),
      { owner: this.fake.owner, repo: this.fake.repo },
    );
    await runBootstrapLabels(adapter);
  }

  async deliverEvent(event: GitHubEvent): Promise<Record<string, string>> {
    this.currentEvent = event;
    const outputs = await this.invokeHelper("route", {});
    this.routeOutputs = outputs;
    return outputs;
  }

  async runStage(stage: StageKey | "implement"): Promise<void> {
    const key: StageKey =
      stage === "implement"
        ? this.routeOutputs.revision_mode === "true"
          ? "implement-revision"
          : "implement-first-run"
        : stage;
    const steps = jobGraph[key];
    if (!steps || steps.length === 0) {
      throw new Error(`runStage: no graph for '${key}'`);
    }
    const previous: Record<string, Record<string, string>> = {};
    for (let idx = 0; idx < steps.length; idx++) {
      try {
        await this.runStep(steps[idx], previous);
      } catch (err) {
        throw new ScenarioStepError(key, idx, steps[idx], err, this.fake);
      }
    }
  }

  private async runStep(
    step: GraphStep,
    previous: Record<string, Record<string, string>>,
  ): Promise<void> {
    if (step.kind === "if") {
      const ctx = this.makeStageContext(previous);
      if (step.when(ctx)) {
        for (const inner of step.then) await this.runStep(inner, previous);
      }
      return;
    }
    if (step.kind === "context") {
      const ctx = this.makeStageContext(previous);
      const artifact = step.build(ctx);
      const file = join(this.workspaceDir, `${step.id}.json`);
      writeFileSync(file, JSON.stringify(artifact.json));
      previous[step.id] = { path: file };
      return;
    }
    if (step.kind === "agent") {
      // Agent steps don't invoke main(); they consume from the stub queue
      // and stash the response under the conventional id `agent` so
      // downstream `from: { source: "agent", ... }` sources resolve.
      if (step.stage === "review") {
        const bundle = this.stub.consumeReview();
        previous.agent_review = serializeReviewBundle(bundle);
      } else {
        const response = this.stub.consume(step.stage as NonReviewStage);
        previous.agent = { ...response };
      }
      return;
    }
    // helper
    const inputs = this.resolveInputs(step.from, previous);
    const outputs = await this.invokeHelper(step.helper, inputs);
    if (step.id) previous[step.id] = outputs;
    previous[step.helper] = outputs;
  }

  private resolveInputs(
    map: InputMap,
    previous: Record<string, Record<string, string>>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const ctx = this.makeStageContext(previous);
    for (const [k, src] of Object.entries(map)) {
      switch (src.source) {
        case "literal":
          out[k] = src.value;
          break;
        case "route":
          out[k] = this.routeOutputs[src.key] ?? "";
          break;
        case "agent":
          out[k] = previous.agent?.[src.key] ?? "";
          break;
        case "agent-role":
          out[k] = previous.agent_review?.[src.role] ?? "";
          break;
        case "previous":
          out[k] = previous[src.helper]?.[src.key] ?? "";
          break;
        case "fake":
          out[k] = src.resolve(ctx);
          break;
      }
    }
    return out;
  }

  private makeStageContext(
    previous: Record<string, Record<string, string>>,
  ): StageContext {
    return {
      fake: this.fake,
      routeOutputs: this.routeOutputs,
      previous,
      workspaceDir: this.workspaceDir,
      currentEvent: this.currentEvent,
    };
  }

  async invokeHelper(
    helper: string,
    inputs: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (!this.currentEvent) {
      throw new Error("invokeHelper: no event delivered yet — call deliverEvent first");
    }
    const restoreEnv = snapshotEnv();
    const seq = ++this.seq;
    const eventFile = join(this.workspaceDir, `event-${seq}.json`);
    const outputFile = join(this.workspaceDir, `output-${seq}.txt`);
    writeFileSync(eventFile, JSON.stringify(this.currentEvent.payload));
    writeFileSync(outputFile, "");
    process.env.INPUT_HELPER = helper;
    process.env.INPUT_GITHUB_TOKEN = PRIMARY_TOKEN;
    if (helper === "aggregate-review") {
      process.env.INPUT_REVIEW_GITHUB_TOKEN = REVIEW_TOKEN;
    }
    for (const [k, v] of Object.entries(inputs)) {
      process.env[`INPUT_${k.toUpperCase()}`] = v;
    }
    process.env.GITHUB_EVENT_PATH = eventFile;
    process.env.GITHUB_EVENT_NAME = this.currentEvent.eventName;
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_REPOSITORY = `${this.fake.owner}/${this.fake.repo}`;
    process.env.RUNNER_TEMP = this.workspaceDir;
    resetCoreState();
    try {
      await main();
      if (process.exitCode && process.exitCode !== 0) {
        throw new Error(
          `helper '${helper}' set exitCode ${process.exitCode}; check core.setFailed messages`,
        );
      }
      return parseGithubOutput(readFileSync(outputFile, "utf-8"));
    } finally {
      restoreEnv();
    }
  }

  // ── Public sugar ─────────────────────────────────────────────────
  queueAgent(stage: NonReviewStage, response: AgentResponse): void {
    this.stub.queue(stage, response);
  }
  queueReviewAgents(bundle: ReviewAgentBundle): void {
    this.stub.queueReview(bundle);
  }
  seedFile(relativePath: string, contents: string): void {
    const abs = join(this.workspaceDir, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  async dispose(): Promise<void> {
    unregisterFake(this.fake);
    this.tmpHandle.removeCallback();
  }
}

function serializeReviewBundle(bundle: ReviewAgentBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ["compliance", "bugs", "security", "smells"] as const) {
    const r = bundle[role];
    out[role] = "failed" in r && r.failed ? "" : r.output;
  }
  return out;
}

class ScenarioStepError extends Error {
  constructor(
    stage: string,
    stepIndex: number,
    step: GraphStep,
    inner: unknown,
    fake: FakeGitHub,
  ) {
    const helperName =
      step.kind === "helper"
        ? step.helper
        : step.kind === "context"
          ? `context:${step.id}`
          : step.kind === "agent"
            ? `agent:${step.stage}`
            : "if";
    const msg = inner instanceof Error ? inner.message : String(inner);
    super(
      `ScenarioStepError: stage=${stage} step=${stepIndex} kind=${step.kind} ref=${helperName}\n  Helper threw: ${msg}\n\n  GitHub state at time of failure:\n${fake.eventLogSummary()}\n`,
    );
    this.name = "ScenarioStepError";
  }
}

// ── Global mock plumbing ─────────────────────────────────────────────
const fakeRegistry = new Map<string, FakeGitHub>();
function registerFake(fake: FakeGitHub) {
  fakeRegistry.set(`${fake.owner}/${fake.repo}`, fake);
}
function unregisterFake(fake: FakeGitHub) {
  fakeRegistry.delete(`${fake.owner}/${fake.repo}`);
}

vi.mocked(getOctokit).mockImplementation((token: string) => {
  // The harness only ever runs one fake at a time per file, so first()
  // is sufficient. If we ever support concurrent fakes, this resolver
  // must inspect process.env.GITHUB_REPOSITORY.
  const fake = Array.from(fakeRegistry.values())[0];
  if (!fake) {
    throw new Error("getOctokit called without a registered FakeGitHub");
  }
  if (token === REVIEW_TOKEN) {
    const reviewer = fake.reviewIdentity;
    if (!reviewer) {
      throw new Error(
        "getOctokit: REVIEW_TOKEN was used but the fake has no reviewAuthIdentity. Pass it in the FakeGitHub constructor.",
      );
    }
    return fake.asOctokit(reviewer) as never;
  }
  return fake.asOctokit(fake.primaryIdentity) as never;
});
```

> **Important:** The `vi.mocked(getOctokit).mockImplementation(...)` call requires `vi.mock("@actions/github", ...)` to have already been declared, which happens in `setup.ts` (Task 8). For Task 7's standalone tests we will use a temporary inline `vi.mock` call inside the harness self-test file until Task 8 promotes it to the global setup.

- [ ] **Step 10: Add a smoke test for `runStage("triage")`**

Append to `scenario-harness.test.ts`:

```ts
import { vi as vitest } from "vitest";

vitest.mock("@actions/github", async () => {
  const actual = await vitest.importActual<typeof import("@actions/github")>("@actions/github");
  return {
    ...actual,
    getOctokit: vitest.fn(),
    context: {
      get eventName() { return process.env.GITHUB_EVENT_NAME ?? ""; },
      get payload() {
        const p = process.env.GITHUB_EVENT_PATH;
        return p ? JSON.parse(require("fs").readFileSync(p, "utf8")) : {};
      },
      repo: {
        get owner() { return process.env.GITHUB_REPOSITORY?.split("/")[0] ?? ""; },
        get repo() { return process.env.GITHUB_REPOSITORY?.split("/")[1] ?? ""; },
      },
    },
  };
});

import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "./scenario-harness";
import { loadEvent } from "./fixtures";

describe("ScenarioHarness end-to-end smoke", () => {
  test("triage stage runs without throwing on a freshly seeded issue", async () => {
    const fake = new FakeGitHub({
      owner: "acme", repo: "widgets",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    const harness = new ScenarioHarness({ fake });
    try {
      await harness.bootstrap();
      fake.seedBranch("main", "sha-main-0");
      fake.seedIssue({ number: 42, title: "Add foo", body: "Need foo", author: "alice" });
      await harness.deliverEvent(
        loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      );
      harness.queueAgent("triage", {
        decision_json: JSON.stringify({
          status: "classified",
          complexity: "quick",
          rationale: "small",
          clarifying_questions: [],
        }),
      });
      await harness.runStage("triage");
      expect(fake.labelsOn(42)).toContain("shopfloor:quick");
      expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");
    } finally {
      await harness.dispose();
    }
  });
});
```

- [ ] **Step 11: Add `tmp` to devDependencies (so the harness compiles)**

```bash
pnpm -w add -D tmp@^0.2.3 @types/tmp@^0.2.6
```

Run the smoke test: `pnpm test router/test/e2e/harness/scenario-harness.test.ts`
Expected: green. If not, the most likely failure modes are (a) `getOctokit` returning the wrong shim because of token resolution, (b) `RUNNER_TEMP` not set, (c) `route` not finding the trigger label in the fixture. Debug using `fake.eventLogSummary()` printed inside the catch.

- [ ] **Step 12: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add router/test/e2e/harness/job-graph.ts router/test/e2e/harness/scenario-harness.ts router/test/e2e/harness/scenario-harness.test.ts package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
test(e2e): hand-script job graph and runStage dispatch

Adds the hand-maintained job graph that mirrors .github/workflows/
shopfloor.yml step-by-step for every stage. Each stage encodes its
helper invocations, the inline 'context' shell steps that build the
context.json file, and the agent dispatch (one per stage, four-way
fan-out for review). The implement stage forks into implement-first-run
and implement-revision keyed by the route helper's revision_mode
output; runStage('implement') picks the right branch automatically.

ScenarioHarness owns the env lifecycle, walks the graph, and wraps
every helper invocation with ScenarioStepError that dumps the fake's
eventLogSummary() so failing scenarios point at the offending step
without manual print-debugging.

Adds tmp + @types/tmp as devDependencies for workspace temp dir
management. A smoke test drives runStage('triage') against a freshly
seeded issue end-to-end.
EOF
)"
```

---

### Task 8: Wire `@actions/github` mock via vitest setup file

Maps to commit 8: `test(e2e): wire @actions/github mock via vitest setup file`.

**Files:**
- Create: `router/test/e2e/setup.ts`
- Modify: `vitest.config.ts`
- Modify: `router/test/e2e/harness/scenario-harness.test.ts` (remove the inline `vi.mock` from Task 7)

This commit promotes the inline `vi.mock("@actions/github", ...)` from Task 7's harness test file to a global setup file so every scenario file picks it up automatically.

- [ ] **Step 1: Create `router/test/e2e/setup.ts`**

```ts
// router/test/e2e/setup.ts
import { vi } from "vitest";
import { readFileSync } from "node:fs";

// Global mock of @actions/github. Each scenario registers a FakeGitHub
// via ScenarioHarness; getOctokit reads from that registry. Tests that
// don't register a fake will hit the throw-on-unknown branch, surfacing
// any accidental access at the call site rather than letting it slip
// through with stub data.
vi.mock("@actions/github", async () => {
  const actual = await vi.importActual<typeof import("@actions/github")>("@actions/github");
  return {
    ...actual,
    getOctokit: vi.fn(),
    context: {
      get eventName() {
        return process.env.GITHUB_EVENT_NAME ?? "";
      },
      get payload() {
        const p = process.env.GITHUB_EVENT_PATH;
        return p ? JSON.parse(readFileSync(p, "utf8")) : {};
      },
      repo: {
        get owner() {
          return process.env.GITHUB_REPOSITORY?.split("/")[0] ?? "";
        },
        get repo() {
          return process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
        },
      },
    },
  };
});

// Tripwire: scenario files MUST NOT use test.concurrent. With shared
// process.env it would trample. Detect any leakage of INPUT_* env vars
// into test setup and throw loudly.
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_")) {
      throw new Error(
        `e2e setup: stale ${k} present at start of test. Did a previous test fail to dispose its harness, or are you running with test.concurrent (forbidden in e2e/scenarios)?`,
      );
    }
  }
});
```

- [ ] **Step 2: Modify `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "router/test/**/*.test.ts",
      "mcp-servers/**/test/**/*.test.ts",
      "test/e2e/**/*.test.ts",
    ],
    setupFiles: ["router/test/e2e/setup.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["router/src/**", "mcp-servers/shopfloor-mcp/index.ts"],
      exclude: ["**/test/**"],
    },
  },
});
```

- [ ] **Step 3: Remove the inline mock from `scenario-harness.test.ts`**

Delete the `vitest.mock("@actions/github", ...)` block at the top of `router/test/e2e/harness/scenario-harness.test.ts` that Task 7 added; the global setup now provides it.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: every existing test still green, plus all the e2e/fake-github + e2e/harness tests.

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add router/test/e2e/setup.ts vitest.config.ts router/test/e2e/harness/scenario-harness.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): wire @actions/github mock via vitest setup file

Promotes the @actions/github mock from a per-file vitest.mock to a
vitest setupFile so every scenario file (and the harness self-test)
gets the same getOctokit + context resolver. The mock reads tokens out
of the per-test FakeGitHub registry that ScenarioHarness manages.

setup.ts also adds a beforeEach tripwire that throws if any INPUT_* env
var is set at the start of a test, catching leaks from a previous
helper invocation that forgot to call snapshotEnv's restore (or from
running scenarios with test.concurrent, which is forbidden because
process.env is process-global).
EOF
)"
```

---

## Phase 3: Scenarios

Each scenario file is its own commit. The pattern is identical:

1. Write the scenario test (it will fail because the harness or fake is missing some capability).
2. Run it. If it fails because of a missing harness capability, slot in a `test(e2e): extend harness for X` commit between scenarios.
3. Once green, snapshot, run the full suite, commit.

Each scenario should run in **under 100ms**. Whole suite should add **<1s** to `pnpm test`.

### Task 9: Scenario — quick happy path

Maps to commit 9: `test(e2e): scenario - quick happy path`.

**Files:**
- Create: `router/test/e2e/scenarios/quick-happy-path.test.ts`

The simplest possible end-to-end. If this breaks, everything is on fire. Path: triage (quick) → implement → review approved → merge → done. Skips spec, plan.

- [ ] **Step 1: Write the scenario**

```ts
// router/test/e2e/scenarios/quick-happy-path.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("quick happy path", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "acme", repo: "widgets",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({ number: 42, title: "Add foo", body: "Need foo.", author: "alice" });
  });
  afterEach(async () => harness.dispose());

  test("triage -> implement -> review approved -> merge -> done", async () => {
    // 1. Trigger label triggers triage.
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
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

    // 2. needs-impl label triggers implement.
    fake.seedBranch("shopfloor/42-add-foo", "sha-impl-0");
    await harness.deliverEvent(
      loadEvent("issue-labeled-needs-impl.json", { issueNumber: 42 }),
    );
    harness.queueAgent("implement", {
      pr_title: "feat: add foo",
      pr_body: "Implements foo as requested.",
      summary_for_issue_comment: "Done.",
      changed_files: JSON.stringify(["src/foo.ts"]),
    });
    await harness.runStage("implement");
    const implPr = fake.openPrs().find((p) => p.head.ref.startsWith("shopfloor/42"));
    expect(implPr).toBeDefined();
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-review");

    // 3. ready_for_review triggers review.
    await harness.deliverEvent(
      loadEvent("pr-ready-for-review-impl.json", { issueNumber: 42, prNumber: implPr!.number }),
    );
    harness.queueReviewAgents({
      compliance: { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
      bugs:       { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
      security:   { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
      smells:     { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    });
    await harness.runStage("review");
    expect(fake.labelsOn(42)).toContain("shopfloor:review-approved");

    // 4. Merge the impl PR (the production handler closes the issue here).
    fake.mergePr(implPr!.number, "sha-impl-0");
    await harness.deliverEvent(
      loadEvent("pr-closed-merged-spec.json", { issueNumber: 42, prNumber: implPr!.number }),
    );
    await harness.runStage("handle-merge");
    expect(fake.issue(42).state).toBe("closed");
    expect(fake.labelsOn(42)).toContain("shopfloor:done");

    // Final snapshot
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Add the `issue-labeled-needs-impl.json` fixture**

This fixture is **required** and does not exist in `router/test/fixtures/events/` today (verified). Add it as a separate commit before the scenario commit:

```json
{
  "action": "labeled",
  "label": { "name": "shopfloor:needs-impl" },
  "issue": {
    "number": 42,
    "title": "Add foo",
    "body": "Need foo.",
    "labels": [
      { "name": "shopfloor:quick" },
      { "name": "shopfloor:needs-impl" }
    ],
    "state": "open",
    "pull_request": null
  },
  "repository": {
    "owner": { "login": "niranjan94" },
    "name": "shopfloor"
  }
}
```

Commit it standalone:

```bash
git add router/test/fixtures/events/issue-labeled-needs-impl.json
git commit -m "test(e2e): add issue-labeled-needs-impl fixture for scenario harness"
```

- [ ] **Step 3: Run, identify other missing capabilities**

Run: `pnpm test router/test/e2e/scenarios/quick-happy-path.test.ts`

Likely first failures and what to do about each:
- `route` returning `stage='none'` because the trigger fixture's label name does not match: pass `trigger_label` input to the route helper via a literal in the job graph, or add a `triggerLabel` constructor option to the harness that bakes in `INPUT_TRIGGER_LABEL`.
- Branch slug mismatch: the scenario hard-codes `shopfloor/42-add-foo` but `branchSlug("Add foo")` may produce `shopfloor/42-add-foo` or something different. Check `router/src/state.ts` → `branchSlug`. If it differs, read the actual route output and use `routeOutputs.branch_name` to seed the branch.
- `apply-impl-postwork` checking `shopfloor:implementing` but the implement-first-run path forgets to keep it during the workflow snapshot: re-read `apply-impl-postwork.ts` and fix the order in the job-graph step list.

For each, decide: is this a missing harness capability (extension commit) or a scenario bug (fix in place)? Resolve and re-run.

- [ ] **Step 4: Iterate until green**

Re-run the test after each fix. Target: PASS.

- [ ] **Step 5: Run the whole suite to confirm no regression**

Run: `pnpm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add router/test/e2e/scenarios/quick-happy-path.test.ts router/test/e2e/scenarios/__snapshots__/
# Plus any fixture files added during step 2
git commit -m "$(cat <<'EOF'
test(e2e): scenario - quick happy path

The simplest end-to-end scenario: triage classifies an issue as quick,
implement opens an impl PR with the agent's structured output, the
four-way review fan-out unanimously approves, the PR is merged, and
handle-merge closes the issue with shopfloor:done. Asserts the
persistent shopfloor:quick label survives every transient stage label
flip and the impl PR's PR body contains the Shopfloor metadata block.
EOF
)"
```

---

### Task 10: Scenario — medium happy path

Maps to commit 10. Path: triage (medium) → plan → implement → review approved → merge.

**Files:**
- Create: `router/test/e2e/scenarios/medium-happy-path.test.ts`

- [ ] **Step 1: Write the scenario** following the same shape as Task 9, with these additions:
  - After triage, queue a `plan` agent response with `pr_title`/`pr_body`/`summary_for_issue_comment`/`changed_files`.
  - Run `harness.runStage("plan")`. Assert a plan PR is opened with body `Shopfloor-Stage: plan`.
  - Simulate plan PR review approval by calling the review stage on the plan PR (or fast-forwarding via `fake.mergePr` if the production flow auto-merges via human; check `aggregate-review` for plan). Plan stage PRs go through human review in production, so for the scenario use `fake.mergePr(planPr.number, ...)` then `deliverEvent(pr-closed-merged-spec.json)` and `runStage("handle-merge")` to flip `needs-impl`.
  - Continue with implement, review, merge as in Task 9.
- [ ] **Step 2: Run, fix capability gaps, re-run, commit.**

```bash
git commit -m "test(e2e): scenario - medium happy path"
```

(Use the spec's section "2. medium-happy-path.test.ts" for assertion details: persistent `shopfloor:medium` label, plan PR opens and merges before impl PR opens, impl PR body has `Shopfloor-Stage: implement` and `Shopfloor-Review-Iteration: 0`, no spec stage runs.)

---

### Task 11: Scenario — large happy path with spec

Maps to commit 11.

**Files:**
- Create: `router/test/e2e/scenarios/large-happy-path.test.ts`

- [ ] **Step 1: Write the scenario.** Same shape as Task 10 but with a spec stage in front. Triage classifies as `large`. Run `harness.runStage("spec")` with a queued `spec` agent response. Spec PR opens, gets merged, `handle-merge` flips to `needs-plan`. Then plan, implement, review, merge.
- [ ] **Step 2: Use `harness.seedFile("docs/shopfloor/specs/issue-42-spec.md", "...")`** and the corresponding `plan` file before the implement stage runs, so `build-revision-context` (which is NOT used here, first-run uses inline jq) and the inline `ctx` step can find them. Strictly, only the implement-first-run context build references these via the route output `spec_file_path` and `plan_file_path`. Confirm the route output for a large flow includes those paths.
- [ ] **Step 3: Run, fix, commit.**

```bash
git commit -m "test(e2e): scenario - large happy path with spec"
```

---

### Task 12: Scenario — triage clarification and resume

Maps to commit 12.

**Files:**
- Create: `router/test/e2e/scenarios/triage-clarification-and-resume.test.ts`

- [ ] **Step 1: Write the scenario.**
  1. Trigger label → triage with `needs_clarification`. Assert `shopfloor:awaiting-info` label added; comment posted with questions; no slug in issue body yet.
  2. Simulate user response by posting an issue comment via the fake's API (`fake.asOctokit("alice").rest.issues.createComment(...)`) and removing the awaiting-info label.
  3. Deliver a `issue-unlabeled-awaiting-info.json` event.
  4. `runStage("triage")` again with a queued `classified` decision. Assert `shopfloor:medium` and `shopfloor:needs-plan` are now present and the issue body contains `Shopfloor-Slug:`.
  5. Continue through plan/impl/review/merge briefly to confirm the clarification flow does not corrupt downstream state.

- [ ] **Step 2: Run, fix, commit.**

```bash
git commit -m "test(e2e): scenario - triage clarification and resume"
```

---

### Task 13: Scenario — spec PR changes-requested rework

Maps to commit 13.

**Files:**
- Create: `router/test/e2e/scenarios/spec-pr-changes-requested-rework.test.ts`

- [ ] **Step 1: Write the scenario.**
  1. Triage as large. Run spec stage. Capture `specPr.number`.
  2. Simulate a reviewer requesting changes by calling `fake.asOctokit("human-reviewer").rest.pulls.createReview(...)` directly with `event: "REQUEST_CHANGES"`. Use a third identity that is NOT the PR author.
  3. Deliver `pr-review-spec-changes-requested.json` with the spec PR number.
  4. Re-run `runStage("spec")` with a fresh agent response. Assert the **same** `specPr.number` is reused (no new PR), the body is updated, and the `shopfloor:spec-in-review` label survives.
  5. Approve the spec PR, merge, continue.
- [ ] **Step 2: Run, fix, commit.**

```bash
git commit -m "test(e2e): scenario - spec PR changes requested rework"
```

---

### Task 14: Scenario — impl review retry loop (the big one)

Maps to commit 14. **This is the scenario the whole project might be worth doing.**

**Files:**
- Create: `router/test/e2e/scenarios/impl-review-retry-loop.test.ts`

- [ ] **Step 1: Pre-seed spec/plan files**

Both the first-run inline ctx step AND `build-revision-context` read these via `existsSync` / `readFileSync`. Use `harness.seedFile("docs/shopfloor/specs/issue-42-spec.md", "(spec contents)")` and the corresponding plan file. The route output's `spec_file_path` / `plan_file_path` must match what `harness.seedFile` writes.

- [ ] **Step 2: Write the scenario**

```ts
test("impl revision retry loop: revision_mode flips, same PR reused, build-revision-context populates revision_block", async () => {
  // 1. Triage as medium. Run plan, merge plan PR.
  // 2. First implement run (revision_mode=false).
  await harness.deliverEvent(/* needs-impl event */);
  expect((await harness.routeOutputsSnapshot()).revision_mode).toBe("false"); // helper for clarity
  harness.queueAgent("implement", { /* ... */ });
  await harness.runStage("implement");
  const implPr = fake.openPrs().find((p) => p.head.ref.includes("impl"))!;
  expect(implPr.body).toMatch(/Shopfloor-Review-Iteration: 0/);
  const firstRunPrNumber = implPr.number;

  // 3. Review iteration 0: REQUEST_CHANGES.
  await harness.deliverEvent(loadEvent("pr-ready-for-review-impl.json",
    { issueNumber: 42, prNumber: firstRunPrNumber }));
  harness.queueReviewAgents({
    compliance: { output: JSON.stringify({ verdict: "issues_found", summary: "fix",
      comments: [{ path: "src/foo.ts", line: 1, side: "RIGHT", body: "rename",
        confidence: 95, category: "compliance" }] }) },
    bugs:     { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    security: { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    smells:   { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
  });
  await harness.runStage("review");
  expect(fake.labelsOn(42)).toContain("shopfloor:review-requested-changes");
  expect(fake.reviewsOn(firstRunPrNumber)).toHaveLength(1);

  // 4. Second implement run (revision_mode=true). Route should output
  //    revision_mode=true and impl_pr_number=firstRunPrNumber.
  await harness.deliverEvent(
    loadEvent("pr-review-submitted-changes-requested.json",
      { issueNumber: 42, prNumber: firstRunPrNumber }),
  );
  harness.queueAgent("implement", {
    pr_title: "feat: add foo (revised)",
    pr_body: "Renamed per review.",
    summary_for_issue_comment: "Fixed.",
    changed_files: JSON.stringify(["src/foo.ts"]),
  });
  await harness.runStage("implement");
  // Same PR number — no new PR opened.
  expect(fake.openPrs().filter((p) => p.head.ref.includes("impl"))).toHaveLength(1);
  const revisedPr = fake.pr(firstRunPrNumber);
  expect(revisedPr.body).toMatch(/Shopfloor-Review-Iteration: 1/);

  // 5. Review iteration 1: APPROVE.
  await harness.deliverEvent(
    loadEvent("pr-ready-for-review-impl.json",
      { issueNumber: 42, prNumber: firstRunPrNumber }),
  );
  harness.queueReviewAgents({
    compliance: { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    bugs:       { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    security:   { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
    smells:     { output: JSON.stringify({ verdict: "clean", summary: "ok", comments: [] }) },
  });
  await harness.runStage("review");
  expect(fake.labelsOn(42)).toContain("shopfloor:review-approved");
  expect(fake.reviewsOn(firstRunPrNumber)).toHaveLength(2);

  // 6. Merge. Done.
  fake.mergePr(firstRunPrNumber, fake.pr(firstRunPrNumber).head.sha);
  await harness.deliverEvent(/* pr closed merged */);
  await harness.runStage("handle-merge");
  expect(fake.labelsOn(42)).toContain("shopfloor:done");
});
```

- [ ] **Step 3: This scenario is the most likely to expose harness gaps.** Common ones:
  - The route helper needs to read the existing impl PR's body to compute `revision_mode`. The fake must return the impl PR with the metadata block. Confirm by tracing through `state.ts:resolveStage` and `parsePrMetadata`.
  - `build-revision-context` reads `prompts/implement-revision-fragment.md` from disk. This file already exists in the repo; the harness needs to point `prompt_fragment_path` at the real file (use a literal `prompts/implement-revision-fragment.md` in the job graph).
  - The fake's `listReviews` must return the `commit_id` field exactly matching what `getPrReviewsAtSha` filters on. Verify the SHA passed to `aggregate-review` matches the SHA on the review row.
  - Slot extension commits as needed: `test(e2e): extend harness for X` between this task and Task 13's commit.

- [ ] **Step 4: Run, fix, commit.**

```bash
git commit -m "$(cat <<'EOF'
test(e2e): scenario - impl review retry loop

Exercises the revision-mode fork in the implement job: first run uses
the inline jq ctx step, the review fan-out requests changes, and the
second run uses build-revision-context (the router helper) to assemble
the context.json with a populated revision_block. Asserts the same PR
is reused, the Shopfloor-Review-Iteration counter increments, two
distinct review records exist on the PR (one per iteration,
distinguished by commit_id), and the triage mutex + retry flow does
not deadlock.
EOF
)"
```

---

### Task 15: Scenario — review stuck after max iterations

Maps to commit 15.

**Files:**
- Create: `router/test/e2e/scenarios/review-stuck-after-max-iterations.test.ts`

- [ ] **Step 1: Write the scenario.** Same shape as Task 14 but the review fan-out requests changes for three iterations in a row. After the third REQUEST_CHANGES, `aggregate-review` should label the issue `shopfloor:review-stuck` and stop the loop. Assertions:
  - Final label set ends at `shopfloor:review-stuck`, not `done`.
  - The issue stays open.
  - `report-failure` posts a comment.
  - The impl PR is left open and not merged.
- [ ] **Step 2: Run, fix, commit.**

```bash
git commit -m "test(e2e): scenario - review stuck after max iterations"
```

---

## Phase 4: Polish

### Task 16: README

Maps to commit 16: `docs(e2e): add README for layer 1 e2e tests`.

**Files:**
- Create: `router/test/e2e/README.md`

- [ ] **Step 1: Draft the README** covering:
  1. Mental model — what Layer 1 is, what it isn't, why it exists alongside per-helper unit tests.
  2. Adding a scenario — step-by-step from fixture choice to assertions.
  3. Adding a fake-github capability — when you need a new Octokit method, where to add the handler, the semantic rule, and the unit test.
  4. Updating the job graph — when `shopfloor.yml` changes, how to mirror it in `job-graph.ts`.
  5. Debugging a failing scenario — reading `eventLogSummary()`, the `ScenarioStepError` format, common gotchas.
  6. What this can't catch — explicit pointer to the (forthcoming) Layer 2 spec for YAML wiring concerns.
  7. **Global constraints from `setup.ts`:** `test.concurrent` is forbidden anywhere under `router/test/e2e/scenarios/**` (process.env is process-global), and the global `beforeEach` tripwire in `setup.ts` runs for every test in the project, so any future unit test that sets `INPUT_*` env vars must clean them up in its own `afterEach` or the next test will throw.
- [ ] **Step 2: Commit.**

```bash
git add router/test/e2e/README.md
git commit -m "docs(e2e): add README for layer 1 e2e tests"
```

---

### Task 17: Test scripts

Maps to commit 17: `chore(test): add pnpm test:e2e and test:e2e:watch scripts`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

```jsonc
"scripts": {
  "build": "pnpm -r build",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "vitest run router/test/e2e",
  "test:e2e:watch": "vitest router/test/e2e",
  "typecheck": "pnpm exec tsc --noEmit",
  "typecheck:all": "pnpm -r typecheck",
  "format": "prettier --write .",
  "format:check": "prettier --check ."
}
```

- [ ] **Step 2: Verify both new scripts work**

Run: `pnpm test:e2e`
Expected: every e2e test passes (and only e2e tests run).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): add pnpm test:e2e and test:e2e:watch scripts"
```

---

## Final verification checklist

- [ ] **Run the whole test suite from a clean state**

```bash
pnpm test
```

Expected: every existing test plus all e2e tests green. Watch the timing: Layer 1 should add **<1 second**.

- [ ] **Type-check the whole repo**

```bash
pnpm exec tsc --noEmit
pnpm -r typecheck
```

Expected: clean.

- [ ] **Format check**

```bash
pnpm format:check
```

Expected: clean.

- [ ] **Confirm `router/dist/index.cjs` rebuilt at least once** (for the Task 0a `main` export edit, if the dist is committed and a CI gate enforces dist-up-to-date)

```bash
pnpm --filter @shopfloor/router build
git diff --stat router/dist/index.cjs
```

If the dist file changed, commit it as part of one of the existing commits (squash into Task 1's commit during review, or land it as a separate `chore(router): rebuild dist` commit before any of the e2e commits).

- [ ] **Confirm scenario timing**

Run with timing:

```bash
pnpm test router/test/e2e/scenarios -- --reporter=verbose
```

Per-scenario should be **< 100ms**. If any single scenario crosses 200ms, debug the harness.

---

## Open risks called out by the spec, and how this plan handles them

1. **`@actions/core` internal state reset** → handled by Task 0b research and Task 5's `resetCoreState` with tripwires.
2. **Vitest concurrency** → handled by Task 8's `setup.ts` tripwire on stale `INPUT_*` env vars.
3. **Snapshot file size** → assertion in scenarios is targeted; `fake.snapshot()` is intentionally small. If it bloats, switch to delta-from-seed snapshots in Task 9.
4. **Branch SHA progression** → handled by `fake.advanceSha(branch)` in Task 4.
5. **Helper signature drift** → the `InputMap`/`InputSource` typing in Task 7 catches typos at scenario-runtime, not silently. A future improvement is to type `InputMap` against per-helper input literal types; deferred to a follow-up.
6. **Identity binding for the dual-token model** → handled by Task 7's `vi.mocked(getOctokit).mockImplementation` token resolver.
7. **Helper inventory drift** → the spec lists 15 helpers at HEAD; this plan covers all of them via the job graph in Task 7.
8. **Filesystem helpers** (`render-prompt`, `build-revision-context`) → handled by `harness.seedFile` (Task 7) and explicit seeding in Task 11 (large-happy) and Task 14 (impl-review-retry-loop).

---

## Total commit count

18 commits — the spec's 17-commit conventional-commits plan plus one fixture-add commit slotted into Task 9 (the `issue-labeled-needs-impl.json` fixture):

| # | Commit subject |
| --- | --- |
| 1 | `test(e2e): scaffold fake-github state model and errors` |
| 2 | `test(e2e): implement fake-github issues handler with semantic rules` |
| 3 | `test(e2e): implement fake-github pulls handler with semantic rules` |
| 4 | `test(e2e): implement fake-github repos handler and snapshot helpers` |
| 5 | `test(e2e): scaffold scenario harness with env lifecycle and output parsing` |
| 6 | `test(e2e): add agent stub queue and event fixture loader` |
| 7 | `test(e2e): hand-script job graph and runStage dispatch` |
| 8 | `test(e2e): wire @actions/github mock via vitest setup file` |
| 8b | `test(e2e): add issue-labeled-needs-impl fixture for scenario harness` |
| 9 | `test(e2e): scenario - quick happy path` |
| 10 | `test(e2e): scenario - medium happy path` |
| 11 | `test(e2e): scenario - large happy path with spec` |
| 12 | `test(e2e): scenario - triage clarification and resume` |
| 13 | `test(e2e): scenario - spec PR changes requested rework` |
| 14 | `test(e2e): scenario - impl review retry loop` |
| 15 | `test(e2e): scenario - review stuck after max iterations` |
| 16 | `docs(e2e): add README for layer 1 e2e tests` |
| 17 | `chore(test): add pnpm test:e2e and test:e2e:watch scripts` |

Plus an unknown number of `test(e2e): extend harness for X` commits that may slot in between scenarios as gaps surface during Phase 3. These are expected and acceptable.
