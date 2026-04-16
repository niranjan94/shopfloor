# Shopfloor

> **Early alpha -- under active development.** APIs, workflow inputs, label conventions, and prompt templates may change without notice between commits. Pin to a specific commit SHA if you use this today, and expect breaking changes. Bug reports and feedback are welcome via [Issues](https://github.com/niranjan94/shopfloor/issues).

A reusable GitHub Actions workflow that turns `anthropics/claude-code-action` into a staged, human-gated AI delivery pipeline. Drop it into a repository and every new issue is routed through **triage → spec → plan → implement → review**, with a human approving each stage by merging the pull request it produces.

Shopfloor is deliberately boring where it counts: a pure TypeScript state machine owns every label flip, comment, and PR mutation. Agents only emit structured JSON. That keeps GitHub state predictable, stage behaviour auditable, and the blast radius of a confused model small.

## How it works

1. You open an issue. The triage agent classifies it `quick`, `medium`, or `large`, or asks clarifying questions and pauses.
2. The router advances the issue through the stages appropriate for its complexity:

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

| Path                              | What lives there                                                            |
| --------------------------------- | --------------------------------------------------------------------------- |
| `.github/workflows/shopfloor.yml` | The reusable workflow callers consume                                       |
| `router/`                         | TypeScript GitHub Action: state machine, helpers, compiled bundle in `dist` |
| `prompts/`                        | Stage prompt templates, rendered by the router                              |
| `mcp-servers/shopfloor-mcp/`      | MCP server exposing the `update_progress` tool to the implementation agent  |
| `docs/shopfloor/`                 | Install, configuration, architecture, troubleshooting, FAQ                  |

## Before you install: read the source

Shopfloor runs inside your repository with write access to branches, pull requests, issues, labels, and commit statuses. It also spawns Claude agents that can execute Bash on your CI runners. That is a lot of authority to hand a third-party action, so Shopfloor is [MIT licensed](LICENSE) and fully open source precisely so you can verify what it does before you turn it on.

The entire runtime is a few thousand lines of TypeScript and YAML. You can read it in an afternoon. We recommend you do, in this order:

1. [`router/src/state.ts`](router/src/state.ts) is the pure state machine. Every stage decision lives here.
2. [`router/src/helpers/`](router/src/helpers/) is every GitHub mutation Shopfloor performs. If it writes to your repository, it is in this directory.
3. [`.github/workflows/shopfloor.yml`](.github/workflows/shopfloor.yml) is the wiring: which model runs, which tools are allowed, which secrets are forwarded.
4. [`prompts/`](prompts/) is what the LLM actually sees at each stage.

Two more precautions before production use:

- **Audit the bundled artifact.** `router/dist/index.cjs` is the compiled action that actually executes on your runners. It is committed (standard practice for JS actions) and reproducible from `router/src/` via `pnpm --filter @shopfloor/router build`. Diff against the committed file to confirm.
- **Pin to a verified commit SHA, not a moving tag.** The `@v1` tag in the snippet below is convenient for evaluation but a supply-chain risk in production. Replace it with a 40-character SHA you have inspected, and let Dependabot or Renovate propose bumps you review like any other dependency.

If you are not willing to do any of the above, Shopfloor is probably not a good fit for your threat model. Use it on scratch repositories first.

## Install

The short version. The full walkthrough, including the custom GitHub App setup, lives in [`docs/shopfloor/install.md`](docs/shopfloor/install.md).

1. **Install two GitHub Apps on the repository.**
   - The [Claude GitHub App](https://github.com/apps/claude) gives the agents an identity to read issues, push branches, and open PRs under.
   - A **custom GitHub App you own** is used by the router to mint tokens for label flips and PR pushes. This is **not optional**. GitHub suppresses workflow triggers for events caused by `secrets.GITHUB_TOKEN`, so without an App-minted token the pipeline runs triage once and then stalls at the first label flip. See the install guide for the required app permissions and the secrets to export from it.

2. **Add secrets** to the repository at **Settings → Secrets and variables → Actions**:

   | Secret                                                               | Needed for                                                 |
   | -------------------------------------------------------------------- | ---------------------------------------------------------- |
   | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`                     | Agent auth (or the Bedrock / Vertex / Foundry equivalents) |
   | `SHOPFLOOR_GITHUB_APP_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_PRIVATE_KEY` | **Required.** The custom router App's credentials          |
   | `SSH_SIGNING_KEY`                                                    | Optional. Signed commits from Shopfloor's branches         |

3. **Create `.github/workflows/shopfloor.yml`** in your repository:

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
       # SECURITY: @v1 is a moving tag. For production, pin to a 40-char SHA
       # you have audited. See "Before you install" above.
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

Open an issue and watch it go. The first run bootstraps all `shopfloor:*` labels.

## Configuration

Every stage's model, effort, turn budget, timeout, tool allowlist, review confidence threshold, and iteration cap is exposed as an input on the reusable workflow. The full reference lives in [`docs/shopfloor/configuration.md`](docs/shopfloor/configuration.md).

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
      # Only enter the pipeline for issues carrying this label.
      trigger_label: shopfloor
    secrets: inherit
```

## Escape hatches

Shopfloor manages a set of `shopfloor:*` labels on your issues and PRs. These are the ones you will actually touch:

- `shopfloor:skip-review` on an implementation PR bypasses the four-cell review matrix.
- `shopfloor:revise` re-runs the current stage against fresh context.
- `shopfloor:awaiting-info` is applied by triage when it needs answers. Remove it after updating the issue to re-run triage.
- `shopfloor:review-stuck` is applied when the review loop gives up. Remove it to force another review pass.
- `shopfloor:failed:<stage>` is applied when a stage errors. Remove it to retry that stage.

## Documentation

- [Install guide](docs/shopfloor/install.md)
- [Configuration reference](docs/shopfloor/configuration.md)
- [Architecture overview](docs/shopfloor/architecture.md)
- [Troubleshooting](docs/shopfloor/troubleshooting.md)
- [FAQ](docs/shopfloor/FAQ.md)

## License

MIT
