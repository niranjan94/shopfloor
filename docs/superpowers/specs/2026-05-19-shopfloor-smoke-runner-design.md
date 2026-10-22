# Shopfloor smoke runner

## Status

Design — 2026-05-19. Brainstormed on the v2 branch.

## Problem

Shopfloor is a GitHub-event-driven stage pipeline. Its correctness is most reliably observed by running it end to end against a real GitHub repo. The vitest suite (`test/`) is good for state-machine, adapter, and per-stage units, but cannot exercise the actual `niranjan94/shopfloor@v2` action running in a real workflow against real Octokit calls. The existing `test/smoke.test.ts` checks a single version export — it is not a smoke test in any operationally meaningful sense.

A canary repo already exists at `niranjan94/shopfloor-smoke`. Its workflows pin `niranjan94/shopfloor@v2` and carry the credentials needed to run the full pipeline. What is missing is a controllable driver that opens the right issues, posts the right comments, performs the human-gated merges, and asserts on the resulting GitHub state.

## Goal

Add a local TypeScript runner under `scripts/smoke/` that, when invoked with `pnpm smoke`, drives `niranjan94/shopfloor-smoke` through a fixed catalogue of scenarios and reports pass / fail / timeout per scenario. The runner trusts that `niranjan94/shopfloor`'s `v2` ref already points at the commit under test.

## Non-goals

- Replacing the vitest suite. The unit tests stay; the runner is complementary.
- Running on CI by default. This script burns runner minutes on the smoke repo and LLM credits on the agent calls. It is a developer-invoked tool.
- Pinning the Shopfloor version automatically. Tag management is the operator's responsibility.
- JSON / JUnit / GitHub-summary output. Stdout is the report.
- Mocking GitHub or the agent. The whole point is to exercise the real pipeline.
- Reaching 100% scenario coverage of every state-machine branch. The catalogue covers the seven flows decided during brainstorming and is intentionally finite.

## High-level architecture

```
                        ┌──────────────────────────────────────┐
                        │  Smoke runner (this repo)            │
                        │  scripts/smoke/                      │
                        │    - scenarios/*.ts                  │
   -- pnpm smoke -->    │    - lib/{github,expect,scenario}.ts │
                        │  Octokit + dotenv + chalk            │
                        └──────────────────────────────────────┘
                                       │  REST + GraphQL via PAT
                                       ▼
                        ┌──────────────────────────────────────┐
                        │  niranjan94/shopfloor-smoke (real)   │
                        │  Workflows reference @v2             │
                        │  Shopfloor stages run on GitHub      │
                        └──────────────────────────────────────┘
```

The runner is the "human" for the duration of a scenario. It creates issues, posts clarification answers, and merges spec / plan / implement PRs at the points the pipeline waits for human action. The pipeline itself runs unchanged on GitHub.

## Directory layout

```
scripts/smoke/
  index.ts                       CLI entry. Parses args, loads env, dispatches.
  lib/
    env.ts                       Load .env. Validate SHOPFLOOR_SMOKE_GH_TOKEN and the two app login env vars.
    github.ts                    Octokit factory + thin helpers (issue, pr, comment, merge, branch delete, GraphQL deleteIssue).
    expect.ts                    Polling assertions: expectLabel, expectLabelMissing, expectPrOpenedFor, expectCommentByApp, expectIssueClosed, expectNewCommitOn.
    scenario.ts                  runScenario(scenario, ctx): timeout enforcement, try / finally cleanup, structured log.
    run.ts                       Orchestrator: parallel vs sequential, summary report.
    tag.ts                       Generate the per-run prefix, e.g. smoke-20260519-abc1.
    cleanup.ts                   Close PRs, delete their branches, GraphQL-delete issues. Match by title-prefix.
  scenarios/
    quick.ts
    medium.ts
    large.ts
    awaiting-info.ts
    review-only.ts
    revision-loop.ts
    skip-review-and-revise.ts
package.json                     Adds "smoke": "tsx scripts/smoke/index.ts"; adds tsx + dotenv + chalk to devDependencies.
.env.example                     Documents all required env vars.
```

