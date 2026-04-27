# Shopfloor workflows and escape hatches

A practical guide to the paths an issue can take through Shopfloor, and the
levers a human can pull to redirect, pause, skip, or recover the pipeline.

> **Assumption throughout this document.** Shopfloor is configured with a
> trigger label. Concretely, the caller workflow sets
> `trigger_label: shopfloor:trigger`, so only issues that carry the
> `shopfloor:trigger` label enter the pipeline. Issues without it are
> ignored. Once an issue is in the pipeline (any `shopfloor:*` state label
> is present), removing the trigger label does not strand it — Shopfloor
> grandfathers in-flight work.

For the architecture-level "what is Shopfloor" tour, see
[architecture.md](architecture.md). This document is a reference for the
people who run it.

---

## Your first issue

The minimal happy path:

1. **Open a GitHub issue.** Title and body describe the change you want.
2. **Apply the `shopfloor:trigger` label.**
3. **Watch.** Shopfloor's triage runs, classifies the issue, and starts
   the pipeline. Every stage produces a PR for a human to review and
   merge — that is the whole loop.

A working "good enough" first issue body looks like this:

```markdown
We need rate limiting on the `/api/users` endpoint.

Right now an unauthenticated client can hit it 1000x/sec and there is no
backpressure. Use the existing rate-limit middleware from `lib/limit.ts`
and apply it at 60 req/min per IP.
```

That is it. Triage will read this, classify it as `medium` (multi-file
feature with a clear shape), and open a plan PR for you to merge.

---

## I want to…

A task-oriented index. The detailed sections follow.

