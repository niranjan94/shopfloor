# Flexible Spec/Plan Supply at Triage

## Problem

Today, the only way to enter the Shopfloor pipeline at a non-triage stage is to apply `shopfloor:needs-plan` or `shopfloor:needs-impl` directly to the issue. That technically works, but it strands the user against three hardcoded conventions that are not documented in the issue-creation flow:

1. The spec must already exist at exactly `docs/shopfloor/specs/<issueNumber>-<slug>.md`.
2. The plan must already exist at exactly `docs/shopfloor/plans/<issueNumber>-<slug>.md`.
3. The slug must match `branchSlug(issue.title)` unless the user has manually added a `<!-- shopfloor:metadata\nShopfloor-Slug: ... -->` block to the issue body.

`prompts/plan.md` reads the spec via a hardcoded `@{{spec_file_path}}` substitution; `prompts/implement.md` does the same for both spec and plan. There is no mechanism for "the spec is at this other path" or "here is the spec content, please use it". A user with a spec already written has no clean way to skip ahead.

This spec describes a single entry point — `shopfloor:trigger` — through which all issues flow, with triage gaining responsibility for detecting and honoring pre-supplied specs and plans.

## Goals

- A user can file an issue with a spec or plan content **inline in the body** and Shopfloor materializes it into a stage PR for review without re-running the spec/plan agent.
- A user can file an issue **referencing an existing spec or plan file** at any path in the repo and Shopfloor skips the corresponding stage entirely, persisting the path so downstream stages read from it.
- A single entry point: `shopfloor:trigger` plus optional explicit markers in the body. No more `shopfloor:needs-plan` / `shopfloor:needs-impl` as user-facing labels.
- The change is backwards-compatible: legacy issues with no markers and no overrides continue to work exactly as before.

## Non-goals

- Supplying both a spec body and a plan body in the same issue (chains of seed PRs across stages — out of scope for v1).
- Bypassing the spec or plan PR review when the artifact comes from the body (always opens a PR, user clicks merge).
- Migrating the existing `needs-plan` / `needs-impl` label entry points away (they continue to work for users who set them directly).
- Letting downstream stages (plan, implement) accept supplied artifacts directly from a label change. All artifact-supply happens at triage.

## User-facing contract

### Issue authoring shapes

Any combination of these shapes is valid when filing an issue with `shopfloor:trigger`:

| Author intent                | What they put in the issue body                                                  | Triage behavior                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Just a problem               | Free-text description, no spec, no plan                                          | Existing flow — classify and route to the right entry stage by complexity                                 |
| Spec already in repo         | Mention path inline (any phrasing) or use `Shopfloor-Spec-Path: <path>` marker   | No spec PR. Persist path in issue metadata. Route directly to `needs-plan`                               |
| Plan already in repo         | Mention path inline or use `Shopfloor-Plan-Path: <path>` marker                  | No spec or plan PR. Persist path(s) in issue metadata. Route directly to `needs-impl`                    |
| Spec inline in body          | Spec content under an `## Shopfloor Spec` H2, or LLM detects it as a spec        | Open a seed spec PR pre-populated with the content. Route to `shopfloor:spec-in-review`. Normal cycle.   |
| Plan inline in body          | Plan content under an `## Shopfloor Plan` H2, or LLM detects it as a plan        | Open a seed plan PR pre-populated. Route to `shopfloor:plan-in-review`. Normal cycle.                    |

### Marker semantics

- **Explicit markers always win.** `## Shopfloor Spec` H2 sections, `## Shopfloor Plan` H2 sections, `Shopfloor-Spec-Path: <path>` lines, and `Shopfloor-Plan-Path: <path>` lines override LLM judgment unconditionally.
- **Without markers, the triage agent uses its judgment.** Body looks like a spec → treat as supplied spec. Body mentions a `.md` path that reads like a spec → treat as supplied spec by path.
- **Conservative defaults.** Body discusses specs without containing one ("we need a spec for X") does NOT trigger detection.

### Disallowed combinations

The triage agent emits `needs_clarification` (with a question naming the conflict) when:

- Both spec body and plan body are inline in the same issue (would require chained seed PRs).
- Body has both an `## Shopfloor Spec` H2 and a `Shopfloor-Spec-Path:` marker (ambiguous).
- A `Shopfloor-*-Path:` marker references a file that does not exist on `main`.

### Allowed mixed combinations

