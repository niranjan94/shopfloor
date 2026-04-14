# Shopfloor architecture

A plain-English tour of how Shopfloor is wired together. For the full design spec see [`docs/superpowers/specs/2026-04-14-shopfloor-design.md`](../superpowers/specs/2026-04-14-shopfloor-design.md).

## The big idea

Shopfloor separates two things that are easy to conflate:

1. **Deciding what to do next.** Which stage should run? Which label flips? Which PR opens? This is pure state-machine logic. Shopfloor runs it in a deterministic TypeScript router that owns every GitHub mutation.
2. **Doing the creative work.** Writing a spec, writing a plan, writing code, reviewing code. This is what Claude is good at. Shopfloor runs these as sealed `claude-code-action` agents with no direct GitHub permissions — they read context and emit structured output, and nothing else.

Every agent stage produces one JSON object with a fixed schema. The router reads that JSON, posts the comment, flips the label, opens the PR, and decides which stage fires next. Agents never touch GitHub state directly, so pipeline behavior stays predictable even when an agent goes off-script.

## The state machine

Every event GitHub sends (`issues`, `issue_comment`, `pull_request`, `pull_request_review`) flows into the `route` job. That job calls `resolveStage` in [`router/src/state.ts`](../../router/src/state.ts), a pure function of the event payload plus the issue or PR's current labels. It returns one of:

- `triage` — a new issue, or a cleared `awaiting-info`
- `spec` — an issue with `shopfloor:needs-spec`
- `plan` — an issue with `shopfloor:needs-plan`
- `implement` — an issue with `shopfloor:needs-impl`, or a revision triggered by a `changes_requested` review
- `review` — a `synchronize` event on an implementation PR, or a cleared `review-stuck`
- `none` — no action needed (the common case)

The state machine has no I/O. Every decision is a function of the event payload and the labels in it. This is what makes it testable — the current unit suite exercises all branches with fixture events, including edge cases like draft PRs, the `skip-review` label, awaiting-info removal, and the branch-name slug derivation.

## The pipeline

