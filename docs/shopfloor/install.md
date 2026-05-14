# Installing Shopfloor

This guide walks you through installing Shopfloor on a fresh repository. Expect a single sitting. You will need admin access to the repository and an Anthropic API key (or a Claude Code OAuth token).

## Step 0: Audit the source before you trust it

Shopfloor runs inside your repository with write access to branches, pull requests, issues, labels, and commit statuses, and it spawns Claude agents that can execute Bash on your CI runners. That is a lot of authority to hand a third-party action. The project is [MIT licensed](../../LICENSE) so you can verify what it does before turning it on.

**Before running Shopfloor on a real repository:**

1. **Read the source.** The entire runtime is a few thousand lines of TypeScript. Read in this order:
   - [`src/state/machine.ts`](../../src/state/machine.ts) — the pure state machine. Every stage decision lives here.
   - [`src/github/adapter.ts`](../../src/github/adapter.ts) — every GitHub mutation Shopfloor performs. If it writes to your repository, it is in this file.
   - [`src/orchestrator.ts`](../../src/orchestrator.ts) — the route → run → apply loop, plus precheck and failure reporting.
   - [`action.yml`](../../action.yml) — every input the action accepts.
   - [`src/stages/`](../../src/stages/) — per-stage runner / apply / decision schema, plus inlined `prompt.system.md` and `prompt.user.md.tmpl`. These are what each agent actually sees.

2. **Verify the bundled artifact.** GitHub Actions referenced by tag must commit their compiled JavaScript. Shopfloor's is [`dist/index.cjs`](../../dist/index.cjs), a single `esbuild` bundle. Reproduce it:

   ```bash
   git clone https://github.com/niranjan94/shopfloor.git
   cd shopfloor
   pnpm install --frozen-lockfile
   pnpm build
   git diff dist
   ```

   If `git diff` is clean, the committed bundle matches the source. CI runs the same check on every push to main, so drift fails visibly.

3. **Pin to a verified commit SHA.** `@v2` is convenient but mutable — whoever controls this repository can retag it. Replace `@v2` with a 40-character SHA you have inspected, then let Dependabot or Renovate propose bumps you review like any other dependency.

4. **Fork if you need full control.** Forking `niranjan94/shopfloor` and pinning your caller to your fork removes upstream maintainership from your supply chain. You can pull upstream changes manually when you want them.

If none of this is acceptable for your threat model, Shopfloor is not a good fit. Use it on scratch repositories first.

## Prerequisites

- A GitHub repository you have admin access to. Public or private both work.
- An Anthropic credential: either `ANTHROPIC_API_KEY` (Claude API) or `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code OAuth).
- The [Claude GitHub App](https://github.com/apps/claude) installed on the repository, **or** a custom GitHub App you own. This is the identity Shopfloor commits, comments, and pushes under.
- A second optional GitHub App for review submissions (`APPROVE` / `REQUEST_CHANGES`). Without this, the review aggregator cannot post verdicts on Shopfloor-authored PRs — see [the review App section](#github-app-for-reviews) below.

## Step 1: Install the GitHub App

The simplest path is the official [Claude GitHub App](https://github.com/apps/claude). Install it on the target repository and grant the permissions it asks for. This gives Shopfloor's agents an authenticated identity to read issues, push branches, and open pull requests.

If you want commits to appear under a bot identity you control, [create your own App](#custom-github-app) and install it instead — Shopfloor uses whichever App's client id + private key you pass.

## Step 2: Add secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add whichever apply:

| Secret                                                                             | Required when                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                                | Using the Claude API                                                          |
| `CLAUDE_CODE_OAUTH_TOKEN`                                                          | Using a Claude Code OAuth token                                               |
| `SHOPFLOOR_GITHUB_APP_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_PRIVATE_KEY`               | Strongly recommended. The primary App's credentials (used for every mutation) |
| `SHOPFLOOR_GITHUB_APP_REVIEW_CLIENT_ID`, `SHOPFLOOR_GITHUB_APP_REVIEW_PRIVATE_KEY` | Optional. The review App's credentials (used for APPROVE / REQUEST_CHANGES)   |
| `SSH_SIGNING_KEY`                                                                  | Optional. Required when branch protection enforces signed commits             |

Secret names are user-chosen — Shopfloor doesn't care what you call them. The names above match the [`examples/shopfloor.yml`](../../examples/shopfloor.yml) sample.

> **Note on auth fallback.** If you provide neither App credentials nor a preminted token, Shopfloor falls back to the workflow's default `GITHUB_TOKEN`. The pipeline will not advance: GitHub suppresses workflow triggers for mutations made with `GITHUB_TOKEN`, so label flips and pushes do not fire downstream events. The action emits a loud `::warning::` in this state. The fallback is intended for evaluation and for the [review-only workflow](#step-4-optional-review-only-workflow-for-human-prs), not the full pipeline.

## Step 3: Create the caller workflow

Create `.github/workflows/shopfloor.yml` in your repository with this content (the same shape lives in [`examples/shopfloor.yml`](../../examples/shopfloor.yml)):

```yaml
name: Shopfloor

