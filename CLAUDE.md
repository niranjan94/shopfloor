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
