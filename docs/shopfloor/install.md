# Installing Shopfloor

This guide walks you through installing Shopfloor on a fresh repository. Expect a single sitting. You will need admin access to the repository and whichever Anthropic provider you plan to use (Claude API, Bedrock, Vertex, or Foundry).

## Step 0: Audit the source before you trust it

Shopfloor runs inside your repository with write access to branches, pull requests, issues, labels, and commit statuses, and it spawns Claude agents that can execute Bash commands on your CI runners. That is a lot of authority to hand to a third-party action. The project is [MIT licensed](../../LICENSE) specifically so you can verify what it does before turning it on.

**Before you run Shopfloor on a real repository, you should:**

1. **Read the source.** The entire runtime is roughly 1,500 lines of TypeScript plus a few hundred lines of YAML. Start with:
   - [`router/src/state.ts`](../../router/src/state.ts) — the pure state machine that decides which stage runs next.
   - [`router/src/helpers/`](../../router/src/helpers/) — every GitHub mutation Shopfloor performs (labels, comments, PRs, reviews, commit statuses).
   - [`.github/workflows/shopfloor.yml`](../../.github/workflows/shopfloor.yml) — the reusable workflow wiring. Every claude-code-action invocation, every allowed tool, every secret forwarding happens here.
   - [`prompts/`](../../prompts/) — the 8 stage prompts. These are what the LLM sees. If you want to know what Shopfloor is asking Claude to do, this is the authoritative answer.
   - [`mcp-servers/shopfloor-mcp/index.ts`](../../mcp-servers/shopfloor-mcp/index.ts) — the one MCP tool the implementation agent can call. It only updates a single GitHub comment.

