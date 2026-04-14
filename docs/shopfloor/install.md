# Installing Shopfloor

This guide walks you through installing Shopfloor on a fresh repository. Expect a single sitting. You will need admin access to the repository and whichever Anthropic provider you plan to use (Claude API, Bedrock, Vertex, or Foundry).

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

| Secret | Required when using |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Bedrock with IAM credentials |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock with a bearer token |
| `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS` | Vertex |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Custom GitHub App (optional) |
| `SSH_SIGNING_KEY` | Signed commits (optional) |

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

## Step 5: Pin a version

`@v1` is a moving tag that follows the latest v1.x release. If you want to pin to a specific release for reproducibility, replace `@v1` with a specific tag such as `@v1.0.0-rc.1`. Updating later is a one-line edit.

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