- `Shopfloor-Spec-Path: <a>` + `Shopfloor-Plan-Path: <b>` — both persisted; route to `needs-impl`.
- `Shopfloor-Spec-Path: <a>` + `## Shopfloor Plan` body — spec path persisted; seed plan PR opened.

## Internal design

### 1. Triage agent (`prompts/triage.md`)

The triage agent already has `Read`, `Glob`, `Grep`, `WebFetch`. Detection is mostly a prompt + output-schema change.

**New `<artifact_detection>` section** added after the classification rubric, instructing the agent to detect supplied artifacts using the marker rules above and to read referenced paths to confirm they exist and look like the artifact type claimed.

**Output schema additions:**

```json
{
  "status": "classified" | "needs_clarification",
  "complexity": "quick" | "medium" | "large",
  "rationale": "...",
  "clarifying_questions": ["..."],
  "supplied_spec": {
    "source": "body" | "path",
    "path": "string — only when source=path",
    "content": "string — only when source=body"
  } | null,
  "supplied_plan": {
    "source": "body" | "path",
    "path": "string — only when source=path",
    "content": "string — only when source=body"
  } | null
}
```

`supplied_spec` and `supplied_plan` default to `null`. Legacy prompt versions and minor prompt drift remain compatible because the agent simply omits the new keys when no artifacts are detected.

### 2. `apply-triage-decision` branching

The helper currently writes the slug, posts a classification comment, and advances state to `needs-spec` / `needs-plan` / `needs-impl` based on complexity. The new behavior keeps slug and comment unchanged; the routing branch becomes a decision matrix:

| `supplied_spec` | `supplied_plan` | Action                                                                                              | Final state label             |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| null            | null            | Existing flow — route by complexity                                                                  | `needs-spec` / `needs-plan` / `needs-impl` |
| `path`          | null            | Persist `Shopfloor-Spec-Path: <path>` in issue metadata. Skip spec stage.                          | `needs-plan`                  |
| null            | `path`          | Persist `Shopfloor-Plan-Path: <path>` in issue metadata. Skip spec and plan stages.                | `needs-impl`                  |
| `path`          | `path`          | Persist both paths. Skip spec and plan stages.                                                      | `needs-impl`                  |
| `body`          | null            | Open seed spec PR with content (Section 3).                                                         | `spec-in-review`              |
| null            | `body`          | Open seed plan PR with content (no spec, medium-style flow).                                        | `plan-in-review`              |
| `path`          | `body`          | Persist spec path. Open seed plan PR with body content.                                              | `plan-in-review`              |
| `body`          | `path`          | Disallowed — triage emits `needs_clarification` instead.                                            | n/a                           |
| `body`          | `body`          | Disallowed — triage emits `needs_clarification` instead.                                            | n/a                           |

**Complexity promotion.** When `supplied_spec` or `supplied_plan` is present and the agent classified the issue as `quick`, `apply-triage-decision` writes `shopfloor:medium` instead of `shopfloor:quick`. `implement-quick.md` does not expect a spec or plan file to exist; promoting to `medium` selects the plan-aware implement prompt. The classification comment posted to the issue notes the promotion explicitly.

**Comment posted to the issue** is updated to be honest about which path triage took. Examples:

- "Triage classified as `medium`. Found a spec at `docs/specs/auth.md`; skipping the spec stage and going straight to plan."
- "Triage classified as `large`. The body contains a spec — opening a seed spec PR for review."
- "Triage classified as `large`. Found spec at `docs/specs/auth.md` and plan at `docs/plans/auth.md`; skipping straight to implementation."

**Pre-existing label guard** (`UNEXPECTED_TRIAGE_LABELS`) still runs unchanged — if the issue already carries a state label, triage refuses to re-run.

### 3. Seed PR helper (`router/src/helpers/seed-stage-pr.ts`)

A new helper opens a stage PR seeded with content extracted by the triage agent. Triage helper invokes it; no workflow YAML changes needed.

**Why router-side, not workflow-side.** Today's spec/plan stages rely on a runner checkout because the agent uses Read/Write to author the file. The seed flow has no agent — content arrives pre-formed in triage's structured output. The Git Data + Contents APIs let us create the branch and commit without a checkout, all inside the router code.

**Helper shape:**

