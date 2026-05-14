# Per-Stage Runner Customization

**Status:** Draft, pending review
**Date:** 2026-05-14
**Author:** Brainstormed collaboratively with Claude (Opus 4.7)
**Supersedes / extends:** `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md` §11 (Configuration and inputs — "runner labels" line item)

## 1. Overview

Shopfloor v1 let consumers point each stage at a different GitHub Actions runner (`runner_triage`, `runner_spec`, `runner_plan`, `runner_impl`, `runner_review`, with `runner_agent` as a default and `runner_router` for dispatch). v1 could do this because it was a reusable workflow that defined the jobs itself.

Shopfloor v2 is a single GitHub Action — the consumer's workflow owns `runs-on:`. The v2 design doc lists "runner labels" as a preserved input but the shipped `action.yml` does not expose any way to vary the runner across stages. Today a v2 caller has exactly one runner sizing for the whole pipeline, which forces them to size for `implement` (the expensive stage) on every event, including the read-only triage and review stages.

This spec adds a structural primitive to the v2 action — split resolution from execution — so a consumer can run a cheap "router" job on `ubuntu-latest` and dispatch to per-stage execute jobs each with their own `runs-on:`. The single-job pattern stays as the default for consumers who don't need this.

## 2. Goals and non-goals

### Goals

- Let a v2 consumer assign different runners to different stages, without Shopfloor owning the job structure.
- Keep the existing single-job workflow working with zero changes (backwards-compatible default).
- Inherit v1's hard-won race protections (commit `aaef95f`, "per-stage concurrency groups and precheck wiring"). Specifically: live label re-fetch from the GitHub API at execute time, and an explicit `concurrency:` group recommendation in the sample workflow.

### Non-goals

- Per-stage runner selection as a single action input (impossible by construction — the action runs inside a job, the consumer owns `runs-on:`).
- Cross-job state passing beyond a routing hint. Each execute job re-resolves and re-prechecks from scratch.
- Changes to the state machine, stage code, decision schemas, audit event types, or the four-lens review fan-out.
- Reintroducing v1's reusable workflow.
- Recovery automation for orphaned mutex labels (separate concern; not made worse by this change).

## 3. Design

### 3.1 Action API additions

Two new inputs:

| Input    | Values                            | Default  | Meaning                                                                                                                                          |
| -------- | --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`   | `auto` \| `resolve` \| `execute`  | `auto`   | What this invocation does. `auto` is the current single-process behavior. `resolve` only routes. `execute` runs a stage if the filter permits.   |
| `stages` | comma-separated stage list        | `""`     | Only meaningful when `mode: execute`. If non-empty, the resolved stage must be in this list or the invocation exits 0 silently. Empty means all. |

Valid stage names in the `stages` list: `triage`, `spec`, `plan`, `implement`, `review`. Invalid names fail input validation in `src/config/inputs.ts`.

Two new action outputs (set by every invocation, regardless of mode):

| Output     | Type                                                                  | Notes                                                          |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `stage`    | `triage` \| `spec` \| `plan` \| `implement` \| `review` \| `none`     | What `resolveStage` (or `resolveReviewOnly`) returned.         |
| `executed` | `"true"` \| `"false"`                                                 | Whether this invocation actually ran a stage's agent + apply.  |

Outputs are set via `core.setOutput()` in `src/entry.ts` after the orchestrator returns. Both outputs are always present.

### 3.2 Mode semantics

**`auto`** (default). Existing behavior, untouched. The orchestrator resolves, prechecks, acquires the mutex, runs the agent, applies, and releases — all in one process. `stage` and `executed` outputs are set at the end. `executed` is `true` iff the agent actually ran (i.e., resolve returned a real stage and precheck passed).

**`resolve`**. The orchestrator calls `resolveStage()` (or `resolveReviewOnly()` if `review_only: true`), emits the existing `stage_resolved` audit event, sets the `stage` output, sets `executed: false`, and exits 0. No mutex acquired. No GitHub mutations. No agent call. Even if resolve picks a real stage, no execute work runs in this invocation. Cost: a few hundred ms of pure TypeScript plus the action's bootstrap (auth, event parse).

**`execute`**. The orchestrator:

1. Parses inputs and event payload as usual.
2. Calls `resolveStage()` (or `resolveReviewOnly()` when `review_only: true`) using the event payload's labels. This is the routing hint — not authoritative.
3. If resolved stage is `none`, set outputs (`stage=none`, `executed=false`) and exit 0.
4. If resolved stage is not in the `stages` allowlist, set outputs and exit 0.
5. **Fetch live issue labels from the GitHub API** (`github.getIssue(issueNumber)`) and re-run the precheck logic in `orchestrator.ts:precheckStage()` against that live snapshot, not against `extractEventLabels()` from the payload. (See §3.4 for why this matters.)
6. If precheck fails, emit `precheck_failed`, set outputs, exit 0.
7. Acquire the stage's mutex label.
8. Run the stage runner.
9. Apply the stage's decision.
10. Release the mutex in `finally`.
11. Set `executed: true`.

The execute job never trusts the resolve job's `stage` output as proof that work should run — it only used the resolve output to decide whether to spin up at all (via the `if:` gate). Once spun up, execute re-resolves from scratch.

### 3.3 Sample workflows

The existing single-job example (`examples/shopfloor.yml`) stays unchanged. It remains the recommended pattern for consumers who don't need per-stage runners.

A new file `examples/shopfloor-split-runners.yml` documents the two-job pattern:

```yaml
name: Shopfloor (split runners)

