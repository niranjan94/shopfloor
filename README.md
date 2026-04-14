# Shopfloor

Shopfloor is a reusable GitHub Actions workflow that wraps `anthropics/claude-code-action` to drive a staged, human-gated AI software delivery pipeline across GitHub issues and pull requests.

Drop it into any repository and every new issue gets routed through triage → spec → plan → implement → review, with a human reviewing each stage's pull request before the next one fires.

## How it works

1. You open an issue. Shopfloor triages it, classifies complexity (`quick`, `medium`, `large`), and either asks clarifying questions or flips a label to start the next stage.
2. For `large` issues, a spec agent drafts a design doc on a branch and opens a PR. You review and merge.
3. For `medium` and `large` issues, a plan agent turns the merged spec into a step-by-step implementation plan on another branch. You review and merge.
4. An implementation agent executes the plan, commits as it goes, and opens a draft-free PR. A live progress comment shows you what it is doing.
5. A four-cell review matrix (compliance, bugs, security, smells) runs against the implementation PR. The aggregator posts one combined review — `APPROVE` when everything is clean, `REQUEST_CHANGES` with batched line comments otherwise. If the loop fails to converge in `max_review_iterations` rounds, Shopfloor gives up and asks a human to take over.
6. You review and merge the implementation PR. Shopfloor closes the origin issue with `shopfloor:done`.

Every stage writes labels and comments through a deterministic TypeScript router, not through the agent itself. Agents only emit structured output. This keeps GitHub state predictable and agent behavior auditable.

## Install

1. **Add secrets** to your repository: either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (or the Bedrock/Vertex/Foundry equivalents). Shopfloor forwards whichever you set to `claude-code-action`.
2. **Install the Claude GitHub App** on the repository so the agent can read issues and push commits. See `docs/shopfloor/install.md` for the detailed walkthrough.
3. **Create `.github/workflows/shopfloor.yml`** in your repository with the caller below. Shopfloor will bootstrap its labels on the first run.

```yaml
name: Shopfloor
on:
  issues:
    types: [opened, edited, closed, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
      statuses: write
      checks: read
    secrets: inherit
```

Open an issue and watch it go.

## Configuration

Shopfloor exposes every stage's model, turn budget, timeout, tool allowlist, review confidence threshold, and iteration cap as `inputs` on the reusable workflow. See `docs/shopfloor/configuration.md` for the full list with examples.

Common overrides:

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1
    with:
      triage_model: haiku
      impl_model: opus
      max_review_iterations: 2
      review_confidence_threshold: 85
    secrets: inherit
```

## Labels

Shopfloor creates and manages its own `shopfloor:*` labels. You can use the escape hatches at any time:

- `shopfloor:skip-review` — bypasses the four-cell review matrix on the implementation PR.
- `shopfloor:revise` — re-runs the current stage against fresh context.
- `shopfloor:awaiting-info` — applied by the triage agent when it needs answers. Remove it once you have updated the issue to re-run triage.
- `shopfloor:failed:<stage>` — applied when a stage errors. Remove it to retry.

## Documentation

- [Install guide](docs/shopfloor/install.md)
- [Configuration reference](docs/shopfloor/configuration.md)
- [Architecture overview](docs/shopfloor/architecture.md)
- [Troubleshooting](docs/shopfloor/troubleshooting.md)
- [FAQ](docs/shopfloor/FAQ.md)

The full design spec lives at [`docs/superpowers/specs/2026-04-14-shopfloor-design.md`](docs/superpowers/specs/2026-04-14-shopfloor-design.md).

## License

MIT