```ts
interface SeedStagePrParams {
  issueNumber: number;
  slug: string;
  stage: "spec" | "plan";
  content: string;
  baseBranch: string;
  prTitle: string;
  prSummary: string;
}

interface SeedStagePrResult {
  prNumber: number;
  url: string;
  branchName: string;
  filePath: string;
}

async function seedStagePr(adapter, params): Promise<SeedStagePrResult>;
```

**Steps:**

1. Compute canonical `branchName` (`shopfloor/<stage>/<N>-<slug>`) and `filePath` (`docs/shopfloor/<stage>s/<N>-<slug>.md`).
2. Read `baseBranch`'s HEAD SHA via `git/refs/heads/<base>`.
3. Create branch via `git/refs` POST. On 422 (already exists) treat as retry and continue.
4. Upsert file at `filePath` on the branch via `repos.createOrUpdateFileContents`. On retry path (file exists), read existing blob SHA via `repos.getContent` and pass it for in-place update.
5. Reuse `openStagePr` to upsert the PR. The metadata footer is generated automatically.
6. Return PR number, URL, branch name, file path.

**Idempotency.** Steps 3-5 are individually idempotent. Re-running `apply-triage-decision` after a partial failure (e.g. branch created but file write failed) heals the state.

**Seed PR body shape:**

```
This PR was seeded from issue #<N>. The <spec|plan> content was extracted from the issue body during triage; review and edit before merging to advance the pipeline.

Closes #<N>

---
Shopfloor-Issue: #<N>
Shopfloor-Stage: <spec|plan>
```

The metadata footer matches today's convention so `parsePrMetadata` keeps working unchanged.

### 4. Issue metadata extensions (`router/src/state.ts`, `router/src/helpers/upsert-issue-metadata.ts`)

The existing `<!-- shopfloor:metadata ... -->` block gains two optional keys:

```html
<!-- shopfloor:metadata
Shopfloor-Slug: my-slug
Shopfloor-Spec-Path: docs/specs/my-spec.md
Shopfloor-Plan-Path: docs/plans/my-plan.md
-->
```

Path entries appear only when triage detected a path-supplied artifact.

**Parser change** (`parseIssueMetadata`):

```ts
export interface IssueMetadata {
  slug?: string;
  specPath?: string;
  planPath?: string;
}
```

Two more line-based regex matches added. Unknown keys continue to be ignored, so legacy issues parse cleanly.

**Writer change** (`upsertIssueMetadata`): extend signature with optional `specPath` / `planPath`. Unset values leave existing lines untouched.

**Path validation rules**, applied at consumption time (not parse time, so legacy issues never break loading):

- Must be a relative path with no `..` segments.
- Must point at a `.md` file.
- Must exist on `main` at the moment the consuming helper resolves it.

### 5. `resolveArtifactPaths` helper

A new helper at `router/src/helpers/resolve-artifact-paths.ts`:

```ts
export function resolveArtifactPaths(
  issueNumber: number,
  slug: string,
  metadata: IssueMetadata | null,
): { specFilePath: string; planFilePath: string } {
  return {
    specFilePath: metadata?.specPath ?? `docs/shopfloor/specs/${issueNumber}-${slug}.md`,
    planFilePath: metadata?.planPath ?? `docs/shopfloor/plans/${issueNumber}-${slug}.md`,
  };
}
```

Every existing site that builds canonical paths routes through this helper. Single source of truth, single test target for override semantics.

**Sites that consume it:**

| Site                                                  | Resolution today                                                        | Change                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `computeStageFromLabels` (`state.ts`)                 | Builds canonical path from issue title/metadata                         | Calls `resolveArtifactPaths` with `parseIssueMetadata(issue.body)`.                                                    |
| `resolvePullRequestReviewEvent` impl-revision branch  | Reconstructs path from impl branch ref                                  | Unchanged. Override applied later by `build-revision-context` (it already does an issue fetch).                        |
| `resolvePullRequestReviewEvent` spec/plan-revision    | Reconstructs path from stage branch ref                                 | Unchanged. Spec/plan revision PRs only exist for canonical-path flow.                                                  |
| `build-revision-context.ts`                           | Receives `specFilePath` / `planFilePath` from router decision           | Fetches issue, applies override via `resolveArtifactPaths` before invoking the agent.                                  |
| `apply-impl-postwork.ts`                              | Reads `specFilePath` / `planFilePath` from inputs                       | Same pattern: respect issue metadata override before consuming.                                                        |
| `handle-merge.ts`                                     | Doesn't touch file paths — only label transitions                        | No change.                                                                                                              |
| `bootstrap-labels.ts`                                 | Doesn't touch paths                                                     | No change.                                                                                                              |
| `render-prompt.ts`                                    | Substitutes `{{spec_file_path}}` / `{{plan_file_path}}`                 | No change — templates whatever path the caller passes in.                                                              |