`tsx` is added to devDependencies so the script can run TypeScript directly without a separate build step.

## Conventions and identifiers

### Per-run tag

`lib/tag.ts` generates a tag of the form `smoke-YYYYMMDD-XXXX` where `XXXX` is a four-character lowercase alphanumeric suffix (rand). The tag is the prefix on every issue title, e.g.:

```
smoke-20260519-abc1 / quick: rename dashboard heading
```

The slash-separated `<tag> / <scenario-id>` shape lets cleanup match by either the full tag or just the date prefix. Per-scenario tags carry the scenario name as a second segment so cleanup logs are unambiguous.

A tag may be overridden with `--tag X` for reproducibility (e.g. when re-running cleanup against an aborted run).

### Branch naming (already established by Shopfloor)

Shopfloor's `state/machine.ts` builds branches as:

- `shopfloor/spec/<issueNumber>-<slug>`
- `shopfloor/plan/<issueNumber>-<slug>`
- `shopfloor/impl/<issueNumber>-<slug>`

The smoke runner does not name branches itself. It identifies them by issue number through the PR body footer (`Shopfloor-Issue: #<n>`) and follows `pull.head.ref`.

### App logins

The runner does not know the GitHub Apps used by a given shopfloor-smoke installation. They are configured via env:

- `SHOPFLOOR_PRIMARY_APP_LOGIN` — typically `shopfloor[bot]`. Used to match triage / spec / plan / implement comments and PR authorship.
- `SHOPFLOOR_REVIEW_APP_LOGIN` — typically `shopfloor-reviewer[bot]`. Used to match review verdicts and review-only outputs.

The `.env.example` lists both with the canonical defaults; the operator overrides them when the installation differs.

## Auth model

A single fine-grained personal access token, scoped to `niranjan94/shopfloor-smoke` only, with:

- `Issues: read / write`
- `Pull requests: read / write`
- `Contents: read / write` (to merge PRs)
- `Administration: read / write` (required for the GraphQL `deleteIssue` mutation)

The token lives in `SHOPFLOOR_SMOKE_GH_TOKEN`, loaded from `.env` at the repo root via `dotenv`. `.env` is gitignored; `.env.example` is committed.

The runner identifies itself as the token owner in every comment and merge — there is no attempt to impersonate the Shopfloor apps. Comments posted by the runner are clearly tagged with the per-run tag (e.g. `<smoke-20260519-abc1> clarification answer: ...`) so they are unambiguous in the issue timeline.

## Pre-flight gates

Before any scenario starts, the runner verifies the world:

1. **Env present.** `SHOPFLOOR_SMOKE_GH_TOKEN`, `SHOPFLOOR_PRIMARY_APP_LOGIN`, `SHOPFLOOR_REVIEW_APP_LOGIN`. Missing → abort with a message naming the variable and what scope it needs.
2. **Token reaches the smoke repo.** `GET /repos/niranjan94/shopfloor-smoke` must return 200. 404 / 403 → abort with the response status and the scope list above.
3. **Token has admin scope.** Probe via `GET /repos/niranjan94/shopfloor-smoke` and read `permissions.admin`. False → abort, because issue deletion will fail at cleanup time and we want to fail fast not late.
4. **No stale debris.** Search issues by title prefix `smoke-` (any tag, not just this run). If any open issue or PR matches and `--allow-stale` is not set, abort with the count and the cleanup hint:
   > N open smoke artifacts found from previous runs. Run `pnpm smoke -- cleanup` or pass `--allow-stale`.
