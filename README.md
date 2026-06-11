# Shopfloor

> **Early alpha -- under active development.** APIs, workflow inputs, label conventions, and prompt templates may change without notice between commits. Pin to a specific commit SHA if you use this today, and expect breaking changes. Bug reports and feedback are welcome via [Issues](https://github.com/niranjan94/shopfloor/issues).

A GitHub Action that runs a staged, human-gated AI delivery pipeline against your repository. Drop it into a workflow and every new issue is routed through **triage → spec → plan → implement → review**, with a human approving each stage by merging the pull request it produces.

Shopfloor is deliberately boring where it counts: a pure TypeScript state machine owns every label flip, comment, and PR mutation. Agents only emit structured JSON. That keeps GitHub state predictable, stage behaviour auditable, and the blast radius of a confused model small.

> **v2:** Shopfloor is now a single GitHub Action (`niranjan94/shopfloor@v2`) backed by the Claude Agent SDK. v1's reusable workflow remains available at `@v1`; see [Migrating from v1](#migrating-from-v1) below.

## How it works

1. You open an issue. The triage agent classifies it `quick`, `medium`, or `large`, or asks clarifying questions and pauses.
2. The orchestrator advances the issue through the stages appropriate for its complexity:

   | Complexity | Flow                             |
   | ---------- | -------------------------------- |
   | `quick`    | implement → review               |
   | `medium`   | plan → implement → review        |
   | `large`    | spec → plan → implement → review |

3. Spec and plan each open a pull request against your default branch containing a single markdown file. These stages are **human-only review gates**: no agent matrix, no confidence scoring, just you reading what the agent wrote. Push edits to the branch directly if you want to tweak it, apply `shopfloor:revise` to re-run the stage against fresh context, or merge to accept. Merging flips the next label and fires the next stage.
4. The implementation agent commits on its own branch, streams progress into a single pinned PR comment, and flips the PR out of draft when done.
5. Implementation review is a four-cell matrix: **compliance, bugs, security, code smells**. Each cell runs independently, then an aggregator posts one combined review. `APPROVE` when every cell is clean; `REQUEST_CHANGES` with batched line comments otherwise. If the loop cannot converge inside `max_review_iterations` rounds, Shopfloor applies `shopfloor:review-stuck` and hands the PR back to a human.
6. You merge the implementation PR. Shopfloor closes the origin issue with `shopfloor:done`.

## Repository layout

| Path                    | What lives there                                                        |
| ----------------------- | ----------------------------------------------------------------------- |
| `action.yml`            | The GitHub Action manifest                                              |
| `examples/`             | Sample caller workflow (`examples/shopfloor.yml`)                       |
| `src/`                  | Action source: state machine, orchestrator, stages, adapters, agent SDK |
| `src/stages/*/prompt.*` | Stage prompt templates (inlined into the bundle at build time)          |
| `dist/index.cjs`        | Committed action bundle (reproducible from `src/` via `pnpm build`)     |
| `docs/shopfloor/`       | Install, configuration, architecture, troubleshooting, FAQ              |

## Before you install: read the source

Shopfloor runs inside your repository with write access to branches, pull requests, issues, labels, and commit statuses. It also spawns Claude agents that can execute Bash on your CI runners. That is a lot of authority to hand a third-party action, so Shopfloor is [MIT licensed](LICENSE) and fully open source precisely so you can verify what it does before you turn it on.

The entire runtime is a few thousand lines of TypeScript. You can read it in an afternoon. We recommend you do, in this order:

1. [`src/state/machine.ts`](src/state/machine.ts) is the pure state machine. Every stage decision lives here.
2. [`src/github/adapter.ts`](src/github/adapter.ts) is every GitHub mutation Shopfloor performs. If it writes to your repository, it is in this file.
3. [`src/orchestrator.ts`](src/orchestrator.ts) is the route → run → apply loop, plus precheck and failure reporting.
4. [`action.yml`](action.yml) and [`examples/shopfloor.yml`](examples/shopfloor.yml) are the wiring: which model runs, which secrets are forwarded.
5. [`src/stages/`](src/stages/) is what the LLM sees at each stage, including inlined `prompt.system.md` / `prompt.user.md.tmpl` files.

Two more precautions before production use:

- **Audit the bundled artifact.** `dist/index.cjs` is the compiled action that actually executes on your runners. It is committed (standard practice for JS actions) and reproducible from `src/` via `pnpm build`. Diff against the committed file to confirm.
- **Pin to a verified commit SHA, not a moving tag.** The `@v2` tag in the snippet below is convenient for evaluation but a supply-chain risk in production. Replace it with a 40-character SHA you have inspected, and let Dependabot or Renovate propose bumps you review like any other dependency.

If you are not willing to do any of the above, Shopfloor is probably not a good fit for your threat model. Use it on scratch repositories first.

## Install

The short version. The full walkthrough, including the custom GitHub App setup, lives in [`docs/shopfloor/install.md`](docs/shopfloor/install.md).

1. **Install two GitHub Apps on the repository.**
   - The [Claude GitHub App](https://github.com/apps/claude) gives the agents an identity to read issues, push branches, and open PRs under.
   - A **custom GitHub App you own** is used by the router to mint tokens for label flips and PR pushes. **Strongly recommended.** GitHub suppresses workflow triggers for events caused by `secrets.GITHUB_TOKEN`, so without an App-minted token the pipeline runs triage once and then stalls at the first label flip. See the install guide for the required app permissions and the secrets to export from it. If you skip this, Shopfloor falls back to the workflow's default `GITHUB_TOKEN` — useful for evaluation, but the cascading-trigger and self-review limitations make it unsuitable for real use.

2. **Add secrets** to the repository at **Settings → Secrets and variables → Actions**:

   | Secret                                                               | Needed for                                                 |
   | -------------------------------------------------------------------- | ---------------------------------------------------------- |
   | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`                     | Agent auth (or the Bedrock / Vertex / Foundry equivalents) |
   | `SHOPFLOOR_GITHUB_APP_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_PRIVATE_KEY` | **Required.** The custom router App's credentials          |
   | `SSH_SIGNING_KEY`                                                    | Optional. Signed commits from Shopfloor's branches         |

3. **Create `.github/workflows/shopfloor.yml`** in your repository. The full sample lives in [`examples/shopfloor.yml`](examples/shopfloor.yml); the minimum is:

   ```yaml
   name: Shopfloor
   on:
     issues:
       types: [opened, labeled, unlabeled]
     issue_comment:
       types: [created]
     pull_request:
       types:
         [opened, synchronize, ready_for_review, closed, labeled, unlabeled]
     pull_request_review:
       types: [submitted]

   permissions:
     contents: read
     issues: read
     pull-requests: read

   jobs:
     shopfloor:
       runs-on: ubuntu-latest
       steps:
         - name: Run Shopfloor
           # SECURITY: @v2 is a moving tag. For production, pin to a 40-char SHA
           # you have audited. See "Before you install" above.
           uses: niranjan94/shopfloor@v2
           with:
             anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
             github_app_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_CLIENT_ID }}
             github_app_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY }}
   ```

   Shopfloor mints the App installation token in-process from the client id and private key, and refreshes it transparently before the one-hour TTL expires. Implement stages that outrun the TTL stay authenticated for the whole run.

Open an issue and watch it go. The first run bootstraps all `shopfloor:*` labels.

4. **Exclude the spec and plan directories from your linters, formatters, and test runners.** Shopfloor writes spec and plan markdown to `docs/shopfloor/specs/` and `docs/shopfloor/plans/`, and opens a pull request containing only that one file. The spec and plan agents are design-only stages with no shell access, so they cannot run project formatters over what they produce. If your repository runs Prettier, markdownlint, Vale, `cspell`, or similar on CI, add both paths to each tool's ignore list so the spec/plan PRs do not fail checks on stylistic differences. Examples:
   - `.prettierignore`: `docs/shopfloor/specs/` and `docs/shopfloor/plans/`
   - `.markdownlintignore` (or `ignores` in `.markdownlint.json`): same two paths
   - Vale `StylesPath` / `[*.md]` block: exclude the two paths
   - Any custom "docs lint" job in CI: skip the two paths

   You do **not** need to exclude them from the implementation stage's tests -- implementation PRs include real code changes that should run the full suite. This exclusion is for the spec and plan PRs only.

## Configuration

Every stage's model, effort, turn budget, timeout, tool allowlist, review confidence threshold, and iteration cap is exposed as an input on the reusable workflow. The full reference lives in [`docs/shopfloor/configuration.md`](docs/shopfloor/configuration.md).

Common overrides:

```yaml
- uses: niranjan94/shopfloor@v2
  with:
    triage_model: claude-haiku
    impl_model: claude-opus
    max_review_iterations: 2
    # Only enter the pipeline for issues carrying this label.
    trigger_label: shopfloor
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    github_app_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_CLIENT_ID }}
    github_app_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY }}