on:
  issues:
    types: [opened, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, ready_for_review, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  shopfloor:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Run Shopfloor
        # SECURITY: @v2 is a moving tag. For production, pin to a 40-char SHA
        # you have audited (see Step 0).
        uses: niranjan94/shopfloor@v2
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_CLIENT_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY }}
          # Optional: a separate App used only for posting review verdicts
          # on Shopfloor-authored PRs. Required if you want APPROVE /
          # REQUEST_CHANGES on impl PRs.
          github_app_review_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_REVIEW_CLIENT_ID }}
          github_app_review_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_REVIEW_PRIVATE_KEY }}
          # Optional: only run the pipeline on issues carrying this label.
          trigger_label: shopfloor
```

A few details:

- **The caller workflow's `permissions:` block can stay read-only.** Every write goes through the App installation token Shopfloor mints in-process, not the workflow's `GITHUB_TOKEN`. Read-only top-level permissions reduce blast radius if anything in the workflow leaks.
- **`persist-credentials: false`** on `actions/checkout` is important. Without it, checkout writes a GITHUB_TOKEN credential into git config that overrides the App token Shopfloor uses for pushes (and lacks write scope), so impl pushes 403.
- **No `actions/create-github-app-token` step is needed.** Shopfloor mints (and refreshes) the App installation token in-process via `@octokit/auth-app`, so implement stages longer than 60 minutes stay authenticated.

Commit and push. GitHub will start running the workflow on every matching event.

## Step 4 (optional): Review-only workflow for human PRs

To run Shopfloor's review lenses on PRs from your team or other automations (not Shopfloor's own impl PRs), add a second workflow:

```yaml
# .github/workflows/shopfloor-review.yml
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

`review_only: "true"` is stateless on human PRs — no iteration counter, no Shopfloor labels, no PR-body footer. Each push gets a fresh review. The workflow's default `GITHUB_TOKEN` is acceptable here because the cascading-trigger and self-review limitations don't apply to human-authored PRs.

## Step 5: First-run bootstrap

The first time Shopfloor runs on your repository it creates the `shopfloor:*` labels it needs via the GitHub adapter's idempotent `createLabel` calls. If you ever delete a label, the next run recreates it. You don't need to do anything for this step.

Open a smoke-test issue to watch the pipeline:

```bash
gh issue create \
  --title "Shopfloor smoke test" \
  --body "Check that Shopfloor can triage and respond to a trivial issue." \
  --label shopfloor   # if you set a trigger_label
```

Within a minute or two the triage agent posts a comment, applies `shopfloor:quick|medium|large`, and flips the issue to `shopfloor:needs-impl` / `needs-plan` / `needs-spec`. If the triage comment appears, the installation is done.

## Step 6: Pin to a verified SHA

For non-trivial use, replace `@v2` with a 40-character SHA you have audited:

```yaml
- uses: niranjan94/shopfloor@4d09aeb9e0c8f2b1a7c3d5e9f1a2b3c4d5e6f7a8 # v2.0.0
```

Then configure Dependabot (`.github/dependabot.yml`) or Renovate to propose SHA bumps as normal PRs:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Each upstream bump becomes a PR you review like any other dependency change.

## GitHub App for the primary surface

> **Strongly recommended.** Without it the pipeline falls back to `GITHUB_TOKEN` and label flips will not fire downstream stages.

### Why an App is required for the full pipeline

