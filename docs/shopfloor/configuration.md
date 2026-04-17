# Configuring Shopfloor

Shopfloor's reusable workflow exposes every knob as a `workflow_call` input. Pass them through the `with:` block in your caller workflow to override defaults.

## Caller workflow with overrides

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      triage_model: haiku
      impl_model: opus
      max_review_iterations: 2
      review_confidence_threshold: 85
      review_security_enabled: true
      review_smells_enabled: false
    secrets: inherit
```

## Models

| Input                     | Default  | Notes                                                                    |
| ------------------------- | -------- | ------------------------------------------------------------------------ |
| `triage_model`            | `sonnet` | Triage does classification, not design. Haiku is often enough.           |
| `spec_model`              | `opus`   | Spec writing needs the strongest model.                                  |
| `plan_model`              | `opus`   | Plan writing benefits from strong reasoning.                             |
| `impl_model`              | `opus`   | Implementation benefits from strong tool use and long-horizon reasoning. |
| `review_compliance_model` | `sonnet` | Compliance checks are mostly pattern matching.                           |
| `review_bugs_model`       | `opus`   | Bug hunting needs strong reasoning.                                      |
| `review_security_model`   | `opus`   | Security pattern matching plus exploit reasoning.                        |
| `review_smells_model`     | `opus`   | Refactor suggestions benefit from strong reasoning.                      |

You can pass any model alias Claude Code understands: `opus`, `sonnet`, `haiku`, or an exact model id like `claude-opus-4-6`.

## Effort

Shopfloor passes `--effort` to `claude-code-action` per stage. High defaults are used for the design-heavy stages; medium everywhere else.

| Input                      | Default  |
| -------------------------- | -------- |
| `triage_effort`            | `medium` |
| `spec_effort`              | `high`   |
| `plan_effort`              | `high`   |
| `impl_effort`              | `medium` |
| `review_compliance_effort` | `medium` |
| `review_bugs_effort`       | `medium` |
| `review_security_effort`   | `medium` |
| `review_smells_effort`     | `medium` |

Valid values: `low`, `medium`, `high`. Raise an effort dial when an agent is producing shallow output; lower it when the agent is overthinking something that should be mechanical.

## Turn budgets

Turn budgets cap how many message rounds each agent can take before Shopfloor aborts the run. **All turn budgets default to unset (no cap).** If an agent is wasting turns thrashing, set a numeric cap; otherwise the `*_timeout_minutes` wall-clock is the only ceiling.

| Input                         | Default       |
| ----------------------------- | ------------- |
| `triage_max_turns`            | `""` (no cap) |
| `spec_max_turns`              | `""` (no cap) |
| `plan_max_turns`              | `""` (no cap) |
| `impl_max_turns`              | `""` (no cap) |
| `review_compliance_max_turns` | `""` (no cap) |
| `review_bugs_max_turns`       | `""` (no cap) |
| `review_security_max_turns`   | `""` (no cap) |
| `review_smells_max_turns`     | `""` (no cap) |

Pass a numeric string to cap turns for a stage, e.g. `spec_max_turns: "50"`. Empty string (the default) omits the `--max-turns` flag from `claude_args` entirely.

## Dollar budgets

Per-run spend caps passed to `claude-code-action` via `--max-budget-usd`. **All dollar budgets default to unset.** When set, claude-code-action aborts the agent if the cumulative API spend for a single invocation exceeds the cap.

| Input                              | Default       |
| ---------------------------------- | ------------- |
| `triage_max_budget_usd`            | `""` (no cap) |
| `spec_max_budget_usd`              | `""` (no cap) |
| `plan_max_budget_usd`              | `""` (no cap) |
| `impl_max_budget_usd`              | `""` (no cap) |
| `review_compliance_max_budget_usd` | `""` (no cap) |
| `review_bugs_max_budget_usd`       | `""` (no cap) |
| `review_security_max_budget_usd`   | `""` (no cap) |
| `review_smells_max_budget_usd`     | `""` (no cap) |

Pass a numeric string, e.g. `impl_max_budget_usd: "5.00"`. Empty string omits the `--max-budget-usd` flag from `claude_args` entirely.

## Timeouts

Wall-clock limits enforced by GitHub Actions. Independent of `max_turns` — the tighter of the two wins.

| Input                    | Default (minutes) |
| ------------------------ | ----------------- |
| `triage_timeout_minutes` | `10`              |
| `spec_timeout_minutes`   | `20`              |
| `plan_timeout_minutes`   | `30`              |
| `impl_timeout_minutes`   | `60`              |
| `review_timeout_minutes` | `20`              |

## Review matrix

Each of the four reviewer cells can be disabled independently. Useful if you already run a dedicated linter for a category or trust human review for it.

| Input                         | Default                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `review_compliance_enabled`   | `true`                                                                   |
| `review_bugs_enabled`         | `true`                                                                   |
| `review_security_enabled`     | `true`                                                                   |
| `review_smells_enabled`       | `true`                                                                   |
| `review_confidence_threshold` | `80` (0-100; comments below this confidence are dropped)                 |
| `max_review_iterations`       | `3` (cap before Shopfloor gives up and applies `shopfloor:review-stuck`) |

## Tool surface

| Input                 | Default                                                         |
| --------------------- | --------------------------------------------------------------- |
| `impl_bash_allowlist` | `pnpm install,pnpm test:*,pnpm lint:*,pnpm build,pnpm exec tsc` |
| `additional_tools`    | `` (reserved; not used yet in v0.1)                             |

`impl_bash_allowlist` is a comma-separated list of Bash command prefixes the implementation agent can run. Everything in this list is passed through `Bash(...)` in the agent's `--allowedTools`. Each entry supports the `:*` suffix for prefix matching, so `pnpm test:*` allows `pnpm test`, `pnpm test --watch`, `pnpm test integration`, and so on.

Note: Shopfloor additionally injects read-only git commands (`git log`, `git diff`, `git show`, `git status`, `git rev-parse`) and the write-side `git add`, `git commit` for every impl run, plus `Agent`, `Skill`, `LSP`, `Bash(gh api:*)`, and `Bash(curl:*)` for every stage. You do not need to list those.

### Merging with `.claude/settings.json`

If your repository has a `.claude/settings.json` with `permissions.allow`, Shopfloor's `render-prompt` helper merges those entries into each agent's `--allowedTools` at runtime. Entries that contain `"` are filtered out because they would corrupt the shell argument. This is the recommended way to add project-specific tools without forking Shopfloor:

```json
{
  "permissions": {
    "allow": ["Bash(pnpm typecheck)", "Bash(pnpm docs:build)", "WebFetch"]
  }
}
```

## Display report

| Input            | Default                        |
| ---------------- | ------------------------------ |
| `display_report` | `'true'` (string, not boolean) |

When `'true'`, `claude-code-action` posts its own summary report to the PR or issue in addition to whatever Shopfloor's helpers post. Useful for transparency; set to `'false'` if you find the duplication noisy. Pass the literal string `'true'` or `'false'` — claude-code-action expects a string, not a workflow boolean.

## Trigger label gating

| Input           | Default                |
| --------------- | ---------------------- |
| `trigger_label` | `''` (empty = no gate) |

When set, Shopfloor only enters the pipeline for issues that carry this label. Issues already mid-pipeline — identified by any `shopfloor:*` state label — are grandfathered in, so removing the trigger label later does not strand in-flight work.

**Entry points recognized when the gate is on:**

- Issue opened with the trigger label already applied (e.g., via issue template) → triage.
- Existing issue receives the trigger label via `issues.labeled` → triage.
- Any other `opened` or `labeled` event without the trigger label → `stage=none`.

Example: only run Shopfloor on issues explicitly marked for automation.

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      trigger_label: shopfloor:trigger
    secrets: inherit