```

### Per-stage runners (advanced)

By default Shopfloor runs as a single GitHub Actions job per event (`mode: auto`).
If you want different stages to run on different runners — typically a small
runner for triage/spec/plan/review and a beefier one for implement — split the
workflow into two jobs using the `mode: resolve` / `mode: execute` pattern.

See [`examples/shopfloor-split-runners.yml`](examples/shopfloor-split-runners.yml) for a copy-pasteable workflow.

Inputs:

| Input    | Default | Notes                                                                                                                            |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `auto`  | `auto` (single-job, current behavior), `resolve` (route only, emit `stage` output), `execute` (run a stage if `stages` permits). |
| `stages` | `""`    | Comma-separated allowlist for `mode: execute`. Empty means all stages.                                                           |

Outputs (always set):

| Output     | Notes                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `stage`    | `triage`, `spec`, `plan`, `implement`, `review`, or `none`.                    |
| `executed` | `"true"` if a stage ran end-to-end, `"false"` for resolve / filter / precheck. |

Notes:

- Execute mode fetches live issue labels from the GitHub API before precheck,
  not the event payload's snapshot, to close the label-flip race window between
  the resolve and execute jobs.
- Use client-credential auth (`github_app_client_id` + `github_app_private_key`)
  in split mode — preminted installation tokens have a 60-minute TTL that the
  resolve→execute gap eats into.
- Always set a workflow-level `concurrency:` group keyed on issue number when
  splitting; see the example.

### Agent provider (Claude or Codex)

Shopfloor runs every stage through one agent backend, selected globally with the `agent_provider` input:

- `claude` (default) drives the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Authenticate with `anthropic_api_key` or `claude_code_oauth_token`.
- `codex` drives OpenAI's Codex via [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk). Authenticate with one of:
  - `openai_api_key` — an OpenAI API key. **Recommended**, especially for long implement stages: it does not expire mid-run.
  - `codex_auth_json` — the verbatim contents of a ChatGPT-managed `auth.json`. Re-seeded into a run-scoped temporary `CODEX_HOME` on every run; any in-run token refresh is discarded. A token that expires mid-run surfaces as a Codex auth failure, so re-seeding a stale token is a manual/ops concern. Prefer `openai_api_key` for long runs.

Selection is global; per-stage mixing (Claude for one stage, Codex for another) is not supported. The per-stage `*_model` and `*_effort` inputs are provider-neutral strings passed straight through, so set them to the chosen provider's model ids. Codex does not surface cost or turn caps, so `*_max_budget_usd` and `*_max_turns` are accepted and ignored (with a warning) under `agent_provider: codex`. The GitHub auth surfaces below are identical for both providers.

See [`examples/shopfloor-codex.yml`](examples/shopfloor-codex.yml) for a copy-pasteable Codex workflow.

| Input                       | Default           | Notes                                                                    |
| --------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `agent_provider`            | `claude`          | `claude` or `codex`.                                                     |
| `openai_api_key`            | `""`              | Codex auth (recommended). One of this or `codex_auth_json` is required.  |
| `codex_auth_json`           | `""`              | Codex auth via a ChatGPT `auth.json`. Re-seeded each run; no refresh.    |
| `codex_sandbox_mode`        | `workspace-write` | Codex sandbox: `read-only`, `workspace-write`, or `danger-full-access`.  |
| `codex_approval_policy`     | `never`           | Codex approvals: `never`, `on-request`, `on-failure`, or `untrusted`.    |
| `codex_network_access`      | `true`            | Whether the `workspace-write` sandbox may reach the network.             |
| `codex_skip_git_repo_check` | `true`            | Skip Codex's own git precheck (Shopfloor guarantees a checkout).         |

### Authentication modes

Shopfloor resolves credentials for two surfaces — the primary App (every mutation except code reviews) and the optional review App (code reviews posted on Shopfloor-authored PRs) — independently. For each surface, the first source set wins, evaluated in this order:

1. **Preminted installation token.** `github_app_token` and/or `github_app_review_token`, typically minted by a prior `actions/create-github-app-token@v2` step. Convenient if you already mint elsewhere, but the token is static for the run and capped at GitHub's 60-minute installation-token TTL — long implement stages may outlive it.
2. **App client id + private key (preferred for production).** `github_app_client_id` + `github_app_private_key` (primary) and/or `github_app_review_client_id` + `github_app_review_private_key` (review). Shopfloor mints the installation token in-process via `@octokit/auth-app` and refreshes it transparently before expiry. This is the only mode that survives implement stages longer than 60 minutes without a token expiry. Used only when no preminted token is set for the same surface.
3. **Default `GITHUB_TOKEN` fallback.** If neither App credentials nor a preminted token is provided, Shopfloor falls back to the workflow's `GITHUB_TOKEN`. This works for evaluation but carries hard limitations:
   - Events caused by `GITHUB_TOKEN` **do not trigger downstream workflows**, so label flips, pushes, and review submissions will not advance the pipeline to the next stage.
   - `GITHUB_TOKEN` cannot APPROVE or REQUEST_CHANGES on a PR authored by `github-actions[bot]` itself, so review aggregation against Shopfloor-authored impl PRs fails.
   - The action emits an `::warning::` describing exactly which surface is on the fallback.

## Migrating from v1

v1 was installed as a reusable workflow at `niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1`. v2 is a regular GitHub Action.

1. Delete the `uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1` line from your workflow.
2. Copy [`examples/shopfloor.yml`](examples/shopfloor.yml) into `.github/workflows/shopfloor.yml`.
3. Pass the App client id and private key directly as `github_app_client_id` and `github_app_private_key` (and the review equivalents). Shopfloor mints and refreshes the installation token in-process — you no longer need an `actions/create-github-app-token` step in the caller workflow. If you still prefer to premint, the `github_app_token` / `github_app_review_token` inputs accept that, with the caveat that those tokens expire after 60 minutes.
4. Label vocabulary, PR conventions, and artifact paths are unchanged.

For supply-chain hardening, pin to a specific SHA instead of `@v2`:

```yaml
uses: niranjan94/shopfloor@<sha> # v2.0.0
```

v1 remains available at the `@v1` tag for repos that have not migrated.

## Escape hatches

Shopfloor manages a set of `shopfloor:*` labels on your issues and PRs. These are the ones you will actually touch:

- `shopfloor:skip-review` on an implementation PR bypasses the four-cell review matrix.
- `shopfloor:awaiting-info` is applied by triage when it needs answers. Remove it after updating the issue to re-run triage.
- `shopfloor:review-stuck` is applied when the review loop gives up. Remove it to force another review pass.
- `shopfloor:failed:<stage>` is applied when a stage errors. Remove it to retry that stage.

## Documentation

- [Install guide](docs/shopfloor/install.md)
- [Configuration reference](docs/shopfloor/configuration.md)
- [Architecture overview](docs/shopfloor/architecture.md)
- [Troubleshooting](docs/shopfloor/troubleshooting.md)
- [FAQ](docs/shopfloor/FAQ.md)

### Smoke testing

A developer-invoked end-to-end runner exercises the real action against `niranjan94/shopfloor-smoke`. See [`scripts/smoke/README.md`](scripts/smoke/README.md).

## License

MIT
