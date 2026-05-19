# Configuring Shopfloor

Every input Shopfloor exposes is declared in [`action.yml`](../../action.yml) and validated by [`src/config/inputs.ts`](../../src/config/inputs.ts). Set them under the `with:` block of the `uses: niranjan94/shopfloor@v2` step in your caller workflow.

## Minimal caller

```yaml
- uses: niranjan94/shopfloor@v2
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    github_app_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_CLIENT_ID }}
    github_app_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY }}
```

See [`examples/shopfloor.yml`](../../examples/shopfloor.yml) for the full triggers and permissions block.

## Anthropic credentials

Exactly one of these is required.

| Input                     | Default | Notes                    |
| ------------------------- | ------- | ------------------------ |
| `anthropic_api_key`       | `""`    | Anthropic API key.       |
| `claude_code_oauth_token` | `""`    | Claude Code OAuth token. |

## Auth surfaces

Two independent surfaces — **primary** (every mutation except code reviews) and **review** (the review aggregator's APPROVE / REQUEST_CHANGES call). Each accepts three sources. They are evaluated in the order shown in the table; the first source set for a given surface wins. The "preferred for production" mode is App credentials (refreshes transparently past the 60-minute installation-token TTL), but if you also pass a preminted token it takes precedence. See [`src/github/app-token.ts`](../../src/github/app-token.ts).

### Primary surface

| Input                    | Default | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_app_token`       | `""`    | Evaluated first. Preminted installation token (e.g. from `actions/create-github-app-token@v2`). **Caveat:** capped at GitHub's 60-minute installation-token TTL. Implement stages that outrun the TTL will fail mid-run; prefer App credentials.                                                                                                               |
| `github_app_client_id`   | `""`    | Evaluated next when no preminted token is set. App client id (looks like `Iv23li…`, not the numeric App ID). Paired with `github_app_private_key`. **Preferred for production:** Shopfloor mints the installation token in-process via `@octokit/auth-app` and refreshes it transparently with a 5-minute pre-expiry margin, surviving multi-hour impl stages. |
| `github_app_private_key` | `""`    | App private key (PEM contents, including `-----BEGIN/END-----` lines).                                                                                                                                                                                                                                                                                         |
| `github_token`           | `""`    | Last-resort fallback (typically `${{ github.token }}`). Mutations via this token do not trigger downstream workflows. See [Authentication modes in the README](../../README.md#authentication-modes).                                                                                                                                                          |

### Review surface (optional)

| Input                           | Default | Notes                                                                                                                                                               |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_app_review_client_id`   | `""`    | A second App's client id, used only for posting the review verdict. Required because GitHub forbids `APPROVE` / `REQUEST_CHANGES` on a PR authored by the same App. |
| `github_app_review_private_key` | `""`    | The review App's PEM private key.                                                                                                                                   |
| `github_app_review_token`       | `""`    | Preminted review installation token. Same 60-minute TTL caveat as `github_app_token`.                                                                               |

Leave the review surface unset for a read-only review path: Shopfloor will still run the review lenses and post a verdict via the primary surface where possible, but will skip APPROVE / REQUEST_CHANGES on Shopfloor-authored PRs. For human-authored PRs (`review_only: "true"`), the review surface is not required.

## Pipeline behavior

| Input                   | Default   | Notes                                                                                                                                                                                                                                                                     |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger_label`         | `""`      | When set, only issues carrying this label enter the pipeline. Issues already mid-pipeline (any `shopfloor:*` state label present) are grandfathered.                                                                                                                      |
| `max_review_iterations` | `"3"`     | Maximum review revision loops before Shopfloor applies `shopfloor:review-stuck` and hands off to a human. Ignored when `review_only: "true"` (each human-PR push gets a fresh review).                                                                                    |
| `review_only`           | `"false"` | When `"true"` and the event is a `pull_request`, Shopfloor reviews any human-authored PR (PRs without Shopfloor metadata) statelessly. Skips label flips, skips PR-body updates, no iteration counter. Use in a separate caller workflow against `pull_request` triggers. |

## Models

Per-stage model selection. Pass any model id the Claude Agent SDK understands. The defaults pin specific versions; aliases like `claude-haiku` / `claude-sonnet` / `claude-opus` also work if you want to track the latest in a family.

| Input                     | Default               | Notes                                                                                                                      |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `triage_model`            | `claude-sonnet-4-6`   | Classification is mostly pattern-matching; Sonnet is a balance between accuracy on ambiguous issues and per-event spend.   |
| `spec_model`              | `claude-opus-4-7[1m]` | Spec writing benefits from the strongest reasoning. The `[1m]` suffix selects the 1M-context tier for long-issue contexts. |
| `plan_model`              | `claude-opus-4-7[1m]` | Plan decomposition benefits from strong reasoning.                                                                         |
| `impl_model`              | `claude-opus-4-7[1m]` | Implementation benefits from strong tool use and long-horizon planning.                                                    |
| `review_compliance_model` | `claude-opus-4-7[1m]` | Compliance lens.                                                                                                           |
| `review_bugs_model`       | `claude-opus-4-7[1m]` | Bug-hunting lens.                                                                                                          |
| `review_security_model`   | `claude-opus-4-7[1m]` | Security lens.                                                                                                             |
| `review_smells_model`     | `claude-opus-4-7[1m]` | Refactor/smells lens.                                                                                                      |

## Reasoning effort

Per-stage reasoning effort. Accepts `low` | `medium` | `high` | `xhigh`. Higher effort spends more tokens on chain-of-thought before the final answer; `xhigh` is the deepest tier the SDK exposes.

| Input                      | Default | Notes                   |
| -------------------------- | ------- | ----------------------- |
| `triage_effort`            | `high`  | Triage stage.           |
| `spec_effort`              | `high`  | Spec stage.             |
| `plan_effort`              | `high`  | Plan stage.             |
| `impl_effort`              | `high`  | Implement stage.        |
| `review_compliance_effort` | `high`  | Compliance review lens. |
| `review_bugs_effort`       | `high`  | Bugs review lens.       |
| `review_security_effort`   | `high`  | Security review lens.   |
| `review_smells_effort`     | `high`  | Smells review lens.     |

## Turn caps

Optional hard caps on agent turns per stage. Empty (the default) means no cap — the stage runs to natural completion within its budget and timeout. Set a positive integer to bound multi-turn loops explicitly.

| Input                       | Default       | Notes                                          |
| --------------------------- | ------------- | ---------------------------------------------- |
| `triage_max_turns`          | `""` (no cap) | Triage stage.                                  |
| `spec_max_turns`            | `""` (no cap) | Spec stage.                                    |
| `plan_max_turns`            | `""` (no cap) | Plan stage.                                    |
| `impl_max_turns`            | `""` (no cap) | Implement stage. Set this if impl runs sprawl. |
| `review_max_turns_per_lens` | `""` (no cap) | Applies to each of the four review lenses.     |

## Budgets

Per-run USD spend caps. The agent aborts when its cumulative API spend for a single stage invocation exceeds the cap.

| Input                            | Default  |
| -------------------------------- | -------- |
| `triage_max_budget_usd`          | `"0.25"` |
| `spec_max_budget_usd`            | `"1.50"` |
| `plan_max_budget_usd`            | `"1.50"` |
| `impl_max_budget_usd`            | `"2.50"` |
| `review_max_budget_usd_per_lens` | `"0.75"` |

`review_max_budget_usd_per_lens` applies to each of the four review lenses (compliance, bugs, security, smells) independently — the matrix's total budget per review is up to 4× this value.

## Timeouts

Per-stage wall-clock timeouts (milliseconds).

| Input                        | Default     | Equivalent |
| ---------------------------- | ----------- | ---------- |
| `triage_timeout_ms`          | `"300000"`  | 5 minutes  |
| `spec_timeout_ms`            | `"1200000"` | 20 minutes |
| `plan_timeout_ms`            | `"1200000"` | 20 minutes |
| `impl_timeout_ms`            | `"3600000"` | 60 minutes |
| `review_timeout_ms_per_lens` | `"900000"`  | 15 minutes |

Minimum acceptable value is 1000 ms. Lower values are rejected by Zod at startup.

## Commit signing

| Input             | Default | Notes                                                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `ssh_signing_key` | `""`    | Optional SSH private key (full contents, not a path). When set, Shopfloor signs every commit it pushes. |

The public half of the key must be registered as a signing key on the GitHub identity Shopfloor commits under (typically the primary App's bot). See [GitHub's SSH signing-key docs](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#ssh-commit-signature-verification).

## Review-only workflow (for human-authored PRs)

To run the review lenses against PRs your team or other automations open (not Shopfloor's own impl PRs), add a second workflow that calls the action with `review_only: "true"`:

```yaml
name: Shopfloor Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  statuses: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: niranjan94/shopfloor@v2
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
          review_only: "true"
```

Notes:

- `review_only: "true"` is stateless on human PRs: no iteration counter, no `shopfloor:*` labels applied to the PR, no PR-body footer added. Each push gets a fresh review.
- The workflow's default `GITHUB_TOKEN` is acceptable here. Cascading-trigger suppression does not bite (there's no downstream pipeline), and the self-review restriction doesn't apply (the PR author is human, not the bot).
- Shopfloor refuses to route in this mode when the PR already carries Shopfloor metadata, so the review-only workflow and the full pipeline never double-review the same PR.

## Split-runner mode

By default Shopfloor runs as a single GitHub Actions job per event. For larger repos that want different runners per stage — typically a small runner for triage/spec/plan/review and a beefier one for implement — split the workflow into a `resolve` router job and one or more `execute` jobs gated on the router's `stage` output. See [`examples/shopfloor-split-runners.yml`](../../examples/shopfloor-split-runners.yml) for the full pattern.

| Input    | Default  | Notes                                                                                                                                                                                                                                                         |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `"auto"` | `auto` resolves and executes in one process (single-job consumer workflows). `resolve` runs only the state machine and emits the `stage` output — no mutex, no agent, no GitHub mutations. `execute` resolves, applies the `stages` allowlist, and then runs. |
| `stages` | `""`     | Comma-separated allowlist for `mode: execute`. Empty (default) means all stages are accepted. Non-matching stages exit `0` silently with `executed: "false"`. Ignored when `mode != execute`. Valid names: `triage,spec,plan,implement,review`.               |

In `execute` mode the orchestrator fetches live issue labels from the GitHub API before precheck instead of trusting the event-payload snapshot, so the resolve → execute label-flip race window closes. Prefer App credentials (not preminted tokens) in split mode — the resolve → execute gap eats into the 60-minute installation-token TTL.

## Action outputs

Every invocation sets these two outputs regardless of `mode`.

| Output     | Notes                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stage`    | The stage the state machine resolved for this event: one of `triage`, `spec`, `plan`, `implement`, `review`, or `none`. Read this from a `mode: resolve` job to gate downstream execute jobs.    |
| `executed` | `"true"` if the action actually ran a stage's agent and applied its decision, `"false"` otherwise. `false` covers `mode: resolve` invocations, filter misses, `none` routes, and precheck skips. |

## What the action does not configure

The following knobs that v1 exposed were removed in v2 and are not currently configurable: per-lens `review_*_enabled`, `review_confidence_threshold` (hardcoded to 60), `display_report`, `branch_prefix`, `artifacts_dir`, `keep_artifacts_forever`, `runner_*`, `use_bedrock`/`use_vertex`/`use_foundry`, `impl_bash_allowlist`, `additional_tools`, `setup_stages` / `setup_env_json` / `setup_required`, `use_draft_prs` / `shopfloor:wip` toggle. Branch names (`shopfloor/{spec,plan,impl}/<N>-<slug>`) and artifact paths (`docs/shopfloor/{specs,plans}/<N>-<slug>.md`) are hardcoded; the review lens set is fixed at four cells. Open an issue if you need any of these back.