on:
  issues:
    types: [opened, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, ready_for_review, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: read
  pull-requests: read

# Serialize events that touch the same issue. Without this, a label flip from
# one stage's apply() can race the next stage's start. v1 learned this in
# commit aaef95f ("per-stage concurrency groups and precheck wiring").
concurrency:
  group: shopfloor-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  resolve:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      stage: ${{ steps.r.outputs.stage }}
    steps:
      - uses: niranjan94/shopfloor@v2
        id: r
        with:
          mode: resolve
          # Use client credentials, not preminted tokens. The resolve→execute
          # gap can be 60+ seconds; client creds refresh transparently.
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}

  light:
    needs: resolve
    if: contains(fromJSON('["triage","spec","plan","review"]'), needs.resolve.outputs.stage)
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: niranjan94/shopfloor@v2
        with:
          mode: execute
          stages: triage,spec,plan,review
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
          github_app_review_client_id: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID }}
          github_app_review_private_key: ${{ secrets.SHOPFLOOR_REVIEW_APP_KEY }}

  implement:
    needs: resolve
    if: needs.resolve.outputs.stage == 'implement'
    runs-on: ubuntu-latest-8core    # consumer's beefy runner
    timeout-minutes: 60
    steps:
      - uses: niranjan94/shopfloor@v2
        with:
          mode: execute
          stages: implement
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
```

Consumers can split however they like — one job per stage, light vs. heavy, by complexity, by runner pool. The action's only contract is the `stages:` filter.

### 3.4 Why execute re-fetches live labels

Today's orchestrator reads labels from the event payload via `extractEventLabels()` (`src/orchestrator.ts:162-181`). In single-job mode this is good enough: the gap between event firing and orchestrator running is small.

In two-job mode the gap widens. Resolve job startup, resolve work, execute job startup, execute bootstrap — each adds latency. A human or another workflow can flip a label inside that window. The event payload's `labels` array is frozen at event time; the precheck against it can pass against stale state.

v1 hit this exact class of bug in commit `aaef95f` (the spec is `fb47303`, "docs: add specs for shopfloor concurrency and staleness fixes"). The fix there was a `precheck-stage` helper that called the GitHub API to get current labels before letting the agent start. We adopt the same posture in execute mode: call `github.getIssue(issueNumber)` and use those labels for precheck.

`auto` mode is unchanged for now (single-process; the time gap is small enough that the payload snapshot has worked in practice). Live-label fetch in `auto` mode is a follow-up worth doing once we have telemetry on race incidence; out of scope for this spec.

### 3.5 Audit events

No new event types. The execute mode's flow emits the existing sequence: `stage_resolved` → optional `precheck_failed` → `stage_started` → stage-internal events → `stage_decided` (or `stage_failed`).

The resolve mode emits only `stage_resolved`.

The audit `runId` differs between the resolve and execute jobs (each gets its own `GITHUB_JOB`-derived UUID), but the GitHub Actions run id is shared, so correlation across the two jobs is via that.

### 3.6 review_only interaction

`review_only: true` short-circuits to `resolveReviewOnly()` regardless of mode. In two-job mode, both `resolve` and `execute` invocations must receive `review_only: true` — the consumer wires it into both jobs.

### 3.7 Token guidance

The split widens the resolve→execute time gap, which matters for the **preminted token** auth path (`github_app_token` / `github_app_review_token`). Those tokens are GitHub-installation tokens with a hard 60-minute TTL.

Single-job consumers using preminted tokens already risk hitting the TTL during long implement stages. Two-job consumers pay an extra 30-60s up front (resolve job spin-up, execute job spin-up), which is small in absolute terms but tightens the budget. The split-runners example pins client-credential auth (`github_app_client_id` + `github_app_private_key`), which mints fresh installation tokens in-process per request. The action's docs and the new sample workflow both call this out explicitly.

No change to `src/github/app-token.ts:resolveAuth()`.

## 4. Implementation

### 4.1 Files touched

| File                                                                        | Change                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `action.yml`                                                                | Add `mode` and `stages` inputs. Add `outputs:` section declaring `stage` and `executed`.                                                   |
| `src/config/inputs.ts`                                                      | Parse and validate `mode` (enum) and `stages` (comma-split → `Stage[]`). Reject invalid stage names. Expose on `Config`.                   |
| `src/entry.ts`                                                              | After `runOrchestrator` resolves, call `core.setOutput('stage', ...)` and `core.setOutput('executed', ...)` using values returned/threaded. |
| `src/orchestrator.ts`                                                       | Return a result object (`{ stage, executed }`) instead of `void`. Branch on `config.mode` at the top. In `execute`, fetch live labels via `args.github.getIssue()` and use those in `precheckStage`. |
| `examples/shopfloor.yml`                                                    | No change (stays as the simple-case example).                                                                                              |
| `examples/shopfloor-split-runners.yml` (new)                                | The two-job pattern, copy-pasteable.                                                                                                       |
| `test/orchestrator.test.ts` (or split into focused files)                   | Coverage: resolve mode emits stage and exits; execute filter miss exits 0; execute filter hit runs full path; execute precheck uses live labels (mock `getIssue` to return different labels than the event payload); review_only in both modes; `auto` mode unchanged from today. |
| `dist/index.cjs`                                                            | Rebuilt by `pnpm build`. Committed.                                                                                                        |
| `CLAUDE.md`                                                                 | One-line note under "Stage Flow" or a new "Modes" subsection pointing to the split-runners example.                                        |
| `README.md`                                                                 | Document `mode`/`stages` inputs and link the split-runners example.                                                                        |

### 4.2 Orchestrator return shape

`runOrchestrator` becomes:

```ts
export interface OrchestratorResult {
  stage: Stage | "none";
  executed: boolean;
}

