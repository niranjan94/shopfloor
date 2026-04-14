# Troubleshooting Shopfloor

Common problems and how to unstick them.

## The workflow does not run at all

**Symptom:** You opened an issue but nothing happened. No `route` job. No triage comment.

**Check:**

1. Is `.github/workflows/shopfloor.yml` on the default branch? GitHub only uses the caller workflow from the default branch.
2. Does the caller `on:` block include `issues: types: [opened, ...]`? If you edited the trigger list, an `opened` event may have been dropped.
3. Look at **Actions → All workflows** for a failed run. If Actions shows nothing at all, the workflow file has a YAML parse error — GitHub ignores invalid workflow files silently.
4. Is GitHub Actions enabled for the repository? **Settings → Actions → General → Allow all actions and reusable workflows.**

## Triage posts nothing

**Symptom:** The `route` job runs and resolves to `stage=triage`, but the `triage` job either fails silently or produces no comment.

**Check:**

1. Inspect the `triage` job logs. The most common failure is a missing provider credential — look for "anthropic_api_key is required" or similar.
2. Verify the secret name. `ANTHROPIC_API_KEY` in repo secrets is passed as `secrets.ANTHROPIC_API_KEY` to the reusable workflow, which expects `anthropic_api_key` (lowercase). `secrets: inherit` handles this automatically; explicit forwarding requires the right casing.
3. If the agent ran but the "Apply triage decision" step failed, the structured output was malformed. Open the agent step logs to see what JSON the model returned.

## Spec / plan / impl branch is not pushed

**Symptom:** The agent step succeeds, but the "Commit and push" step fails with "Permission denied" or "remote rejected".

**Check:**

1. **Branch protection rules on the default branch may require signed commits, PR reviews, or specific status checks.** Shopfloor pushes to a new branch (never directly to `main`), so most rules do not apply to the push itself. But rules like "Require signed commits" apply to the new branch too.
2. Turn on signed commits: add the `SSH_SIGNING_KEY` secret, set `ssh_signing_key_enabled: true` in the caller, and confirm the key is registered with the GitHub App's identity.
3. Check the Claude GitHub App's repository permissions. It needs **Contents: Read and write** to push branches.

## PRs cannot be opened

**Symptom:** The branch pushes successfully, but the "Open stage PR" step fails with 403 or "Resource not accessible by integration".

**Check:**

1. The caller workflow's `permissions:` block must include `pull-requests: write`, `contents: write`, and `issues: write`. See [install.md](install.md) for the canonical snippet.
2. If you use a custom GitHub App, it needs **Pull requests: Read and write**.
3. If your org has "Restrict who can create pull requests to members of the organization" enabled, the bot identity must be an org member.

## CODEOWNERS blocks merges

**Symptom:** Spec/plan/impl PRs open successfully but require your CODEOWNERS approval to merge, and you want Shopfloor's reviewer matrix to count.

**Check:**

1. The Shopfloor review matrix posts its combined review as a `REQUEST_CHANGES` or `APPROVE` from whichever identity `claude-code-action` uses. This does NOT satisfy CODEOWNERS unless the reviewing identity is the code owner.
2. Add the Shopfloor bot identity to CODEOWNERS if you want its approval to unblock merges. For the Claude GitHub App, that is `@claude` or the login configured for your custom app.
3. Alternatively, leave CODEOWNERS as-is and treat the Shopfloor review as advisory input that a human merges on top of.

## Signed commit requirement is failing

**Symptom:** "Commits are not signed" in the PR merge UI.

**Check:**

1. Set `ssh_signing_key_enabled: true` in the caller workflow.
2. Add the `SSH_SIGNING_KEY` secret (the full private key, not a path).
3. Verify the public half is registered as a signing key on the GitHub App or user identity Shopfloor runs under. Go to **Settings → SSH and GPG keys → New SSH key**, select the "Signing Key" type, and paste the public half.
4. If you see "No signing key configured", the workflow did not set up signing at all — check that the secret exists and is named exactly `SSH_SIGNING_KEY`.