| I want to…                                       | Where to look                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Understand which stages run for my issue         | [Section 1: The three happy paths](#1-the-three-happy-paths)                         |
| Skip the agent review on an impl PR              | [Section 3: Escape hatches](#3-escape-hatches) → `shopfloor:skip-review`             |
| Pause the pipeline mid-stage                     | [Section 3: Escape hatches](#3-escape-hatches) → close the issue, or use WIP         |
| Hand Shopfloor a spec or plan I already wrote    | [Section 4: Supplying a spec or plan up front](#4-supplying-a-spec-or-plan-up-front) |
| Recover from a failed stage                      | [Section 3: Escape hatches](#3-escape-hatches) → remove `shopfloor:failed:<stage>`   |
| Override triage's complexity classification      | [Section 3: Escape hatches](#3-escape-hatches) → change complexity by hand           |
| Force another review iteration                   | [Section 3: Escape hatches](#3-escape-hatches) → remove `shopfloor:review-stuck`     |
| Understand what every `shopfloor:*` label means  | [Section 2: The state labels](#2-the-state-labels)                                   |
| Read or edit the metadata blocks Shopfloor adds  | [Section 5: Issue and PR metadata blocks](#5-issue-and-pr-metadata-blocks)           |
| Know what happens when each stage's PR is merged | [Section 6: What happens at PR merge](#6-what-happens-at-pr-merge)                   |

---

## 1. The three happy paths

Triage classifies every issue as one of three complexity buckets. The
complexity decides how many stages run. The labels in the diagrams below
are applied automatically by Shopfloor's router as each stage finishes —
the only thing a human ever does on the happy path is **file the issue with
`shopfloor:trigger`** and **merge each stage's PR**. Every stage ends with
a human-merged PR — Shopfloor never merges its own work.

### Quick (1 PR)

```
human files issue with shopfloor:trigger
    │
    ▼
[triage]  ─── router applies: shopfloor:quick + shopfloor:needs-impl
    │
    ▼
[implement]  ─── opens impl PR, runs agent reviewers
    │
    ▼
human merges impl PR  ─── router: shopfloor:done, issue closed
```

For a typo, a config bump, a one-line bugfix. No spec, no plan.

### Medium (2 PRs)

```
human files issue with shopfloor:trigger
    │
    ▼
[triage]  ─── router applies: shopfloor:medium + shopfloor:needs-plan
    │
    ▼
[plan]  ─── opens plan PR
    │
human merges plan PR  ─── router applies: shopfloor:needs-impl
    │
    ▼
[implement]  ─── impl PR + agent review
    │
    ▼
human merges impl PR  ─── router: shopfloor:done, issue closed
```

For a small feature or refactor with a clear shape. The plan PR is the
human checkpoint.

### Large (3 PRs)

```
human files issue with shopfloor:trigger
    │
    ▼
[triage]  ─── router applies: shopfloor:large + shopfloor:needs-spec
    │
    ▼
[spec]  ─── opens spec PR
    │
human merges spec PR  ─── router applies: shopfloor:needs-plan
    │
    ▼
[plan]  ─── opens plan PR
    │
human merges plan PR  ─── router applies: shopfloor:needs-impl
    │
    ▼
[implement]  ─── impl PR + agent review
    │
    ▼
human merges impl PR  ─── router: shopfloor:done, issue closed
```

For new features, schema changes, or anything ambiguous. The spec PR is the
"are we building the right thing" checkpoint; the plan PR is the "is this
the right way to build it" checkpoint.

---

## 2. The state labels

These labels mark where an issue is in the pipeline. Exactly one of them is
present at a time once triage has finished.

| Label                                | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `shopfloor:triaging`                 | Triage job is running right now.                          |
| `shopfloor:awaiting-info`            | Triage asked clarifying questions. Pipeline paused.       |
| `shopfloor:needs-spec`               | Spec stage is queued.                                     |
| `shopfloor:spec-in-review`           | Spec PR is open and waiting for a human merge.            |
| `shopfloor:needs-plan`               | Plan stage is queued.                                     |
| `shopfloor:plan-in-review`           | Plan PR is open and waiting for a human merge.            |
| `shopfloor:needs-impl`               | Implement stage is queued.                                |
| `shopfloor:impl-in-review`           | Impl PR is open and waiting for a human merge.            |
| `shopfloor:needs-review`             | Agent review is queued on the impl PR.                    |
| `shopfloor:review-requested-changes` | The review loop asked the agent to revise.                |
| `shopfloor:review-approved`          | The review loop signed off.                               |
| `shopfloor:review-stuck`             | The review loop ran out of iterations without converging. |
| `shopfloor:done`                     | Pipeline finished and the origin issue was closed.        |

Three transient mutex labels mark "a job is running right now" so concurrent
events do not double-fire stages: `shopfloor:spec-running`,
`shopfloor:plan-running`, `shopfloor:implementing`. They are removed
automatically when the stage finishes. If a runner crashes mid-stage they
can be left behind — remove them by hand to unstick the pipeline.

Failure labels park the issue at the failed stage:
`shopfloor:failed:triage`, `shopfloor:failed:spec`, `shopfloor:failed:plan`,
`shopfloor:failed:implement`, `shopfloor:failed:review`. Remove the label to
retry that stage from where it failed.

---

## 3. Escape hatches

Every lever a human can pull, in one table.

| Action                                                   | What it does                                                                                                                                                                                          | When to reach for it                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `shopfloor:awaiting-info`                         | Re-runs triage with the issue's current body.                                                                                                                                                         | After you answer triage's clarifying questions.                                                                                                                                              |
| Remove `shopfloor:failed:<stage>`                        | Retries that stage.                                                                                                                                                                                   | After you have fixed whatever broke (a flaky API, a bad prompt, a missing secret).                                                                                                           |
| Apply `shopfloor:skip-review` to an impl PR or its issue | Skips the agent review matrix entirely. The PR moves straight to `shopfloor:impl-in-review` for human-only review.                                                                                    | When you trust the change and do not want to spend tokens on review.                                                                                                                         |
| Apply `shopfloor:wip` to an impl PR                      | Suppresses review until the label is removed. Removing it kicks off review.                                                                                                                           | Mid-implementation iterations when you are pushing fixups and do not want a review on each push. Only relevant when `use_draft_prs: false`; with draft PRs, just toggle draft state instead. |
| Convert an impl PR to draft (default mode)               | Same as `shopfloor:wip` for `use_draft_prs: true` setups. Drafts do not trigger review. Mark "ready for review" to resume.                                                                            | Same situations — pause review without losing the PR.                                                                                                                                        |
| Remove `shopfloor:review-stuck`                          | Forces another review iteration on the current impl PR.                                                                                                                                               | When you have manually pushed a fix and want the reviewers to take another look.                                                                                                             |
| Close the issue                                          | Every event for a closed issue resolves to `stage=none`. The pipeline freezes.                                                                                                                        | Pause anywhere, for any reason. Reopen to resume.                                                                                                                                            |
| Change a complexity label by hand                        | Retroactively reroutes the issue. Apply the new complexity (`shopfloor:quick`/`medium`/`large`) and the matching stage label (`shopfloor:needs-impl`/`needs-plan`/`needs-spec`). Remove the old ones. | When triage classified wrong and you want to redirect without re-triaging.                                                                                                                   |
| Request changes on a spec or plan PR                     | Triggers a revision run of that stage. The agent re-renders the prompt with your review comments.                                                                                                     | When the spec or plan is close but needs adjustments. Same shape as a normal code review.                                                                                                    |
| Remove the trigger label from an issue mid-pipeline      | Nothing — issues already in the pipeline are grandfathered.                                                                                                                                           | Not an escape hatch. Listed here so you do not expect it to be one.                                                                                                                          |

A reserved future label, `shopfloor:revise`, is bootstrapped onto the repo
but not yet wired to the state machine. Applying it today does nothing.

---

## 4. Supplying a spec or plan up front

If you already have a hand-written spec or plan, you can hand it to
Shopfloor and skip the corresponding stage. The triage agent looks for
four shapes, in priority order:

1. **An `## Shopfloor Spec` or `## Shopfloor Plan` H2 in the issue body.**
   Explicit and unambiguous — wins over agent judgment. The content under
   the heading becomes the spec or plan.
2. **A `Shopfloor-Spec-Path:` or `Shopfloor-Plan-Path:` metadata line**
   pointing at a file in the repo. Also explicit and unambiguous.
3. **Prose that reads like a spec or plan** — the body itself, with goals,
   non-goals, design decisions, etc. Detected by agent judgment.
4. **A path mentioned in passing** — e.g. "the design is at
   `docs/specs/oauth.md`" or "see `docs/plans/rollout.md` for steps". The
   agent opens the file and judges whether it actually looks like a spec
   or plan.

You only need an explicit marker (1 or 2) when your prose is ambiguous or
the path mention is buried in a long body. For most issues, "the design
is at `docs/specs/oauth.md`" is enough — triage will read the file and
route accordingly. Reach for the explicit forms when you want to
guarantee detection or override the agent's judgment.

### Example issue bodies

**Method 1 — inline H2 (full spec lives in the issue):**

```markdown
Add OAuth login.

## Shopfloor Spec

# Auth Spec

## Goals

- Sign-in with GitHub OAuth.
- Session lives in an encrypted cookie.

## Non-goals

- Multi-provider support in v1.

## Decisions

…
```

The router opens a seed PR with the content under `## Shopfloor Spec` as
`docs/shopfloor/specs/<N>-<slug>.md`, and the issue advances to
`shopfloor:spec-in-review`.

**Method 2 — explicit metadata line (spec already in the repo):**

```markdown
Add OAuth login. Design has been pre-written.

Shopfloor-Spec-Path: docs/specs/oauth.md
```

Triage validates the path, persists it into the issue's metadata block,
skips the spec stage, and advances to `shopfloor:needs-plan`.

**Method 3 — body itself reads like a spec:**

```markdown
# Add OAuth login

## Goals

Sign-in with GitHub OAuth, session in encrypted cookie.

## Non-goals

Multi-provider in v1.

## Design

…
```

No special markers — the agent reads the body, recognizes a spec shape,
and treats it like Method 1: opens a seed PR and advances to
`shopfloor:spec-in-review`.

**Method 4 — casual path mention:**

```markdown
Add OAuth login. The design is at `docs/specs/oauth.md`. Plan it out and
ship it.
```

The agent opens the file, decides it looks like a spec, persists the
path, and advances to `shopfloor:needs-plan` — the same outcome as
Method 2, just inferred rather than declared.

### What triage does once it detects an artifact

| Detected                                        | What happens                                                                                                                 | Resulting state                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Spec by path (any of methods 2 or 4)            | Path persisted into issue metadata. Spec stage skipped.                                                                      | `shopfloor:needs-plan`                                   |
| Plan by path (any of methods 2 or 4)            | Path persisted. Plan stage skipped.                                                                                          | `shopfloor:needs-impl`                                   |
| Both spec and plan by path                      | Both paths persisted. Both stages skipped.                                                                                   | `shopfloor:needs-impl`                                   |
| Spec inline (method 1, H2)                      | Router opens a seed PR `shopfloor/spec/<N>-<slug>` containing the extracted content as `docs/shopfloor/specs/<N>-<slug>.md`. | `shopfloor:spec-in-review`                               |
| Plan inline (method 1, H2)                      | Router opens a seed PR `shopfloor/plan/<N>-<slug>` with the content as `docs/shopfloor/plans/<N>-<slug>.md`.                 | `shopfloor:plan-in-review`                               |
| Whole body reads like a spec or plan (method 3) | Same as the corresponding inline H2 case.                                                                                    | `shopfloor:spec-in-review` or `shopfloor:plan-in-review` |

Path requirements when using `Shopfloor-Spec-Path:` /
`Shopfloor-Plan-Path:`: relative `.md` path under the repository root, no
`..` segments. Invalid paths surface as `shopfloor:failed:triage`.

### Cases where triage stops to ask

The triage agent returns `shopfloor:awaiting-info` when the body is
genuinely ambiguous:

- Both `## Shopfloor Spec` and `## Shopfloor Plan` inline in the same body
  — pick one; we do not yet stage seed PRs across both stages.
- An H2 marker **and** a path marker for the same stage — pick one.
- A path marker pointing at a file that does not exist.

### Promotion rule

If you supply any artifact on what would otherwise be a `quick`-classified
issue, triage promotes the complexity to `medium` so the plan-aware
implement prompt runs. The `quick` implement prompt does not expect a spec
or plan file to exist, so this avoids feeding it context it cannot use.

---

## 5. Issue and PR metadata blocks

Shopfloor uses two small metadata blocks to keep state across runs. You do
not normally edit them by hand, but it helps to know they exist when
something looks off.

### Issue body — `<!-- shopfloor:metadata` block

An HTML comment Shopfloor appends to the issue body at triage time. GitHub
hides it in the rendered view; you see it only if you edit the issue.
Recognized keys:

```
<!-- shopfloor:metadata
Shopfloor-Slug: add-oauth-login
Shopfloor-Spec-Path: docs/specs/oauth.md
Shopfloor-Plan-Path: docs/plans/oauth-rollout.md
-->
```

- `Shopfloor-Slug` — slug derived from the issue title, frozen at triage so
  later title edits do not strand branches and file paths.
- `Shopfloor-Spec-Path` / `Shopfloor-Plan-Path` — override paths from
  Section 4. When present, every stage reads spec/plan from these paths
  instead of the canonical `docs/shopfloor/{specs,plans}/<N>-<slug>.md`.

Unknown keys are ignored, so future Shopfloor versions can add fields
without breaking older parsers.

### PR body — Shopfloor footer

Every stage PR Shopfloor opens carries a footer the router reads back on
later events:

```
---
Shopfloor-Issue: #42
Shopfloor-Stage: implement
Shopfloor-Review-Iteration: 1
```

- `Shopfloor-Issue` — the origin issue. Used to resolve a PR event back to
  the issue whose labels drive the pipeline.
- `Shopfloor-Stage` — `spec` | `plan` | `implement` | `review`. Drives the
  on-merge transition and the choice of revision prompt.
- `Shopfloor-Review-Iteration` — only present on **implement** PRs. A
  counter the review loop uses to detect runaway feedback cycles and trip
  `shopfloor:review-stuck`. Spec and plan PRs do not carry this line.

Editing these footer lines by hand re-routes the PR. That is not a
documented feature — but if a stage label has gone genuinely wrong it is a
recovery option.

---

## 6. What happens at PR merge

| PR stage  | On merge                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| Spec      | Removes `shopfloor:spec-in-review`, adds `shopfloor:needs-plan`. Plan stage queues.                                 |
| Plan      | Removes `shopfloor:plan-in-review`, adds `shopfloor:needs-impl`. Implement stage queues.                            |
| Implement | Removes `shopfloor:impl-in-review` and `shopfloor:review-approved`, adds `shopfloor:done`, closes the origin issue. |

These transitions are idempotent. If the labels are already where they
should be, `handle-merge` no-ops.

---

## 7. Tuning and noisier knobs

The escape hatches in Section 3 cover per-issue control. A few knobs live
in your caller workflow's `with:` block instead, for when the defaults
are systematically wrong:

- **Reviewer too noisy.** Raise `review_confidence_threshold` (default
  `80`); raising to `90` or `95` filters out all but the most confident
  findings. Or disable a specific reviewer cell —
  `review_smells_enabled: false` is common if you already have a linter.
- **Review loop never converges.** Drop `max_review_iterations` to `1`
  or `2`. Shopfloor will give up faster and apply `shopfloor:review-stuck`
  for human takeover sooner.
- **Wrong model per stage.** Every stage has its own model input
  (`triage_model`, `spec_model`, `plan_model`, `impl_model`, and the four
  `review_*_model` inputs). See [configuration.md](configuration.md).
- **Draft PRs not desired.** Set `use_draft_prs: false`. Shopfloor uses
  `shopfloor:wip` as the draft equivalent. Caller workflows must subscribe
  to `pull_request: types: [unlabeled]` for review to fire after
  implementation completes — see [install.md](install.md#disabling-draft-prs).