5. **Canonical labels.** Fetch repo labels; check that the full `LABEL_DEFS` set from `src/state/labels.ts` is present. If any are missing, emit a `WARN` (Shopfloor will bootstrap them on first run, but pre-existing labels keep scenarios deterministic).
6. **`v2` ref sanity (warn-only).** Fetch `refs/tags/v2` (or `refs/heads/v2`, whichever exists) on `niranjan94/shopfloor` and compare against local `git rev-parse HEAD`. Mismatch → `WARN: v2 points at <SHA>; local HEAD is <SHA>. Smoke will test v2, not your working tree.`

All hard aborts exit non-zero before any GitHub mutation happens.

## Scenario engine

### Scenario shape

A scenario is a TypeScript module that default-exports an object:

```ts
export default {
  id: "quick",
  name: "Quick path",
  flaky: false,                      // if true, "soft pass" outcomes are reported PASS* not FAIL
  timeoutMs: 10 * 60_000,
  run: async (ctx: SmokeCtx): Promise<ScenarioOutcome> => { ... },
} satisfies Scenario;
```

`ScenarioOutcome` is `{ kind: "pass" } | { kind: "soft-pass"; reason: string } | { kind: "fail"; reason: string }`. Timeouts are surfaced by `runScenario` itself, not by the scenario function — `expect.ts` throws `ExpectTimeout`, which the wrapper translates into a `fail`.

### The `ctx` object

```ts
interface SmokeCtx {
  tag: string;                                 // smoke-20260519-abc1/quick
  log: (msg: string) => void;
  gh: Octokit;
  appLogins: { primary: string; review: string };

  // Mutations
  createIssue(opts: { title: string; body: string; labels?: string[] }): Promise<{ number: number }>;
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  commentOnIssue(issue: number, body: string): Promise<void>;
  commentOnPr(pr: number, body: string): Promise<void>;
  mergePr(pr: number, method?: "squash" | "merge"): Promise<void>;
  closePr(pr: number): Promise<void>;
  deleteBranch(ref: string): Promise<void>;

  // Polling assertions (all throw ExpectTimeout on miss)
  expectLabel(issue: number, label: string | RegExp, opts?: ExpectOpts): Promise<void>;
  expectLabelMissing(issue: number, label: string, opts?: ExpectOpts): Promise<void>;
  expectPrOpenedFor(issue: number, stage: Stage, opts?: ExpectOpts): Promise<{ number: number; headRef: string; headSha: string }>;
  expectCommentByApp(issue: number, appLogin: string, contains?: RegExp, opts?: ExpectOpts): Promise<void>;
  expectIssueClosed(issue: number, opts?: ExpectOpts): Promise<void>;
  expectNewCommitOn(pr: number, sinceSha: string, opts?: ExpectOpts): Promise<{ headSha: string }>;
  expectReviewByApp(pr: number, appLogin: string, contains?: RegExp, opts?: ExpectOpts): Promise<void>;
}

interface ExpectOpts {
  timeoutMs?: number;       // defaults to 8 minutes per call, capped by scenario timeout
  pollMs?: number;          // initial poll interval, default 10s
}
```

### Polling strategy

Each `expect*` call:

1. Polls the relevant endpoint every `pollMs` (default 10s).
2. After 60s without progress, doubles the interval up to 30s (a back-off, not exponential, to keep latency bounded).
3. Returns immediately on first match.
4. Throws `ExpectTimeout` with the last-observed value when `timeoutMs` elapses.

The per-call `timeoutMs` default is 8 minutes; scenarios override per call where they need tighter (label transitions) or looser (LLM-bound stage outputs) bounds. The scenario-level `timeoutMs` is an outer hard ceiling enforced by `runScenario`; whichever fires first wins.

`expectPrOpenedFor` matches the PR body against:

```
Shopfloor-Issue: #<n>
Shopfloor-Stage: <stage>
```

The runner does not import `parsePrMetadata` from `src/state/metadata.ts` (the smoke runner is a standalone script, not part of the bundled action). `lib/expect.ts` carries its own line-by-line regex that mirrors the format. If the format changes in `src/state/metadata.ts`, the smoke runner's regex must be updated to match — both the spec doc and the implementation README call this out.

