# Troubleshooting Shopfloor

Common problems and how to unstick them.

## The workflow does not run at all

**Symptom:** You opened an issue but nothing happened. No workflow run. No triage comment.

**Check:**

1. Is `.github/workflows/shopfloor.yml` on the default branch? GitHub only uses workflows from the default branch.
2. Does the caller `on:` block include `issues: types: [opened, labeled, unlabeled]`? Editing the trigger list can drop the `opened` event.
3. Look at **Actions → All workflows** for a failed run. If Actions shows nothing at all, the workflow file has a YAML parse error — GitHub ignores invalid workflow files silently.
4. Is GitHub Actions enabled for the repository? **Settings → Actions → General → Allow all actions and reusable workflows.**
5. If you set `trigger_label`, does the issue carry that label? Issues without it resolve to `stage=none` and produce no visible output.

## Triage posts nothing

**Symptom:** The workflow ran and the state machine resolved to `stage=triage`, but no comment appeared on the issue.

**Check:**

1. Inspect the workflow run logs. Look for "one of anthropic_api_key or claude_code_oauth_token is required" — that means the credential was not passed through (typically a typo or unset secret).
2. If the agent ran but the apply step failed, the agent's structured output was malformed. The Zod schema validation error in the logs identifies which field. This usually means the model returned text instead of JSON — try raising `triage_model` or check that the prompt template was bundled correctly.
3. Check whether the issue is gated by a `shopfloor:failed:triage` label from a previous run. Remove it to retry.

## Spec / plan / impl branch is not pushed

**Symptom:** The agent step succeeds, but the "Commit and push" step fails with "Permission denied" or "remote rejected".

**Check:**

1. **Branch protection rules on the default branch may require signed commits, PR reviews, or specific status checks.** Shopfloor pushes to a new branch (never directly to `main`), so most rules do not apply to the push itself. But rules like "Require signed commits" apply to the new branch too.
2. Turn on signed commits: add `SSH_SIGNING_KEY` as a secret, pass it via the `ssh_signing_key` input, and confirm the public half is registered as a signing key on the GitHub App's identity.
3. Check the GitHub App's repository permissions. It needs **Contents: Read and write** to push branches.
4. Check that `actions/checkout` in your caller workflow has `with: persist-credentials: false`. Without it, the GITHUB_TOKEN extraheader checkout writes into git config overrides the App token Shopfloor uses for pushes, and pushes 403.

## PRs cannot be opened

**Symptom:** The branch pushes successfully, but the "Open stage PR" step fails with 403 or "Resource not accessible by integration".

**Check:**

