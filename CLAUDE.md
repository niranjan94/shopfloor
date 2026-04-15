# Shopfloor

Reusable GitHub Actions workflow wrapping `claude-code-action` for a staged, human-gated AI delivery pipeline.

## Commands

```bash
pnpm build                             # Build all packages
pnpm --filter @shopfloor/router build  # Build router only (esbuild -> dist/index.cjs)
pnpm test                              # Run vitest (router/test + mcp-servers tests)
pnpm test:watch                        # Vitest watch mode
pnpm exec tsc --noEmit                 # Type-check root
pnpm -r typecheck                      # Type-check all packages
pnpm format                            # Prettier write
pnpm format:check                      # Prettier check
```

## Architecture

pnpm monorepo with two packages:

- `router/` — TypeScript GitHub Action; compiles to `router/dist/index.cjs` via esbuild. **The dist is committed** (standard JS Action pattern, reproducible from source).
- `mcp-servers/shopfloor-mcp/` — MCP server exposing Shopfloor tools.
- `prompts/` — Markdown prompt templates rendered by `router/src/helpers/render-prompt.ts`.

## Key Files

| File                              | Purpose                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `router/src/state.ts`             | State machine — maps GitHub events + labels -> stage decisions  |
| `router/src/index.ts`             | Action entry point; dispatches to helpers via `helper` input    |
| `router/src/github.ts`            | `GitHubAdapter` wrapping Octokit                                |
| `router/src/types.ts`             | All shared types (`RouterDecision`, `StateContext`, etc.)       |
| `router/src/helpers/`             | One file per action helper (advance-state, open-stage-pr, etc.) |
| `.github/workflows/shopfloor.yml` | The reusable workflow callers include                           |

## Stage Flow

`triage` -> `spec` (large only) -> `plan` (medium/large) -> `implement` -> `review`

Controlled entirely by `shopfloor:*` labels on issues. Agents never mutate GitHub state directly — the router TypeScript action does.

## PR Metadata Convention

Stage PRs must include these lines in the PR body (parsed by `parsePrMetadata` in `state.ts`):

```
Shopfloor-Issue: #<N>
Shopfloor-Stage: spec|plan|implement|review
Shopfloor-Review-Iteration: <N>
```

## Testing

Tests in `router/test/` use vitest with snapshot testing for helper outputs. Fixtures live in `router/test/fixtures/`. Run from repo root with `pnpm test`.

## GitHub Actions gotchas

Hard-earned lessons when editing `.github/workflows/shopfloor.yml`. Do not re-learn these:

- **`secrets` is not available in job-level `if:` expressions.** Trying `if: secrets.foo != ''` at the job level fails with "Unrecognized named-value: 'secrets'" even though the same expression works in `env:`, `with:`, `run:`, and step-level `if:`. Pattern: capture the secret into the route job's `env`, re-export it as a `steps.<id>.outputs.has_x` string output via a `run:` step, and gate downstream jobs on `needs.route.outputs.has_x == 'true'`. See the `has_review_app` flow in the `route` job for a working example.
- **Empty string is falsy in Actions expressions.** `cond && '' || 'x'` always evaluates to `'x'`, so the ternary idiom from JS doesn't work for empty-default cases. Use `run:` steps with outputs for conditional string values.
- **Template expressions inside `run:` scripts are parsed even in shell comments.** `# ${{ ... }}` inside a `run:` body is still evaluated by the Actions parser. Keep shell comments free of `${{ }}` or the workflow fails to parse.
- **`actions/checkout` persists a GITHUB_TOKEN extraheader credential by default.** That extraheader overrides any `x-access-token:$APP_TOKEN` embedded in a remote URL. With read-only caller perms the extraheader has no write scope, so a subsequent App-token push 403s with "Write access to repository not granted". Every `actions/checkout` step in this workflow uses `with: persist-credentials: false` to prevent this — keep it that way.
- **`$RUNNER_TEMP` inside claude-code-action's `claude_args` is not expanded.** claude-code-action's arg parser strips unexpanded env vars. Capture the path via `${{ runner.temp }}` in a prior `run:` step output and pass the resolved path.
- **The GitHub App itself is the PR author.** GitHub forbids `REQUEST_CHANGES` / `APPROVE` on your own PR. The review aggregator posts through a separate, optional review App (see `SHOPFLOOR_GITHUB_APP_REVIEW_*` secrets and the `review_github_token` plumbing in `router/src/index.ts`) so the reviewer identity is distinct from the PR author.
- **Events caused by `secrets.GITHUB_TOKEN` never fire downstream workflows.** GitHub suppresses workflow triggers for any mutation authenticated by `GITHUB_TOKEN`. Shopfloor mints an App installation token for every mutation that must trigger a downstream job (label flips, PR creation, commit push, review posting). `secrets.GITHUB_TOKEN` is reserved exclusively for claude-code-action (which needs only read scopes in our setup).
