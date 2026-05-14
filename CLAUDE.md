# Shopfloor

Single-package GitHub Action that runs a staged, human-gated AI delivery pipeline (`triage → spec → plan → implement → review`) using the Claude Agent SDK. The action source is plain TypeScript; the agents run in-process — no `claude-code-action` subprocess.

## Commands

```bash
pnpm build              # esbuild src/entry.ts -> dist/index.cjs (committed)
pnpm test               # vitest run
pnpm test:watch         # vitest watch mode
pnpm typecheck          # tsc --noEmit
pnpm format             # prettier --write .
pnpm format:check       # prettier --check .
```

The `dist/index.cjs` bundle is committed (standard JS Action pattern). CI fails on push if `pnpm build` would change it.

## Key Files

| File                             | Purpose                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `action.yml`                     | The GitHub Action manifest                                                              |
| `src/entry.ts`                   | Action entry point: reads inputs, resolves auth, builds adapters, calls orchestrator    |
| `src/orchestrator.ts`            | Route → run → apply cycle, mutex acquisition, failure reporting                         |
| `src/runners.ts`                 | Per-stage runner dispatch (triage/spec/plan/implement/review)                           |
| `src/state/machine.ts`           | Pure state machine (`resolveStage`, `resolveReviewOnly`, `computeStageFromLabels`)      |
| `src/state/labels.ts`            | Canonical `shopfloor:*` label names                                                     |
| `src/state/metadata.ts`          | Parse/upsert PR footer + issue HTML metadata blocks                                     |
| `src/github/adapter.ts`          | Every Octokit mutation Shopfloor performs                                               |
| `src/github/app-token.ts`        | Three-source auth (`preminted` → App-creds in-process minting → GITHUB_TOKEN fallback)  |
| `src/agents/claude.ts`           | Wraps `@anthropic-ai/claude-agent-sdk`; registers the `shopfloor` in-process MCP server |
| `src/stages/<stage>/runner.ts`   | Build prompt context, invoke agent, return typed decision                               |
| `src/stages/<stage>/apply.ts`    | Translate decision into GitHub mutations                                                |
| `src/stages/<stage>/decision.ts` | Zod schema for the agent's structured output                                            |
| `src/stages/<stage>/prompt.*.md` | Inlined-at-build-time prompt templates                                                  |
| `src/stages/review/aggregate.ts` | Dedupe + confidence-filter + verdict for the 4-lens review matrix                       |
| `src/tools/update-progress.ts`   | The one MCP tool exposed to the implement stage                                         |

## Stage Flow

`triage` (classify quick/medium/large) → `spec` (large only) → `plan` (medium/large) → `implement` → `review` (4 lenses in parallel: compliance, bugs, security, smells).

Controlled entirely by `shopfloor:*` labels on issues. Agents emit structured JSON (Zod-validated); only the apply step in each stage mutates GitHub.

## PR Metadata Convention

Stage PRs carry this footer (parsed by `parsePrMetadata` in `src/state/metadata.ts`):

```
---
Shopfloor-Issue: #<N>
Shopfloor-Stage: spec|plan|implement|review
Shopfloor-Review-Iteration: <N>     # implement PRs only
```

Issues carry a hidden HTML metadata block parsed by `parseIssueMetadata`:

```
<!-- shopfloor:metadata
Shopfloor-Slug: <slug>
Shopfloor-Spec-Path: <path>        # optional, when triage detects a supplied spec
Shopfloor-Plan-Path: <path>        # optional, when triage detects a supplied plan
-->
```

## review_only flow

When `review_only: "true"` and the event is a `pull_request` on a human-authored PR (no Shopfloor footer), the orchestrator calls `resolveReviewOnly` instead of `resolveStage`. The review runs stateless: iteration forced to 0, max-iterations forced to infinity, no label flips on the PR, no footer mutations. Each push is reviewed fresh. Suppressed when the PR is closed, draft, carries `shopfloor:skip-review`, or already carries Shopfloor metadata.

## Auth

Two surfaces (primary App for mutations; optional review App for code reviews). Each accepts three sources, in order:

1. **Preminted installation token** — `github_app_token` / `github_app_review_token`. Capped at GitHub's 60-minute installation-token TTL.
2. **App credentials** — `github_app_client_id` + `github_app_private_key` (or the `_review_` pair). Shopfloor mints the installation token in-process via `@octokit/auth-app`'s `authStrategy`, which refreshes transparently per request. **Preferred** for implement stages that may run longer than an hour.
3. **`github_token` fallback** — last resort. Emits a `::warning::` describing exactly which surface fell back. GITHUB_TOKEN mutations do not trigger downstream workflows and the token cannot APPROVE/REQUEST_CHANGES on a PR authored by `github-actions[bot]`.

`src/github/app-token.ts:resolveAuth` is the single decision point.

## Testing

Tests live in `test/` at repo root; run with `pnpm test`. End-to-end orchestrator tests are under `test/e2e/`. Per-stage unit tests live alongside their stages (`test/stages/*.test.ts`).

## GitHub Actions gotchas

Hard-earned lessons. Do not re-learn these:

- **`actions/checkout` persists a GITHUB_TOKEN extraheader credential by default.** That extraheader overrides any `x-access-token:$APP_TOKEN` embedded in a remote URL. With read-only caller perms the extraheader has no write scope, so a subsequent App-token push 403s with "Write access to repository not granted". Every `actions/checkout` step in this repo's workflows uses `with: persist-credentials: false` — keep it that way.
- **The GitHub App used to author PRs cannot review them.** GitHub forbids `REQUEST_CHANGES` / `APPROVE` on your own PR. Shopfloor's review aggregator posts through the optional `github_app_review_*` App so the reviewer identity is distinct from the PR author. The primary App still handles labels, comments, statuses, and PR-body edits.
- **Events caused by `secrets.GITHUB_TOKEN` never fire downstream workflows.** GitHub suppresses workflow triggers for any mutation authenticated by `GITHUB_TOKEN`. Shopfloor's primary App installation token does not have this restriction; this is why the App credentials are strongly preferred over the GITHUB_TOKEN fallback.
- **The Claude Agent SDK reads `import.meta.url`.** The esbuild config injects a banner and a `define` to make this work in the bundled CJS output. If you swap bundlers or change the loader settings, the SDK will throw at runtime.