GitHub deliberately suppresses workflow triggers for events caused by `secrets.GITHUB_TOKEN`. Quoting [the GitHub Actions docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow):

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN`, with the exception of `workflow_dispatch` and `repository_dispatch`, will not create a new workflow run.

Shopfloor's pipeline is label-driven: after triage classifies an issue, the orchestrator adds `shopfloor:needs-spec` (or `needs-plan` / `needs-impl`), and that label flip is supposed to fire a `labeled` event that wakes up the next stage. If the label is added with `GITHUB_TOKEN`, GitHub silently drops the event and the issue parks. The same hole exists at every transition.

A GitHub App installation token has no such restriction. Shopfloor mints one in-process and uses it for every mutation.

### Setup

1. Create a new GitHub App at **Settings → Developer settings → GitHub Apps → New GitHub App**. Name it whatever — "Shopfloor" or "Acme Shopfloor" is fine. Webhook URL can be any placeholder; webhooks are not used.
2. Grant these **repository permissions**:
   - **Contents**: Read & write (push commits, create branches)
   - **Issues**: Read & write (label flips, comments, metadata edits)
   - **Pull requests**: Read & write (open PRs, post reviews, update bodies)
   - **Commit statuses**: Read & write (the `shopfloor/review` status)
   - **Metadata**: Read (mandatory baseline)
3. **Subscribe to events**: none. The App is a write client only; webhook delivery is irrelevant.
4. Generate a private key and download the `.pem` file. Treat it like any other secret.
5. Install the App on your target repository (or org-wide).
6. Add two repository secrets: the App's **Client ID** (visible on the App settings page, looks like `Iv23li…` — not the numeric App ID) and the full multi-line contents of the `.pem` file.

If the secrets are missing the action emits a loud `::warning::` describing the fallback path. The most common reason this is silent is that the secrets are set on a personal account but the workflow runs under an org.

### Visual identity

Commits, comments, PRs, and reviews from Shopfloor appear under the App's bot identity (`<your-app-name>[bot]`). To make Shopfloor commits look like they came from a human, use a fork-based workflow and have a human cherry-pick. Bot-authored PRs are the trade-off for full automation.

## GitHub App for reviews

> **Optional but recommended.** Without it the review aggregator cannot post APPROVE / REQUEST_CHANGES on Shopfloor-authored PRs.

The agent review matrix ends by calling the GitHub `POST /repos/{owner}/{repo}/pulls/{number}/reviews` endpoint with `event: REQUEST_CHANGES` or `event: APPROVE`. GitHub forbids `REQUEST_CHANGES` / `APPROVE` on your own PR, and every Shopfloor PR is authored by the primary App. If the same App also tries to post the review, the API returns `422 Review Can not request changes on your own pull request`.

Shopfloor's fix: the review aggregator uses a **second App installation token** only for the `createReview` call. Labels, comments, statuses, and PR-body edits continue to flow through the primary App. The second App is a distinct identity from the PR author, so the self-review restriction does not apply. Because the reviewer is still an App, the resulting `pull_request_review.submitted` event fires the orchestrator and drives the implement revision loop exactly as a human-posted review would.

### Setup

1. Create a second GitHub App. Name it something like "Shopfloor Reviewer" so it's easy to tell apart from the primary App in PR timelines.
2. Grant these **minimal repository permissions**:
   - **Contents**: Read
   - **Pull requests**: Read & write (for the `createReview` call)
   - **Metadata**: Read
3. **Subscribe to events**: none.
4. Generate a private key and download the `.pem` file.
5. Install the App on the same repositories where Shopfloor runs.
6. Add two repository secrets for the review App's client id and private key.

When both review secrets are unset, Shopfloor still runs the review lenses and computes a verdict, but skips the APPROVE / REQUEST_CHANGES call on Shopfloor-authored PRs.

## Custom GitHub App

If you'd rather not install the official Claude GitHub App, use your primary Shopfloor App for both identity and authorization. Configure the App with the permissions in [GitHub App for the primary surface](#github-app-for-the-primary-surface) above, install it on your repositories, and Shopfloor will use it for everything. Commits and PRs will appear under your App's `[bot]` identity.

## Excluding spec/plan paths from linters

Shopfloor writes spec and plan markdown to `docs/shopfloor/specs/` and `docs/shopfloor/plans/`. The spec and plan agents have no shell access, so they cannot run project formatters over their own output. If your CI runs Prettier, markdownlint, Vale, `cspell`, or similar on every file, add both paths to each tool's ignore list so spec/plan PRs don't fail checks on stylistic differences:

- `.prettierignore`: `docs/shopfloor/specs/` and `docs/shopfloor/plans/`
- `.markdownlintignore` (or `ignores` in `.markdownlint.json`): the same two paths
- Vale `StylesPath` / `[*.md]` block: exclude both
- Any custom "docs lint" job: skip both

You do **not** need to exclude these from the implementation stage's tests — impl PRs include real code changes that should run the full suite. This exclusion is for spec and plan PRs only.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for common first-run issues, including branch protection, CODEOWNERS conflicts, and signed-commit requirements.