`expectPrOpenedFor` returns `headSha` so subsequent assertions can wait for new commits on the same PR (revision loop).

### Reporting

Stdout, line-prefixed with `[<full-tag>]`. Examples:

```
[smoke-20260519-abc1/quick] 00:00:03  > creating issue
[smoke-20260519-abc1/quick] 00:00:04  + issue #142 created
[smoke-20260519-abc1/quick] 00:00:32  . waiting for label shopfloor:quick (last: shopfloor:triaging)
[smoke-20260519-abc1/quick] 00:01:14  + label shopfloor:quick observed
```

End-of-run summary (one table to stdout):

```
SCENARIO            STATUS    TIME     ARTIFACTS
quick               PASS      4m12s    #142 (deleted)
medium              PASS      14m02s   #143 (deleted)
large               FAIL      40m00s   timed out on shopfloor:done. #144 left open.
awaiting-info       PASS      6m31s    #145 (deleted)
review-only         PASS      8m20s    PR #146 (closed, branch deleted)
revision-loop       PASS*     11m05s   approved on iter 1. #147 (deleted)
skip-review/revise  PASS      9m44s    #148, #149 (deleted)
```

Exit code: 0 if every scenario is PASS or PASS* (`soft-pass`). Nonzero if any FAIL or TIMEOUT.

## Scenarios

### `quick.ts` (10m timeout)

Brief: ask for a trivial single-file UI change in `app/dashboard/page.tsx`.

Sequence:

1. `createIssue({ title: "<tag> quick: rename dashboard heading", body: "...", labels: ["shopfloor:trigger"] })`.
2. `expectLabel(issue, "shopfloor:quick", { timeoutMs: 5m })` — triage classified.
3. `expectPrOpenedFor(issue, "implement", { timeoutMs: 8m })` — impl PR drafted; capture `prNumber` and `headSha`.
4. `expectLabel(issue, "shopfloor:needs-review", { timeoutMs: 8m })` — impl complete.
5. `expectLabel(issue, "shopfloor:review-approved", { timeoutMs: 6m })` — review passed.
6. `mergePr(prNumber)` — runner performs the human merge.
7. `expectLabel(issue, "shopfloor:done", { timeoutMs: 2m })`.

### `medium.ts` (20m timeout)

Brief: a multi-file UI feature that touches state and components but no schema. Example: "add a status filter to the tasks list".

Sequence:

1. Create issue with `shopfloor:trigger`.
2. `expectLabel(issue, "shopfloor:medium", { timeoutMs: 5m })`.
3. `expectLabel(issue, "shopfloor:plan-in-review", { timeoutMs: 8m })`.
4. `planPr = expectPrOpenedFor(issue, "plan", { timeoutMs: 8m })`.
5. `mergePr(planPr.number)`.
6. `implPr = expectPrOpenedFor(issue, "implement", { timeoutMs: 10m })`.
7. `expectLabel(issue, "shopfloor:review-approved", { timeoutMs: 12m })`.
8. `mergePr(implPr.number)`.
9. `expectLabel(issue, "shopfloor:done", { timeoutMs: 2m })`.

### `large.ts` (40m timeout)

Brief: a multi-component feature deliberately scoped to provoke triage into "large". Example: "add per-task subtasks: data model in `db.ts`, UI tree under each task card, IndexedDB migration to v2, completion rollup".

Sequence:

1. Create issue with `shopfloor:trigger`.
2. `expectLabel(issue, "shopfloor:large", { timeoutMs: 5m })`.
3. `specPr = expectPrOpenedFor(issue, "spec", { timeoutMs: 10m })`.
4. `mergePr(specPr.number)`.
5. `planPr = expectPrOpenedFor(issue, "plan", { timeoutMs: 10m })`.
6. `mergePr(planPr.number)`.
7. `implPr = expectPrOpenedFor(issue, "implement", { timeoutMs: 12m })`.
8. `expectLabel(issue, "shopfloor:review-approved", { timeoutMs: 15m })`.
9. `mergePr(implPr.number)`.
10. `expectLabel(issue, "shopfloor:done", { timeoutMs: 2m })`.