```

With that caller, opening a new issue does nothing. When someone applies the `shopfloor:trigger` label, the triage stage fires.

## Branching and artifacts

| Input                    | Default           |
| ------------------------ | ----------------- |
| `branch_prefix`          | `shopfloor/`      |
| `artifacts_dir`          | `docs/shopfloor/` |
| `keep_artifacts_forever` | `true`            |

Every Shopfloor branch starts with `branch_prefix`. Specs live at `<artifacts_dir>/specs/<issue>-<slug>.md`, plans at `<artifacts_dir>/plans/<issue>-<slug>.md`. Setting `keep_artifacts_forever` to `false` is reserved for a future auto-cleanup mode and has no effect in v0.1.

## Runners

Customize which GitHub Actions runner each job tier uses. Pass a plain string for standard runners or a JSON array for label-based selection.

| Input           | Default         | Jobs                                                                   |
| --------------- | --------------- | ---------------------------------------------------------------------- |
| `runner_router` | `ubuntu-latest` | `route`, `review-skip-check`, `review-aggregator`, `handle-merge`      |
| `runner_agent`  | `ubuntu-latest` | `triage`, `spec`, `plan`, `implement`                                  |
| `runner_review` | `ubuntu-latest` | `review-compliance`, `review-bugs`, `review-security`, `review-smells` |

**Plain string:**

```yaml
with:
  runner_agent: "self-hosted"
```

**JSON label array:**

```yaml
with:
  runner_agent: '["self-hosted", "linux", "x64"]'
```

## Provider selection

| Input         | Default | Notes                                                                                  |
| ------------- | ------- | -------------------------------------------------------------------------------------- |
| `use_bedrock` | `false` | Set to `true` to route Claude calls through AWS Bedrock. Requires the `AWS_*` secrets. |
| `use_vertex`  | `false` | Route through Google Vertex AI. Requires the Vertex secrets.                           |
| `use_foundry` | `false` | Route through Microsoft Foundry. Requires `ANTHROPIC_FOUNDRY_RESOURCE`.                |

If none are set, Shopfloor uses whichever of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is present.

## Commit signing

| Input                     | Default |
| ------------------------- | ------- |
| `ssh_signing_key_enabled` | `false` |

Set to `true` and provide `SSH_SIGNING_KEY` as a secret if your branch protection requires signed commits. Shopfloor configures git with the key at the start of each stage job so every commit is signed under the bot identity.

## Secrets

All secrets are optional at the workflow level — set only what your provider needs.

```yaml
secrets:
  anthropic_api_key:
  claude_code_oauth_token:
  aws_access_key_id:
  aws_secret_access_key:
  aws_region:
  aws_bearer_token_bedrock:
  anthropic_vertex_project_id:
  cloud_ml_region:
  google_application_credentials:
  anthropic_foundry_resource:
  shopfloor_github_app_client_id:
  shopfloor_github_app_private_key:
  ssh_signing_key:
```

The easiest way to forward everything is `secrets: inherit` in the caller workflow.

## Full example: budget-conscious caller

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      triage_model: haiku
      spec_model: sonnet
      plan_model: sonnet
      impl_model: sonnet
      review_compliance_model: haiku
      review_smells_enabled: false
      max_review_iterations: 2
    secrets: inherit
```

## Full example: high-assurance caller

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      triage_model: sonnet
      spec_model: opus
      plan_model: opus
      impl_model: opus
      review_compliance_model: sonnet
      review_bugs_model: opus
      review_security_model: opus
      review_smells_model: opus
      review_confidence_threshold: 90
      max_review_iterations: 4
      impl_bash_allowlist: "pnpm install,pnpm test:*,pnpm build,pnpm exec tsc,pnpm audit,pnpm licenses"
      ssh_signing_key_enabled: true
    secrets: inherit
```

## Full example: self-hosted runners

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      runner_router: ubuntu-latest
      runner_agent: '["self-hosted", "linux", "x64"]'
      runner_review: '["self-hosted", "linux", "x64"]'
    secrets: inherit
```