## Custom PR templates conflict

**Symptom:** Shopfloor's PRs have a weird body that mixes your template placeholders with the metadata block.

**Cause:** GitHub fills the body of a newly opened PR with `.github/pull_request_template.md` by default, but the `open-stage-pr` helper passes an explicit body string that overrides the template. So the template is NOT applied to Shopfloor PRs — which is usually what you want, because the spec/plan/impl bodies are agent-generated and already include everything the reviewer needs.

If you want your template applied on top, merge its contents into the prompt's `pr_body` output field in the appropriate prompt file under `prompts/`.

## Stage fails and stays stuck

**Symptom:** The pipeline stops mid-run. The issue has a `shopfloor:failed:<stage>` label and nothing is advancing.

**Recovery:**

1. Click through to the failed workflow run linked in the diagnostic comment.
2. Fix whatever caused the failure (often an expired secret, a hit turn budget, or a contradictory plan).
3. Remove the `shopfloor:failed:<stage>` label from the issue. Shopfloor will re-run the stage from scratch on the next applicable event — you may need to nudge it by removing and re-adding the stage's `needs-*` label.

## Review loop goes `review-stuck`

**Symptom:** After some iterations, the impl PR has `shopfloor:review-stuck`, the commit status is failing, and nothing else runs.

**Meaning:** The review matrix ran `max_review_iterations` times without converging. The agent was unable to satisfy the reviewers, and Shopfloor gave up.

**Recovery:**

1. Read the latest review comment on the PR. It lists the outstanding findings.
2. Either fix them yourself in a new commit, or push a different implementation and then manually remove `shopfloor:review-stuck`. Removing the label force-triggers one more review.
3. If the reviewer is wrong (false positive), the cleanest fix is to bump `review_confidence_threshold` or disable the offending review cell (see [configuration.md](configuration.md)).

## `skip-review` for docs-only PRs

**Symptom:** You want to bypass the review matrix for a specific PR.

**Fix:** Apply the `shopfloor:skip-review` label to either the PR itself or its origin issue. The `check-review-skip` helper will short-circuit the review stage and the PR will land in `shopfloor:impl-in-review` instead of `shopfloor:needs-review`.

Shopfloor also auto-skips review when the PR's changed files are all inside `docs/shopfloor/` — you do not need `skip-review` for spec/plan-only PRs.

## GHES (GitHub Enterprise Server)

**Symptom:** You are running Shopfloor against a GHES instance and some calls are going to the wrong host.

**Check:**

1. The Shopfloor MCP server reads `GITHUB_API_URL` from the environment; the workflow sets this from `${{ github.api_url }}` which resolves correctly on GHES.
2. The `gh` CLI (used by agents for `Bash(gh api:*)`) reads `GH_HOST` or `GITHUB_API_URL`; GitHub Actions sets these automatically on GHES runners.
3. Agents that fetch user-uploaded attachments via `curl` need the GHES base host. GHES rewrites `github.com/user-attachments/...` URLs to its own host; the agent should use whatever URL appears in the issue body without rewriting.

If the agent is hardcoding `github.com` somewhere, that is a bug — open an issue.

## Debugging agent behavior

**Turn on verbose logs:** every `claude-code-action` run uploads a transcript as a workflow artifact. Open the workflow run, click **Summary**, and download the artifact to see the full model transcript for that stage.

**Reproduce locally:** Shopfloor agents are not interactive, so you can replay a stage by running the agent prompt file directly with `claude-code` CLI and the same context JSON the workflow built. See `router/test/prompt-render.test.ts` for examples of context shapes.

## Still stuck?

Open an issue at [niranjan94/shopfloor/issues](https://github.com/niranjan94/shopfloor/issues) with:

- The workflow run URL (redacted if sensitive)
- The `router/src/state.ts` decision reason from the `route` job logs
- The event name and action that triggered it
- Whatever you have already tried

The more specific, the faster we can help.