1. With App credentials, the caller workflow's `permissions:` block can stay read-only — every write goes through the App installation token. If you're on the `github_token` fallback path, the workflow needs `pull-requests: write`, `contents: write`, and `issues: write`.
2. The primary App needs **Pull requests: Read and write**, **Issues: Read and write**, **Contents: Read and write**, and **Commit statuses: Read and write**. See [install.md](install.md#setup) for the full list.
3. If your org has "Restrict who can create pull requests to members of the organization" enabled, the bot identity must be an org member.

## CODEOWNERS blocks merges

**Symptom:** Spec/plan/impl PRs open successfully but require your CODEOWNERS approval to merge, and you want Shopfloor's reviewer matrix to count.

**Check:**

1. The Shopfloor review matrix posts its combined verdict from whichever review-App identity you configured (or the primary App, if no review App is set). This does NOT satisfy CODEOWNERS unless the reviewing identity is the code owner.
2. Add the Shopfloor review bot identity to CODEOWNERS if you want its approval to unblock merges.
3. Alternatively, leave CODEOWNERS as-is and treat the Shopfloor review as advisory input a human merges on top of.

## Signed commit requirement is failing

**Symptom:** "Commits are not signed" in the PR merge UI.

**Check:**

1. Pass the private key via the `ssh_signing_key` input (`ssh_signing_key: ${{ secrets.SSH_SIGNING_KEY }}`).
2. The secret's value should be the **full** private key contents, not a path.
3. Verify the public half is registered as a signing key on the GitHub App identity Shopfloor commits under. Go to **Settings → SSH and GPG keys → New SSH key**, select the "Signing Key" type, and paste the public half.
4. If commits are still unsigned, check the workflow run logs for git config errors — Shopfloor sets up signing at the start of each stage.

## Custom PR templates conflict

**Symptom:** Shopfloor's PRs have a weird body that mixes your template placeholders with the metadata block.

**Cause:** GitHub fills the body of a newly opened PR with `.github/pull_request_template.md` by default, but [`GitHubAdapter.openStagePr`](../../src/github/adapter.ts) passes an explicit body string that overrides the template. So the template is NOT applied to Shopfloor PRs — which is usually what you want, because the spec/plan/impl bodies are agent-generated and already include everything the reviewer needs.

If you want your template applied on top, edit the relevant stage prompt under `src/stages/<stage>/prompt.*.md` so the agent's `pr_body` field includes your template content.

## Stage fails and stays stuck

**Symptom:** The pipeline stops mid-run. The issue has a `shopfloor:failed:<stage>` label and nothing is advancing.

**Recovery:**

1. Click through to the failed workflow run linked in the diagnostic comment.
2. Fix whatever caused the failure (often an expired secret, a hit budget, or a contradictory plan).
3. Remove the `shopfloor:failed:<stage>` label from the issue. The state machine treats this as an explicit retry signal — Shopfloor re-runs the stage from scratch.

## Review loop goes `review-stuck`

**Symptom:** After some iterations, the impl PR has `shopfloor:review-stuck`, the commit status is failing, and nothing else runs.

**Meaning:** The review matrix ran `max_review_iterations` times without converging. The agent was unable to satisfy the reviewers, and Shopfloor gave up.

**Recovery:**

1. Read the latest review comment on the PR. It lists the outstanding findings.
2. Either fix them yourself in a new commit, or push a different implementation and then remove `shopfloor:review-stuck`. Removing the label force-triggers one more review.
3. If the reviewer is wrong (false positive) and this pattern is persistent on your codebase, open an issue. The confidence threshold and per-lens toggles are not currently exposed as inputs.

## `skip-review` for docs-only PRs

**Symptom:** You want to bypass the review matrix for a specific PR.

**Fix:** Apply the `shopfloor:skip-review` label to either the PR itself or its origin issue. The state machine returns `stage=none` with reason `skip_review_label_present` and the review pipeline does not fire.

Spec and plan PRs are not subject to the agent review matrix in the first place — that matrix only runs on impl PRs.

## GHES (GitHub Enterprise Server)

**Symptom:** You are running Shopfloor against a GHES instance and some calls are going to the wrong host.

**Check:**

1. Octokit reads `GITHUB_API_URL` from the environment; GitHub Actions sets this from `${{ github.api_url }}` on GHES runners.
2. Agents that fetch user-uploaded attachments via `curl` need the GHES base host. GHES rewrites `github.com/user-attachments/...` URLs to its own host; the agent should use whatever URL appears in the issue body without rewriting.

If anything in Shopfloor is hardcoding `github.com`, that is a bug — open an issue.

## Debugging agent behavior

Shopfloor emits structured audit events through `@actions/core` for every stage (`stage_resolved`, `stage_decided`, `stage_failed`, etc.). Open the workflow run and read the logs to see what the orchestrator decided and why.

To reproduce a stage's prompt locally, copy the rendered system + user prompts from the workflow logs into a `claude` CLI session with the same model. The prompt templates themselves live under `src/stages/<stage>/prompt.*.md` and are bundled into `dist/index.cjs` at build time.

## Stalled pipeline recovery

**Symptom:** An issue is carrying `shopfloor:needs-spec` / `shopfloor:needs-plan` / `shopfloor:needs-impl` but the corresponding stage job never ran, OR a stage job shows a precheck-skip notice with `reason=*_already_in_progress` after a crash.

**Cause:** A runner crashed mid-stage and left a mutex label orphaned (`shopfloor:spec-running`, `shopfloor:plan-running`, `shopfloor:implementing`, or `shopfloor:review-running`). The orchestrator's precheck refuses to run a stage when its mutex is held.

**Recovery:**

```bash
# Replace <N> with the issue number.
N=123

# 1. Remove any orphaned mutex markers:
gh issue edit $N \
  --remove-label shopfloor:implementing \
  --remove-label shopfloor:spec-running \
  --remove-label shopfloor:plan-running \
  --remove-label shopfloor:review-running

# 2. Re-fire the advancement event by cycling the expected next-state label:
EXPECTED=shopfloor:needs-impl   # or needs-spec / needs-plan as appropriate
gh issue edit $N --remove-label "$EXPECTED"
gh issue edit $N --add-label "$EXPECTED"
```

Run these as a user with permission on the repo. The add-label event fires the workflow on your behalf, which is fine — your user actions trigger downstream workflows just like a normal label flip would.

## Still stuck?

Open an issue at [niranjan94/shopfloor/issues](https://github.com/niranjan94/shopfloor/issues) with:

- The workflow run URL (redacted if sensitive)
- The state machine's decision reason from the orchestrator logs (`stage_resolved` audit event)
- The event name and action that triggered it
- Whatever you have already tried

The more specific, the faster we can help.