export async function runOrchestrator(args: OrchestratorArgs): Promise<OrchestratorResult> {
  // ...
}
```

`entry.ts` reads the result and calls `core.setOutput`.

### 4.3 Live-label fetch placement

In `runOrchestrator`, after `decision = resolveStage(...)` and `decision.stage !== "none"`, when `config.mode === "execute"`:

```ts
// Fetch live labels from the API. The event payload's snapshot may be stale
// by 30-60s in the two-job split pattern. v1 commit aaef95f.
let liveLabelSet: Set<string>;
if (decision.issueNumber !== undefined) {
  const live = await args.github.getIssue(decision.issueNumber);
  liveLabelSet = new Set(live.labels.map((l) => l.name));
} else {
  liveLabelSet = new Set(issue?.labels ?? []);
}
const precheck = precheckStage(stage, liveLabelSet);
```

The existing `precheckStage` signature already takes a `Set<string>`; no change needed there.

For `auto` mode, keep the existing behavior (payload-derived labels). Comment in code points to this spec for the rationale.

## 5. Edge cases

Each maps to a v1 commit so we know it was real.

| Case                                                                   | v1 fix         | v2 behavior in this spec                                                                                                                |
| ---------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Label flips between resolve and execute                                | `aaef95f`      | Execute re-resolves AND re-prechecks against live API labels. Filter miss → exit 0.                                                     |
| Stale webhook redelivery doubles a stage run                           | `aaef95f`      | Mutex label is the dedup key. Second execute hits precheck-fail (mutex already held).                                                   |
| Two events on the same issue serialize                                 | `aaef95f`      | Sample workflow ships with `concurrency: group: shopfloor-${{ issue.number }}` so the second event waits for the first.                 |
| Mutex orphaned on runner crash                                         | `59fbefe`      | Unchanged: orchestrator's `try/finally` releases. Crash mid-stage still leaves the label until manual cleanup. Documented in the runbook. |
| Apply step crashes mid-mutation                                        | `80612c4`      | Unchanged: orchestrator's `finally` releases mutex. Apply partial failure remains a stage-failure case handled by `reportFailure`.       |
| Preminted token TTL exhausted by long execute                          | `1ae596b`      | Sample workflow uses client credentials. Docs warn that preminted tokens are extra risky in split mode.                                  |
| `none` route on merged-PR event                                        | `4cbe02a`      | Unchanged: state machine returns `none` with a `triggered_label_flip` reason. Execute exits 0 silently.                                  |
| Setup hooks (`setup_stages`, v1)                                       | `41f837c`      | Consumer puts setup steps in whichever job they want, naturally per-stage. v1's `setup_stages` input was a workaround for the reusable-workflow shape; v2 does not need it. |

## 6. Testing

Unit tests in `test/orchestrator.test.ts` (or split):

- `auto` mode: full pipeline runs (no regression in any existing test).
- `resolve` mode: emits `stage_resolved`, returns `{ stage, executed: false }`, makes zero mutation calls on `MockGitHubAdapter`.
- `resolve` mode with `stage: none`: returns `{ stage: "none", executed: false }`, no audit events beyond resolution.
- `execute` mode, filter hit, precheck pass: full execute path, `executed: true`.
- `execute` mode, filter miss: returns `{ stage: <resolved>, executed: false }`, no agent call, no mutex acquired.
- `execute` mode, payload labels say "go" but live labels (mocked `getIssue`) say "abort": precheck fails, `executed: false`.
- `execute` mode, payload labels say "abort" but live labels say "go": precheck passes (live labels win), `executed: true`.
- `execute` mode with `review_only: true`: routes via `resolveReviewOnly()`, filter against `review` only.
- Input validation: invalid `mode` string rejected; invalid stage name in `stages` rejected.

E2E tests in `test/e2e/`: add one fixture-driven scenario exercising the resolve→execute handoff through two synthetic action invocations sharing the same event payload, asserting outputs and audit streams across both.

No live-Claude tests change.

## 7. Conventional commit plan

1. `feat(config): add mode and stages action inputs`
2. `feat(orchestrator): return OrchestratorResult and branch on mode`
3. `feat(orchestrator): fetch live labels for precheck in execute mode`
4. `feat(entry): emit stage and executed action outputs`
5. `test(orchestrator): cover resolve/execute modes and live-label precheck`
6. `docs(examples): add split-runners workflow example`
7. `docs(readme): document mode and stages inputs`
8. `docs(claude): note split-runners pattern in CLAUDE.md`
9. `chore(dist): rebuild dist/index.cjs`

## 8. Open questions

None blocking. One deferred:

- Whether to switch `auto` mode to fetch live labels for precheck as well (matching execute mode). Argument for: consistency, defense against the same race in single-job consumers with slow runner cold-starts. Argument against: one extra API call per event for everyone, where the existing payload-based precheck has been adequate. Defer until we have data, or revisit if we hit a race incident in `auto`.