```
issue opened
    │
    ▼
┌─────────┐
│ triage  │  classifies: quick / medium / large
│         │  OR asks clarifying questions
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
    │ implement│── PR (draft=false)             │
    │          │── progress comment (MCP)       │
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

Every arrow between stages is a label flip, and every PR merge is a human checkpoint. Shopfloor never advances past a PR until you merge it.

## The router/agent boundary

This is the rule that makes everything else work:

> Agents return structured JSON. Routers consume structured JSON and mutate GitHub.

Concretely:

- Spec/plan/implement agents **write files to disk** using their `Write` tool. They do not commit them. After the agent step finishes, the workflow's shell step stages and commits the file using the exact Conventional Commits message the plan specifies. Then a router helper opens the PR.
- Triage agents **do not write any file**. They only return JSON. The router helper `apply-triage-decision` turns that JSON into a comment and label flip.
- Reviewer agents **do not write any file or post any comment**. They only return JSON. The router helper `aggregate-review` combines the four reviewer outputs, dedupes overlapping comments, filters by confidence, and posts one combined review via the GitHub API.

The `.github/workflows/shopfloor.yml` file is thin wiring. It reads the event, calls `route`, dispatches the correct stage job, builds a context JSON via `jq`, asks the router's `render-prompt` helper to interpolate placeholders and merge `.claude/settings.json` permissions, runs `claude-code-action`, and hands the structured output back to router helpers that do the actual GitHub mutations.

## The review loop

The review stage is a 4-cell matrix (compliance, bugs, security, smells). Each cell runs as its own job with its own prompt, its own model, and its own turn budget. All four read the same PR diff, spec, and plan, but each stays in its lane.

After all four cells finish (or time out), the aggregator job runs with `if: always()`. It:

1. Parses each cell's structured output (treating empty output from a failed cell as "no findings").
2. Concatenates all comments.
3. Dedupes comments that point at the same path/line with >= 0.75 token overlap in their bodies. The higher-confidence comment wins.
4. Filters out comments below `review_confidence_threshold` (default 80).
5. Decides the verdict: if every cell returned `clean` AND nothing survived filtering, the verdict is `APPROVE`; otherwise `REQUEST_CHANGES`.
6. Posts one batched review on the PR (not four separate reviews).
7. Flips labels on the origin issue and sets the `shopfloor/review` commit status.

If the verdict is `REQUEST_CHANGES`, Shopfloor increments the PR body's `Shopfloor-Review-Iteration` counter. The implementation agent will see this counter and the review comments in its next run and revise accordingly. If the counter exceeds `max_review_iterations`, Shopfloor applies `shopfloor:review-stuck` and stops looping — a human is expected to take over.

## The router helpers

The router is a single TypeScript package at `router/`, bundled with esbuild into `router/dist/index.cjs` and shipped as a `node20` action at `router/action.yml`. It exposes one input (`helper:`) that dispatches to one of 13 helpers:

- `route` — resolves the stage from the event
- `bootstrap-labels` — creates missing `shopfloor:*` labels
- `open-stage-pr` — opens a PR with the metadata block in the body
- `advance-state` — flips labels on an issue or PR
- `report-failure` — posts a diagnostic comment and applies `shopfloor:failed:<stage>`
- `handle-merge` — on PR merge, flips the origin issue to the next stage (or closes it when impl merges)
- `create-progress-comment` — posts the initial "Shopfloor implementation in progress" comment
- `finalize-progress-comment` — rewrites the body with a terminal state
- `check-review-skip` — evaluates skip conditions for the review stage
- `aggregate-review` — the review loop's aggregator described above
- `render-prompt` — renders a prompt template with a context JSON, merging `.claude/settings.json` permissions into the allowed tools
- `apply-triage-decision` — turns the triage structured output into a comment and label flip
- `apply-impl-postwork` — after impl, updates the PR body/title and flips the next-state label

Every helper is unit-tested against a mocked octokit; the state machine and review aggregator are the most thoroughly covered because they are the highest-risk pieces.

## The Shopfloor MCP server

The implementation stage is the one agent that needs a way to update the world while it runs. It does this through a Shopfloor-namespaced MCP server at `mcp-servers/shopfloor-mcp/index.ts`.

The server exposes one tool: `update_progress`. Calling it replaces the body of a pre-existing "Shopfloor implementation in progress" comment on the impl PR with a new markdown body (typically a checklist of tasks with completion state). The server's GitHub credentials and comment id are injected via environment variables in the workflow, so the agent never sees raw secrets.

The agent cannot use this tool to post new comments, delete anything, or touch labels. It can only update the one comment whose id is in the env. This gives humans a live view of progress without adding a general-purpose "write to GitHub" tool to the agent's surface.

## Concurrency and races

Shopfloor uses a GitHub Actions `concurrency` group keyed by issue or PR number:

```yaml
concurrency:
  group: shopfloor-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
```

This serializes events on the same issue and the same PR. It does NOT serialize events that touch an origin issue and its child PRs simultaneously — GitHub Actions concurrency expressions cannot parse the `Shopfloor-Issue` metadata from a PR body. The state machine tolerates the resulting stale-label races by emitting `stage=none` when it sees inconsistent labels, so they degrade into "do nothing this run" rather than causing data corruption.

## Escape hatches

- **`shopfloor:skip-review`** on the impl PR (or its origin issue) bypasses the review matrix entirely.
- **`shopfloor:revise`** on an issue re-runs the current stage with fresh context. The router treats it as a one-shot trigger.
- **`shopfloor:awaiting-info`** pauses the pipeline until the label is removed.
- **`shopfloor:review-stuck`** pauses the pipeline after the review loop gives up. Removing it force-runs another review iteration.
- **`shopfloor:failed:<stage>`** pauses after an error. Removing it retries.

All of these are meant to be human-controlled. The router never sets them except in response to clearly terminal states.

## Further reading

- Full design spec: [`docs/superpowers/specs/2026-04-14-shopfloor-design.md`](../superpowers/specs/2026-04-14-shopfloor-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-04-14-shopfloor-v0.1-implementation.md`](../superpowers/plans/2026-04-14-shopfloor-v0.1-implementation.md)
- Configuration reference: [`configuration.md`](configuration.md)
- Troubleshooting: [`troubleshooting.md`](troubleshooting.md)