### `awaiting-info.ts` (10m timeout)

Brief: deliberately underspecified — "make the dashboard better".

Sequence:

1. Create issue with `shopfloor:trigger`.
2. `expectLabel(issue, "shopfloor:awaiting-info", { timeoutMs: 5m })` — triage asked for clarification.
3. `expectCommentByApp(issue, ctx.appLogins.primary, /clarif|please|which|what/i, { timeoutMs: 5m })`.
4. `commentOnIssue(issue, "<tag> clarification: add a 'tasks completed today' counter on the dashboard hero. Pure UI, no persistence.")`.
5. `expectLabelMissing(issue, "shopfloor:awaiting-info", { timeoutMs: 5m })`.
6. `expectLabel(issue, /shopfloor:(quick|medium)/, { timeoutMs: 5m })`.

Stops here. The point of the scenario is the awaiting-info round-trip, not the downstream pipeline.

### `review-only.ts` (10m timeout)

Brief: open a human-authored PR with no Shopfloor footer.

Sequence:

1. Create a feature branch off `main`: `<tag>/readme-tweak`. Push a one-line change to `README.md`.
2. Open a PR titled `<tag> review-only: README tweak` with a body that does **not** include `Shopfloor-Stage:`.
3. `expectReviewByApp(pr, ctx.appLogins.review, /<marker>/, { timeoutMs: 10m })` — where `<marker>` is derived by inspecting `src/stages/review/apply.ts` for the canonical review-summary marker the review-only flow posts (e.g. a heading or footer). The implementation step is responsible for picking the marker.
4. `closePr(pr.number); deleteBranch("<tag>/readme-tweak")`.

If `src/stages/review/apply.ts` does not produce a stable, reliably-greppable marker, the spec authorises adding one as part of the implementation plan rather than weakening the assertion.

### `revision-loop.ts` (20m timeout, `flaky: true`)

Brief: a request planted with a constraint the review is likely to flag, such that the first impl iteration almost certainly violates it.

Example brief: "Add a 'clear completed' button to the tasks list. CRITICAL: the button must be implemented as a server action using `revalidatePath`. Do NOT use client-side state mutation." (`shopfloor-smoke` is client-only IndexedDB, so the impl agent will violate either the constraint or the architecture; review should flag the violation.)

Sequence:

1. Create issue with `shopfloor:trigger`.
2. `expectLabel(issue, /shopfloor:(quick|medium)/, { timeoutMs: 5m })`.
3. `implPr = expectPrOpenedFor(issue, "implement", { timeoutMs: 10m })` — capture `headSha`.
4. Race:
   - `expectLabel(issue, "shopfloor:review-requested-changes", { timeoutMs: 10m })` (happy path), OR
   - `expectLabel(issue, "shopfloor:review-approved", { timeoutMs: 10m })` (review didn't bite — return `soft-pass` with reason "approved on iter 1").
5. If review-requested-changes:
   1. `expectNewCommitOn(implPr.number, headSha, { timeoutMs: 10m })` — impl revised.
   2. `expectLabel(issue, /shopfloor:(review-approved|review-stuck)/, { timeoutMs: 15m })` — either outcome counts as the loop having advanced.
6. `closePr(implPr.number)` and let cleanup delete the issue and branch.

`flaky: true` means a `soft-pass` is reported as `PASS*` in the summary and does not cause a non-zero exit.

### `skip-review-and-revise.ts` (15m timeout)

Two micro-scenarios in one file, sequenced inside a single `run` so they share a single timeout. Each operates on its own issue.

**Sub-case A: skip-review.**

1. Create issue with `[shopfloor:trigger, shopfloor:skip-review]` and a trivial brief.
2. `expectPrOpenedFor(issue, "implement", { timeoutMs: 8m })`.
3. `expectLabel(issue, "shopfloor:impl-in-review", { timeoutMs: 8m })`.
4. `expectLabelMissing(issue, "shopfloor:needs-review", { timeoutMs: 2m })`.
5. `mergePr(implPr.number)`.
6. `expectLabel(issue, "shopfloor:done", { timeoutMs: 2m })`.

**Sub-case B: revise (against plan).**

1. Create issue with `shopfloor:trigger` and a brief that triggers `shopfloor:medium`.
2. Drive to `shopfloor:plan-in-review`. Capture `planPr.number` and its `headSha`.
3. `addLabel(issue, "shopfloor:revise")`.
4. `expectNewCommitOn(planPr.number, headSha, { timeoutMs: 10m })` — plan re-ran.
5. Optional assertion: `expectLabel(issue, "shopfloor:plan-in-review")` still set (the stage advances back into review).

No merge step in sub-case B — once revise has demonstrably re-run plan, the scenario is done. Cleanup closes the plan PR.

## Cleanup

`scripts/smoke/lib/cleanup.ts` exposes:

```ts
async function cleanupByTitlePrefix(gh: Octokit, prefix: string): Promise<CleanupReport>;
```

Algorithm:

1. `GET /search/issues?q=repo:niranjan94/shopfloor-smoke is:issue <prefix> in:title` — returns matching issues (including PRs, since GitHub treats them as issues in search; we filter on `pull_request` presence).
2. For each result with `pull_request`:
   - Close the PR.
   - Delete `pull_request.head.ref` via `DELETE /repos/.../git/refs/heads/<ref>`. Errors with `Reference does not exist` are swallowed.
3. For each result without `pull_request`:
   - Resolve any PRs that reference the issue in their body via `GET /search/issues?q=repo:... is:pr <prefix> in:body Shopfloor-Issue: #<n>`. (Belt-and-braces — Shopfloor PRs carry the issue number but title-search may also catch them above.)
   - Close those PRs and delete their branches as in step 2.
   - Delete the issue via GraphQL:
     ```graphql
     mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { __typename } }
     ```
4. Return a `CleanupReport { issuesDeleted, prsClosed, branchesDeleted, errors }`.

Per-scenario cleanup on PASS uses the per-scenario tag (`<full-tag>/<scenario-id>`). Whole-run cleanup uses `--tag X` or the default `smoke-`.

PRs cannot be deleted via the GitHub API (no REST endpoint, no GraphQL mutation). Close + branch delete is the maximum cleanup possible; the PR remains visible in the timeline as `closed · branch deleted`.

## CLI surface

```
pnpm smoke                            Run all scenarios in parallel
pnpm smoke -- --only quick,medium     Run a subset
pnpm smoke -- --sequential            Run one at a time (useful for debugging)
pnpm smoke -- --tag mytag             Override the auto-generated tag
pnpm smoke -- --allow-stale           Skip the pre-run stale-debris gate
pnpm smoke -- cleanup                 Cleanup mode. Tears down everything matching `smoke-`.
pnpm smoke -- cleanup --tag X         Cleanup only artifacts tagged X.
pnpm smoke -- --poll-ms 15000         Override default poll interval (debugging the runner)
```

Argument parsing uses `node:util` `parseArgs`. No extra dependency.

## Concurrency

Default: parallel. Each scenario operates on its own issue; Shopfloor's per-issue concurrency group keeps them isolated on the GitHub side. The runner uses `Promise.allSettled` so one scenario's failure does not cancel siblings. Wall-clock equals the slowest scenario (large path ≈ 40m).

`--sequential` runs scenarios one at a time, useful when debugging a single flow or when you want quieter logs.

## Error handling

- **Network / 5xx from GitHub.** `lib/github.ts` wraps every Octokit call with a small retry policy: 3 tries with exponential backoff (1s, 4s, 9s) on 5xx and on `ECONNRESET / ETIMEDOUT`. 4xx errors propagate immediately.
- **GraphQL `deleteIssue` failure.** Logged with the GraphQL error path and not re-tried. The summary marks the scenario as `cleanup-incomplete`; it still passes if the assertions all succeeded.
- **Scenario uncaught exception.** Caught by `runScenario`, reported as `fail` with the error message. The wrapper does **not** run cleanup on failure (so the operator can inspect state).
- **Scenario timeout.** Reported as `fail` with the last-known polling state attached.
- **Ctrl-C.** SIGINT handler in `index.ts` reports the in-flight scenarios, prints what was created, and exits non-zero. No cleanup attempt — the operator may want to inspect.

## Documentation

A new `scripts/smoke/README.md` (this is the one new doc; README beats inline comments here because the setup steps and env vars genuinely need narrative) covers:

- Required env vars and how to mint the PAT
- The seven scenarios at a glance
- How to point `v2` at a specific commit before a smoke run
- Cleanup commands
- Known flakiness (the revision-loop disclaimer)

The main project `README.md` gets a one-paragraph pointer to `scripts/smoke/README.md`.

## Risks and acknowledged limitations

- **LLM nondeterminism.** Stage agents are LLMs. Outputs vary. The scenarios are written to assert on labels and PR existence, not on the contents of generated code, but a triage classifier can still misclassify a brief edge case (e.g. drift from "medium" to "large" between runs). The `flaky` flag exists for scenarios where this is expected. For non-flaky scenarios, retrying once is acceptable; a third failure indicates a real regression.
- **GitHub minute / Anthropic token cost.** A full run executes roughly 12 stage agents end to end and several minutes of GitHub Actions runners. A weekly cadence is the intended budget.
- **`v2` tag is global state.** Two smoke runs sharing the same Shopfloor branch will not interfere (issues are independent), but a smoke run interleaved with a `git push --force` on `v2` will produce mixed results. The runner cannot detect this; the operator is responsible for the tag.
- **PR deletion is impossible.** Closed PRs persist forever in the timeline. The repo will accumulate them at the rate of roughly nine PRs per smoke run. Periodic manual repo recreation is the only true cleanup.
- **Review-only marker dependency.** The review-only scenario assumes the review-only flow posts a stable, greppable marker on the PR. If `src/stages/review/apply.ts` doesn't, the implementation plan adds one rather than weakening the assertion.

## Implementation outline

The implementation plan should be authored separately via `superpowers:writing-plans`. The expected commit sequence is roughly:

1. `chore(smoke): add tsx + dotenv + chalk devDependencies, wire pnpm smoke script`
2. `feat(smoke): scaffold scripts/smoke skeleton with env, github, expect, scenario, tag, run, cleanup`
3. `feat(smoke): implement quick scenario end to end`
4. `feat(smoke): implement medium scenario`
5. `feat(smoke): implement large scenario`
6. `feat(smoke): implement awaiting-info scenario`
7. `feat(smoke): implement review-only scenario (verify review marker shape)`
8. `feat(smoke): implement revision-loop scenario with flaky soft-pass handling`
9. `feat(smoke): implement skip-review-and-revise micro-scenarios`
10. `feat(smoke): pre-flight gates and end-of-run summary`
11. `feat(smoke): cleanup command and per-scenario cleanup on pass`
12. `docs(smoke): scripts/smoke/README.md plus pointer from project README`

## Open implementation questions

1. **Review marker shape.** The implementation must inspect `src/stages/review/apply.ts` to pick a marker for the review-only assertion. If no stable marker exists, the implementation adds one.
2. **GraphQL admin scope.** The deleteIssue mutation requires `Administration: read / write` on the fine-grained PAT. Confirm experimentally that this scope is sufficient (vs. needing `Maintain` or repo admin role outright) on first run; document the answer in `scripts/smoke/README.md`.
3. **Awaiting-info pattern.** The `/clarif|please|which|what/i` regex is a guess at what triage's clarification comment looks like. The implementation should read `src/stages/triage/` to find the canonical phrase and tighten the regex.