`state.ts` stays pure: `issue.body` is part of the payload, so no I/O is added.

## Edge cases and failure modes

| Case                                                                | Behavior                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Path supplied but file missing on main at triage time               | Triage agent confirms existence via Read; emits `needs_clarification` if missing.                                                            |
| Path validates at triage, file deleted before consuming stage runs  | Plan/impl helper hits 404, throws clear error; `report-failure` lands `shopfloor:failed:<stage>`. User restores or fixes metadata to retry.  |
| User edits metadata block manually after triage                     | Allowed. Every consuming helper re-parses on each invocation.                                                                                |
| Path uses `..`, is absolute, or doesn't end in `.md`                | Rejected at consumption time by `resolveArtifactPaths` validation. Same failure path as above.                                               |
| Path equals canonical path                                          | No-op override. Resolves to same string canonical builder would produce.                                                                     |
| `quick` complexity + supplied artifact                              | Promoted to `medium` for label-writing. Comment notes the promotion.                                                                         |
| User edits override file via direct push to main between stages     | Fine. Plan/impl read latest from main at agent run-time.                                                                                     |
| H2 marker conflicts with `Shopfloor-*-Path:` marker for same stage  | Triage emits `needs_clarification` asking user to pick one.                                                                                  |
| Seed PR collision (branch exists from previous failed triage)       | Helper is idempotent (Section 3, point 9); existing branch + same content = no-op, PR reused; existing branch + different content = new commit, PR refreshed. |
| User closes the issue mid-seed-PR-flow                              | Issue-closed gate (`state.ts:228-230`) shuts down further routing. Seed PR persists; user cleans up manually.                                |
| `shopfloor:failed:triage` retry semantics                           | Re-runs `apply-triage-decision` with fresh issue read. Idempotent seed helper heals partial state.                                           |

## Testing strategy

Tests live in `router/test/` using vitest with snapshot fixtures (existing pattern).

**Pure-function coverage:**

- `parseIssueMetadata` w/ new keys: slug only, slug + spec path, slug + plan path, slug + both, malformed, legacy (no block).
- `upsertIssueMetadata` w/ new keys: add to existing, add to fresh, unrelated-keys preservation, idempotent re-write.
- `resolveArtifactPaths`: no metadata → canonical, spec-only override, plan-only override, both, validation rejection.
- `computeStageFromLabels` w/ override metadata: each branch (`needs-spec` / `needs-plan` / `needs-impl`) returns override when present.

**`apply-triage-decision` branching:**

A test per row of the decision matrix above, mocking `GitHubAdapter`. Includes complexity-promotion and a failure-path test verifying the label flip never runs when the seed helper throws.

**`seed-stage-pr` helper:**

- Happy path: branch + commit + PR.
- Branch-already-exists retry path.
- Idempotent re-call with same content.
- Adapter error surfaces untouched.

**`build-revision-context`:**

- No override metadata → canonical paths (regression).
- Spec override → impl-revision agent receives override path.

**Integration-style snapshots:**

- `router/test/fixtures/triage/issue-with-spec-body.json` — body with `## Shopfloor Spec` H2.
- `router/test/fixtures/triage/issue-with-spec-path.json` — body with `Shopfloor-Spec-Path:` marker.
- Snapshot the resulting label set, metadata block, comment body, and seed-PR call shape.

**Out of scope for tests:** real GitHub API interactions and end-to-end workflow runs. Mock-the-adapter pattern unchanged.

## Migration

- Existing issues with no markers and no override metadata are unaffected. The new code paths only activate when triage reports `supplied_spec` or `supplied_plan`.
- Existing direct uses of `shopfloor:needs-plan` / `shopfloor:needs-impl` continue to work as documented today; this design adds an alternative entry path through triage but does not remove the label-only path.
- The metadata block schema is open: pre-existing metadata blocks parse cleanly, and the new keys are additive.

## Open questions

None blocking. The disallowed-combination list (Section "User-facing contract") is conservative for v1 and may relax later if chained seed PRs become valuable.