2. **Audit the bundled action artifact.** GitHub Actions that are referenced by tag must have their compiled JavaScript committed to the repository. Shopfloor's is [`router/dist/index.cjs`](../../router/dist/index.cjs), a single bundle produced by `esbuild`. You cannot meaningfully read a minified bundle line-by-line, but you can verify it is reproducible:

   ```bash
   git clone https://github.com/niranjan94/shopfloor.git
   cd shopfloor
   pnpm install --frozen-lockfile
   pnpm --filter @shopfloor/router build
   git diff router/dist/index.cjs
   ```

   If `git diff` is clean, the committed artifact matches what the source produces. The CI workflow at [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the same check on every push to main, so a drift between source and bundle would fail CI visibly.

3. **Pin to a verified commit SHA.** The examples below show `@v1`, which is a moving tag. In production that is a supply-chain risk — whoever controls this repository can retag `v1` to any commit at any time. Pick a specific 40-character SHA you have personally inspected, pin to that, and let Dependabot or Renovate propose SHA bumps you review like any other dependency update. See "Step 5: Pin a version" below.

4. **Fork before you trust.** If Shopfloor will run against a repository with production secrets or sensitive code, consider forking `niranjan94/shopfloor`, pinning your caller to your fork at a SHA you control, and pulling upstream changes manually. That removes the maintainer of the upstream repository from your supply chain entirely.

If none of the above is acceptable for your threat model, Shopfloor is not a good fit. Use it on scratch repositories and personal projects first.

## Prerequisites

- A GitHub repository you have admin access to. Public or private; Shopfloor supports both.
- An Anthropic credential from one of:
  - [Claude API](https://www.anthropic.com/api) (`ANTHROPIC_API_KEY`)
  - [Claude Code OAuth token](https://docs.claude.com/en/docs/claude-code/sdk/sdk-headless#authentication) (`CLAUDE_CODE_OAUTH_TOKEN`)
  - AWS Bedrock (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, or `AWS_BEARER_TOKEN_BEDROCK`)
  - Google Vertex AI (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`)
  - Microsoft Foundry (`ANTHROPIC_FOUNDRY_RESOURCE`)
- The [Claude GitHub App](https://github.com/apps/claude) installed on the repository, OR a custom GitHub App you own (see "Custom GitHub App" below).

## Step 1: Install the Claude GitHub App

The simplest path is the official [Claude GitHub App](https://github.com/apps/claude). Install it on the target repository and grant it the permissions it asks for. This gives Shopfloor's agents an authenticated identity to read issues, push branches, and open pull requests under. If you prefer a custom app so commits appear under your own bot name, see the "Custom GitHub App" section at the end of this guide.

## Step 2: Add secrets to the repository

Go to **Settings → Secrets and variables → Actions → New repository secret** and add whichever of these apply to your provider:

| Secret                                                                             | Required when using          |
| ---------------------------------------------------------------------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY`                                                                | Claude API                   |
| `CLAUDE_CODE_OAUTH_TOKEN`                                                          | Claude Code OAuth            |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                         | Bedrock with IAM credentials |
| `AWS_BEARER_TOKEN_BEDROCK`                                                         | Bedrock with a bearer token  |
| `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS` | Vertex                       |
| `ANTHROPIC_FOUNDRY_RESOURCE`                                                       | Foundry                      |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`                                          | Custom GitHub App (optional) |
| `SSH_SIGNING_KEY`                                                                  | Signed commits (optional)    |

You only need to set the secrets for the provider you actually use. `GITHUB_TOKEN` is provided by GitHub automatically — do not add it yourself.

## Step 3: Create the caller workflow

Create `.github/workflows/shopfloor.yml` in your repository with this content:

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

`secrets: inherit` is the easiest way to forward every secret to the reusable workflow. If you prefer an explicit allowlist, pass each secret by name instead.

Commit and push this file. On the next push, GitHub will start running the workflow on every matching event.

## Step 4: First-run bootstrap

The first time Shopfloor runs on your repository it creates ~20 `shopfloor:*` labels via its `bootstrap-labels` helper. This is idempotent — if you ever delete a label, the next run will recreate it. You do not need to do anything for this step.

Open a test issue to watch the pipeline run:

```bash
gh issue create \
  --title "Shopfloor smoke test" \
  --body "Check that Shopfloor can triage and respond to a trivial issue."
```

Within a minute or two you should see:

1. The `route` job run and resolve to `stage=triage`.
2. The `triage` job run, post a comment on the issue, and apply a `shopfloor:quick|medium|large` label plus either `shopfloor:needs-spec|needs-plan|needs-impl` or `shopfloor:awaiting-info`.

If the triage comment appears, the installation is done. Close the smoke-test issue when you are satisfied.

## Step 5: Pin to a verified SHA

**For any non-trivial use, replace `@v1` in the caller with a 40-character commit SHA you have audited.** Moving tags like `@v1` are convenient for evaluation but are a supply-chain risk: whoever controls this repository can retag `v1` to any commit at any time, and your caller will silently pick up the new code on the next run. Named release tags (`@v1.0.0-rc.1`) are marginally better because they are conventionally immutable, but they are still mutable in principle — nothing in git prevents a maintainer from force-pushing a tag.

Pin to a SHA:

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@4d09aeb9e0c8f2b1a7c3d5e9f1a2b3c4d5e6f7a8
    # ...
```

Find the SHA by running `git log` on the shopfloor repository at the commit you want to use, or by clicking the commit in the GitHub UI and copying the full hash from the URL.

**Recommended workflow:**

1. Fork `niranjan94/shopfloor`, or clone and browse locally.
2. Review the source (see [Step 0](#step-0-audit-the-source-before-you-trust-it)).
3. Note the commit SHA of the head of `main` at your review time.
4. Pin your caller workflow to that SHA.
5. Configure Dependabot (`.github/dependabot.yml`) or Renovate to watch the dependency and propose SHA bumps as pull requests. Each proposed bump is a normal PR you can review and merge — or reject — like any other dependency update.

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

This turns "trust the maintainer" into "review each upstream change". That is the same bar you already apply to `actions/checkout` and the rest of your CI supply chain.

## Custom GitHub App

If you want Shopfloor's commits, comments, and PRs to appear under your own bot identity instead of the official Claude GitHub App, you can register your own GitHub App:

1. Create a new GitHub App under **Settings → Developer settings → GitHub Apps → New GitHub App**. Give it these permissions:
   - Repository permissions: Contents (read/write), Issues (read/write), Pull requests (read/write), Commit statuses (write), Metadata (read)
   - Subscribe to events: Issue, Issue comment, Pull request, Pull request review
2. Generate a private key and save the `.pem` file.
3. Install the app on your target repository.
4. Add two secrets to the repository: `GITHUB_APP_ID` (the numeric app id) and `GITHUB_APP_PRIVATE_KEY` (the full contents of the `.pem` file).

Shopfloor forwards these to `claude-code-action`, which mints a short-lived installation token and uses it for every GitHub call, so comments and pushes appear under your bot.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for common first-run issues, including branch protection, CODEOWNERS conflicts, and signed-commit requirements.
