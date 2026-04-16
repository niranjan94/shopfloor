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
- The [Claude GitHub App](https://github.com/apps/claude) installed on the repository (so the agents have an identity to act under).
- **A custom GitHub App you own**, used by the router for label flips and PR pushes (see "GitHub App for the router" below). This is **not optional**: GitHub suppresses workflow triggers for any event caused by `secrets.GITHUB_TOKEN`, so the multi-stage Shopfloor pipeline cannot self-advance without an App-minted token. Without it, triage will run once and then the pipeline will stall.

## Step 1: Install the Claude GitHub App

The simplest path is the official [Claude GitHub App](https://github.com/apps/claude). Install it on the target repository and grant it the permissions it asks for. This gives Shopfloor's agents an authenticated identity to read issues, push branches, and open pull requests under. If you prefer a custom app so commits appear under your own bot name, see the "Custom GitHub App" section at the end of this guide.

## Step 2: Add secrets to the repository

Go to **Settings → Secrets and variables → Actions → New repository secret** and add whichever of these apply to your provider:

| Secret                                                                             | Required when using                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                                                                | Claude API                                                                                       |
| `CLAUDE_CODE_OAUTH_TOKEN`                                                          | Claude Code OAuth                                                                                |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                         | Bedrock with IAM credentials                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK`                                                         | Bedrock with a bearer token                                                                      |
| `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS` | Vertex                                                                                           |
| `ANTHROPIC_FOUNDRY_RESOURCE`                                                       | Foundry                                                                                          |
| `SHOPFLOOR_GITHUB_APP_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_PRIVATE_KEY`               | **Required** for the router to trigger downstream stages (see "GitHub App for the router" below) |
| `SHOPFLOOR_GITHUB_APP_REVIEW_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_REVIEW_PRIVATE_KEY` | Optional second App that posts the agent review matrix (see "GitHub App for reviews" below)      |
| `SSH_SIGNING_KEY`                                                                  | Signed commits (optional)                                                                        |

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

## GitHub App for the router

> **This is required.** Without it the pipeline runs triage once and then stalls forever.

### Why this is mandatory

GitHub deliberately suppresses workflow triggers for any event caused by `secrets.GITHUB_TOKEN`. Quoting the [GitHub Actions docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow):

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN`, with the exception of `workflow_dispatch` and `repository_dispatch`, will not create a new workflow run. This prevents you from accidentally creating recursive workflow runs.

Shopfloor's entire state machine is label-driven. After triage classifies an issue, the router adds `shopfloor:needs-spec` (or `needs-plan` / `needs-impl`); that label flip is supposed to fire a `labeled` event that wakes up the next stage's job. If the label is added with `GITHUB_TOKEN`, GitHub silently drops the event on the floor and the issue stays parked. The same hole exists at every stage transition: spec-merged → needs-plan, plan-merged → needs-impl, impl-pushed → review matrix, review-requesting-changes → impl revision. Without an alternative token, you do not have a pipeline.

A GitHub App installation token does not have this restriction. Shopfloor mints one at the start of every job that performs a triggering mutation (`actions/create-github-app-token@v2`) and uses it in place of `GITHUB_TOKEN` for every router helper call. App tokens are short-lived (1 hour, non-extendable), so the `implement` job mints a fresh one immediately before the post-agent push to guarantee a full hour of validity even if the agent ran for 59 minutes.

### Setup

1. Create a new GitHub App under **Settings → Developer settings → GitHub Apps → New GitHub App**. You can name it anything; "Shopfloor Router" is fine. Webhook URL can be any placeholder; webhooks are not used.
2. Grant these **repository permissions**:
   - **Contents**: Read & write (push commits, create branches)
   - **Issues**: Read & write (label flips, comments)
   - **Pull requests**: Read & write (open PRs, post reviews, update bodies)
   - **Commit statuses**: Read & write (`shopfloor/review` status)
   - **Metadata**: Read (mandatory baseline)
3. **Subscribe to events**: none. The App is a write client only; webhook delivery is irrelevant.
4. Generate a private key and download the `.pem` file. Treat it like any other secret: do not commit it.
5. Install the app on your target repository (or org-wide).
6. Add two secrets to the repository (or org): `SHOPFLOOR_GITHUB_APP_CLIENT_ID` (the App's **Client ID**, visible on the App's general settings page — it looks like `Iv23li...`, not the numeric App ID) and `SHOPFLOOR_GITHUB_APP_PRIVATE_KEY` (the full multi-line contents of the `.pem` file, including the `-----BEGIN/END-----` lines).

Verify by opening any issue carrying your trigger label. The router job's first step will log a green "GitHub App credentials present" line; if you instead see the loud `::warning::` about falling back to `GITHUB_TOKEN`, the secrets are not visible to the workflow (most common cause: the secrets are set on a personal account but the workflow runs under an org).

### Visual identity

Commits, comments, PRs, and reviews from Shopfloor will appear under the App's bot identity (`<your-app-name>[bot]`). If you want Shopfloor's PRs to look like they came from a human, use a fork-based workflow instead and have a human cherry-pick. Bot-authored PRs are the trade-off for full automation.

## GitHub App for reviews (optional)

> **Optional.** Without this second App the review matrix is skipped entirely. Impl PRs still exit draft on completion; a human reviewer can then take over.

### Why a second App

The agent review matrix (`review-compliance`, `review-bugs`, `review-security`, `review-smells`, `review-aggregator`) ends by calling the GitHub `POST /repos/{owner}/{repo}/pulls/{number}/reviews` endpoint with `event: REQUEST_CHANGES` or `event: APPROVE`. GitHub forbids `REQUEST_CHANGES` / `APPROVE` on your own PR, and every Shopfloor PR is authored by the primary router App. If the same App also tries to post the review, the API responds with `422 Review Can not request changes on your own pull request`.

Shopfloor's fix is clean: the review aggregator uses a **second GitHub App installation token** only for the `createReview` call. Labels, comments, commit statuses, and PR body edits continue to flow through the primary App (unchanged). The second App is a distinct identity from the PR author, so self-review restrictions do not apply.

Because the reviewer is still an App (not `GITHUB_TOKEN`), the resulting `pull_request_review.submitted` event fires the router, which drives the implement revision loop exactly as a human-posted review would.

### Setup

1. Create another GitHub App under **Settings → Developer settings → GitHub Apps → New GitHub App**. Name it something like "Shopfloor Reviewer" so it is easy to tell apart from the primary router App on PR timelines.
2. Grant these **minimal repository permissions** (the review App needs much less than the primary):
   - **Contents**: Read (the helper reads PR data)
   - **Pull requests**: Read & write (the createReview call)
   - **Metadata**: Read (mandatory baseline)
3. **Subscribe to events**: none.
4. Generate a private key and download the `.pem` file.
5. Install the App on the same repositories where Shopfloor runs.
6. Add two secrets: `SHOPFLOOR_GITHUB_APP_REVIEW_CLIENT_ID` and `SHOPFLOOR_GITHUB_APP_REVIEW_PRIVATE_KEY`.

When both secrets are present, Shopfloor gates the entire review pipeline (skip-check + 4 matrix reviewers + aggregator) on their presence. Leave them unset and the review pipeline is silently skipped; impl PRs un-draft and wait for a human.

## Disabling draft PRs

By default, Shopfloor opens implementation PRs as drafts and un-drafts them when the agent finishes. If your organization disallows or prefers not to use draft PRs, set `use_draft_prs: false`:

```yaml
jobs:
  shopfloor:
    uses: your-org/shopfloor/.github/workflows/shopfloor.yml@main
    with:
      use_draft_prs: false
```

When disabled, Shopfloor applies a `shopfloor:wip` label to the impl PR during agent work and removes it when done. The label suppresses premature reviews the same way draft status does.

**Required:** your caller workflow must subscribe to `pull_request` `unlabeled` events, or the review pipeline will never trigger:

```yaml
on:
  pull_request:
    types: [opened, synchronize, closed, unlabeled, ready_for_review]
```

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for common first-run issues, including branch protection, CODEOWNERS conflicts, and signed-commit requirements.
