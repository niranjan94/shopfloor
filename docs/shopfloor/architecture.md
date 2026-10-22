# Shopfloor architecture

A plain-English tour of how Shopfloor is wired together. For the original v1 design spec (historical) see [`docs/superpowers/specs/2026-04-14-shopfloor-design.md`](../superpowers/specs/2026-04-14-shopfloor-design.md).

## The big idea

Shopfloor separates two things that are easy to conflate:

1. **Deciding what to do next.** Which stage should run? Which label flips? Which PR opens? This is pure state-machine logic. Shopfloor runs it in a deterministic TypeScript orchestrator that owns every GitHub mutation.
2. **Doing the creative work.** Writing a spec, writing a plan, writing code, reviewing code. This is what Claude is good at. Shopfloor invokes the Claude Agent SDK in-process and constrains each agent to emit one structured JSON object validated by a Zod schema.

Agents never mutate GitHub directly. The pipeline stays predictable even when an agent goes off-script.

## How v2 is wired

v2 ships as a single Node 24 GitHub Action (`niranjan94/shopfloor@v2`). There is no separate router package, no reusable workflow, and no `claude-code-action` subprocess. By default the action runs in `mode: auto` and resolves+executes the stage in one process; setting `mode: resolve` short-circuits after the state machine for use as a cheap router job, and `mode: execute` runs only stages permitted by the `stages` allowlist (fetching live labels before precheck to close the label-flip race). See [`examples/shopfloor-split-runners.yml`](../../examples/shopfloor-split-runners.yml) and [configuration.md](configuration.md#split-runner-mode) for the two-job pattern. The action's entry point is [`src/entry.ts`](../../src/entry.ts):

1. Read inputs (via `@actions/core`), parse with Zod (`src/config/inputs.ts`).
2. Resolve auth for the primary surface and the optional review surface (`src/github/app-token.ts`).
3. Build the GitHub adapter, the audit emitter, and the Claude agent adapter.
4. Call `runOrchestrator()` once with the event payload.

The orchestrator ([`src/orchestrator.ts`](../../src/orchestrator.ts)) is the route → run → apply loop:

1. Call the state machine to decide which stage (if any) this event should run.
2. Run preflight checks (closed issue, draft PR, skip-review label, mutex collision).
3. Acquire the stage's mutex label (`shopfloor:spec-running`, `plan-running`, `implementing`, `review-running`) when applicable.
4. Dispatch to the stage's runner (`src/runners.ts`).
5. The runner builds the prompt context, invokes the agent, and gets back a typed decision.
6. The stage's `apply.ts` translates that decision into GitHub mutations.
7. Release the mutex (even on failure) and emit an audit event.

## The state machine

Every event GitHub sends (`issues`, `issue_comment`, `pull_request`, `pull_request_review`) flows into [`resolveStage`](../../src/state/machine.ts) — a pure function of the event payload plus the issue or PR's current labels. It returns a `RouterDecision` whose `stage` is one of:

- `triage` — a new issue, or one whose `shopfloor:awaiting-info` label was just removed, or a retry after `shopfloor:failed:triage` was cleared
- `spec` — an issue carrying `shopfloor:needs-spec`
- `plan` — an issue carrying `shopfloor:needs-plan`
- `implement` — an issue carrying `shopfloor:needs-impl`, or a revision triggered by `pull_request_review` with `state=changes_requested` on an impl PR
- `review` — `synchronize` / `ready_for_review` on an impl PR (out of draft, not skip-review, not WIP), or `shopfloor:review-stuck` removed
- `none` — no action needed (the common case)

The state machine has no I/O. Every decision is a function of the event payload, the live label set, and the issue/PR body metadata. That makes it cheap to unit-test against fixture events.

For human-authored PRs reviewed via the `review_only: "true"` mode, [`resolveReviewOnly`](../../src/state/machine.ts) replaces `resolveStage`. It refuses to route when the PR carries Shopfloor metadata (so it never double-reviews a pipeline-authored PR), and otherwise returns `{stage: "review"}` for every push.

## The pipeline

```
issue opened
    │
    ▼
┌─────────┐
│ triage  │  classifies: quick / medium / large
│         │  OR asks clarifying questions (shopfloor:awaiting-info)
└────┬────┘
     │
     ├─ quick  ──────────────────────────────┐
     │                                       │
     ├─ medium ─────────────┐                 │
     │                      │                 │
     └─ large               │                 │
         │                  │                 │
         ▼                  │                 │
    ┌─────────┐              │                 │
    │  spec   │── PR ── human review ── merge ─┤
    └────┬────┘                                │
         │                                     │
         ▼                                     │
    ┌─────────┐                                 │
    │  plan   │── PR ── human review ── merge ──┤
    └────┬────┘                                 │
         │                                      │
         ▼                                      │
    ┌──────────┐                                │
    │ implement│── draft PR + pinned progress   │
    │          │   comment (updated via MCP)    │
    └─────┬────┘                                │
          │                                     │
          ▼                                     │
    ┌────────────┐                              │
    │ review (4) │  compliance / bugs /         │
    │            │  security / smells           │
    └─────┬──────┘                              │
          │                                     │
          ▼                                     │
    ┌──────────────┐                            │
    │ aggregator   │  APPROVE → human merge     │
    │              │  REQUEST_CHANGES → impl    │
    │              │  STUCK → human takeover    │
    └──────────────┘                            │
```

Every arrow between stages is a label flip, and every PR merge is a human checkpoint. Shopfloor never merges its own work.

## The agent/router boundary

Shopfloor's rule:

> Agents return structured JSON. The runtime consumes structured JSON and mutates GitHub.

Concretely:

- **Spec / plan / implement** agents write files to disk using their Write tool. They do not commit them. After the agent step finishes, the stage's `apply.ts` stages and commits the file with a Conventional Commits message and opens (or updates) the stage PR via [`GitHubAdapter.openStagePr`](../../src/github/adapter.ts).
- **Triage** does not write files. It returns a `TriageDecision` (complexity, classification reasoning, optional supplied spec/plan, optional clarification message). `apply.ts` posts a comment, flips labels, persists supplied artifact paths into the issue's metadata block, and optionally seeds a spec/plan PR.
- **Review lenses** do not post comments or mutate state. Each lens returns a `LensDecision` (verdict + findings). The aggregator dedupes overlapping findings, filters by confidence, and posts one combined review with batched inline comments.

The implement stage gets one tool that mutates GitHub: `mcp__shopfloor__update_progress`. It rewrites the body of a pinned "Shopfloor implementation in progress" comment with a markdown checklist. The MCP server is in-process (no subprocess) and registered by [`src/agents/claude.ts`](../../src/agents/claude.ts) using `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`. The agent cannot post new comments, delete anything, or touch labels through this tool — only update the one comment whose id is in its context.

## The review loop

The review stage is a 4-cell matrix: **compliance**, **bugs**, **security**, **smells**. Each cell is an independent agent invocation with its own prompt, model, budget, and timeout. All four read the same PR diff, spec, and plan; each stays in its lane.

All four lenses run in parallel via `Promise.allSettled`. After they all finish (or time out), the aggregator ([`src/stages/review/aggregate.ts`](../../src/stages/review/aggregate.ts)) runs:

1. Parses each lens's structured output. A failed lens is treated as "no clean verdict" and forces a `REQUEST_CHANGES`.
2. Concatenates findings across lenses.
3. Dedupes findings that point at the same path/line with > 75% token overlap. The higher-confidence one wins.
4. Filters out findings below the hardcoded confidence threshold (currently 60).
5. Decides the verdict:
   - **APPROVE** if every lens succeeded and returned `verdict: "clean"` AND nothing survived filtering.
   - **REQUEST_CHANGES** otherwise. The aggregator increments the PR body's `Shopfloor-Review-Iteration` counter and the impl agent sees both the counter and the review comments on its next run.
   - **Iteration cap** when the incremented counter would exceed `max_review_iterations`. Shopfloor applies `shopfloor:review-stuck` and stops looping — a human is expected to take over.

For human-authored PRs reviewed via `review_only: "true"`, iteration is forced to 0 and the cap is disabled. No counter is written to the PR body. No labels are applied. Each push gets a fresh review.

## The GitHub adapter

[`GitHubAdapter`](../../src/github/adapter.ts) wraps Octokit. It is the only place in v2 that performs GitHub mutations. The surface is small:

- Labels: `addLabel`, `removeLabel`, `replaceLabels` (atomic add+remove).
- Comments: `postIssueComment`, `updateComment`.
- PRs: `openStagePr` (idempotent open-or-update, appends the metadata footer), `updatePrBody`, `updatePr`, `findOpenPrByHead`, `findOpenImplPrForIssue`.
- Reviews: `postReview` (APPROVE / REQUEST_CHANGES / COMMENT with batched line comments).
- Statuses: `setReviewStatus` (commit status under the `shopfloor/review` context).
- Bootstrap: `listRepoLabels`, `createLabel` (idempotent).
- Reads: `getPr`, `listPrReviews`, `listPrReviewComments`, `listIssueComments`, `listChangedFilePatches`, `getFileSha`.
- Metadata: `upsertIssueMetadata` (the `<!-- shopfloor:metadata ... -->` HTML block on issues).

Every mutation flows through the App installation token resolved by `src/github/app-token.ts`.

## Concurrency and races

GitHub Actions concurrency groups serialize events on the same issue and the same PR. Cross-entity races (an event on an origin issue while one of its child PRs is mid-flight) are not serialized by GitHub Actions — concurrency expressions cannot parse the `Shopfloor-Issue` footer from a PR body.

Shopfloor tolerates these races with mutex labels (`shopfloor:spec-running`, `plan-running`, `implementing`, `review-running`). The orchestrator acquires the mutex before running a stage and releases it on completion (or failure). A concurrent run that finds the mutex already held aborts with `stage=none`. Crashes can leave a mutex orphaned — see [troubleshooting.md](troubleshooting.md) for the recovery.

## Escape hatches

- **`shopfloor:skip-review`** on the impl PR (or its origin issue) bypasses the review matrix entirely.
- **`shopfloor:wip`** suppresses review while present. Removing it (or pushing after un-drafting) re-triggers review.
- **`shopfloor:awaiting-info`** pauses the pipeline until removed.
- **`shopfloor:review-stuck`** pauses the pipeline after the review loop gives up. Removing it forces another review iteration.
- **`shopfloor:failed:<stage>`** pauses after an error. Removing it retries that stage.

All of these are human-controlled. The orchestrator never sets the modifier labels (`skip-review`, `wip`); it only sets the state labels (`failed:*`, `review-stuck`, `awaiting-info`) in response to terminal states.

## Further reading

- Configuration reference: [`configuration.md`](configuration.md)
- Operational playbook: [`workflows.md`](workflows.md)
- Troubleshooting: [`troubleshooting.md`](troubleshooting.md)
- FAQ: [`FAQ.md`](FAQ.md)
