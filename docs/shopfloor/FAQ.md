# Shopfloor FAQ

## Will this commit secrets to my repository?

No. Shopfloor's agents do not have access to any secret directly. Secrets live in GitHub Actions and are forwarded to `claude-code-action` as inputs or into specific env vars for the MCP server. The agents' `Bash` allowlist does not include commands that could exfiltrate env vars (`env`, `printenv`, arbitrary shell), and their commit messages are authored by the bot identity, not by a human who might paste a token.

That said: if you add a secret to the `impl_bash_allowlist` like `Bash(echo $SOME_SECRET)`, the agent will absolutely print it to logs. The allowlist is yours to curate.

## Does it work on private repositories?

Yes. Shopfloor uses the repository's `GITHUB_TOKEN` (or your custom GitHub App's installation token) for every GitHub mutation, so access is scoped to whatever the token can see. Agents downloading user-uploaded attachments from private repos authenticate via the same token through `curl -L -H "Authorization: Bearer $GITHUB_TOKEN"`.

## Can I override the model per stage?

Yes. Every stage has its own model input. See [configuration.md](configuration.md) for the full list — at minimum you can set `triage_model`, `spec_model`, `plan_model`, `impl_model`, and the four `review_*_model` inputs independently.

Common patterns:

- **Budget:** use `haiku` for triage and reviewers, `sonnet` for spec/plan/impl.
- **Quality:** use `sonnet` for triage, `opus` everywhere else.
- **Balanced:** the default is `sonnet` for triage and reviewer-compliance, `opus` for everything else.

## What if I do not want the agent to review my PR?

Apply the `shopfloor:skip-review` label to the PR or to its origin issue. Shopfloor's `check-review-skip` helper will short-circuit the review stage and route the PR into `shopfloor:impl-in-review` so a human can take over. The four reviewer jobs will not run, and nothing will cost you tokens.

You can also permanently disable individual reviewer cells:

```yaml
with:
  review_smells_enabled: false
  review_security_enabled: false
```

## How do I pause the pipeline?

Three ways, each appropriate for a different situation:

- **Pause after triage, waiting for clarifying answers:** the triage agent applies `shopfloor:awaiting-info` automatically when it needs more information. The pipeline pauses until you remove that label.
- **Pause manually at any stage:** close the issue. Every event arriving for a closed issue resolves to `stage=none`, so nothing runs. Reopen to resume.
- **Pause one PR without touching the issue:** convert the PR to draft. `check-review-skip` treats drafts as "do nothing", so the review stage will not fire until you mark it ready for review again.

## What happens if the agent ignores the plan?

The review matrix catches it. The compliance reviewer checks against CLAUDE.md/AGENTS.md/CONTRIBUTING.md. The bugs reviewer compares the diff to the spec and plan and flags missed requirements. The security reviewer looks for concrete exploits. The smells reviewer watches for obvious quality regressions.

If all four see something wrong, the aggregator posts `REQUEST_CHANGES` with batched line comments and Shopfloor triggers an implementation revision run. The agent sees the review comments in its next prompt context and is explicitly instructed to address every one by name.

If the loop runs `max_review_iterations` times without converging, Shopfloor gives up, applies `shopfloor:review-stuck`, and stops. A human is expected to take over from there.

## Who owns the commits and PRs?

Whichever GitHub identity you install. The default (the Claude GitHub App) commits and comments appear under `@claude`. If you register a [custom GitHub App](install.md#custom-github-app), commits appear under your bot. The git author is always the bot — Shopfloor never adds a human co-author to an agent-written commit.

Note: the user's global CLAUDE.md may say "NEVER add Claude/Opus/Sonnet as co-author for any commits". Shopfloor respects that. Agents are prompted not to add any co-author.

## What if Shopfloor is wrong about complexity?

Three recoveries, depending on how wrong:

- **You disagree with the triage classification:** remove the complexity label (`shopfloor:quick`, `shopfloor:medium`, or `shopfloor:large`), apply the one you want, and manually apply the corresponding stage label (`shopfloor:needs-spec`, `shopfloor:needs-plan`, or `shopfloor:needs-impl`).
- **The spec is wrong:** request changes on the spec PR. The agent will see your review comments in the next run and revise.
- **The plan is wrong:** same — request changes on the plan PR. Revision runs re-render the prompt with the previous plan and your review comments, and the agent is instructed to preserve decisions that were not criticized.

## Can I run Shopfloor in dry-run mode?

Not in v0.1. Every stage has real side effects — it posts comments, pushes branches, opens PRs. The closest thing to a dry-run is:

- Set `review_*_enabled: false` to disable the review matrix.
- Use a scratch repository with `shopfloor:skip-review` pre-applied to every issue.
- Watch the stage jobs in the Actions UI without merging any of the PRs they open.

A true `dry_run: true` mode is a reasonable v0.2 feature.

## Why does Shopfloor open a PR for every stage? That is a lot of PRs.

Because every stage is a human checkpoint. The spec PR is a chance to reshape the design before a plan is written. The plan PR is a chance to catch a bad decomposition before real code is committed. The impl PR is the normal code-review flow. Three PRs per feature is roughly the same churn as a normal "design doc → tracking issue → implementation PR" flow, just more explicit and more structured.

If you want fewer PRs for simple changes, triage will classify them as `quick` and skip straight to implementation. `medium` skips the spec. `large` runs all three. The complexity label controls the PR count.

## What if the review loop is giving me too many false positives?

Three dials:

1. **`review_confidence_threshold`** (default 80). Raise it. Comments below the threshold are dropped by the aggregator. Setting it to 90 or 95 will filter out all but the most confident findings.
2. **Disable a specific reviewer cell** — `review_smells_enabled: false` is a common one if you already have a linter.
3. **Drop `max_review_iterations`** to 1 or 2. Shopfloor will give up faster and hand off to a human sooner.

## Does Shopfloor work with monorepos?

Yes, with caveats. The state machine does not know about packages — it treats every issue as a single feature. If your monorepo has multiple packages, you will likely want to:

- Add a `CODEOWNERS` file so package owners get notified on spec/plan/impl PRs.
- Add a `CLAUDE.md` at each package root with package-specific conventions; the compliance reviewer reads them.
- Tune `impl_bash_allowlist` to the monorepo's build tool (e.g., `turbo run test`, `nx run-many`).

## Can I run Shopfloor without Claude at all?

No. The whole point is Claude-driven automation. If you want issue labeling and PR automation without an AI, use a general-purpose action like `github/issue-labeler` or write your own workflow.

## Is the plan file format compatible with [`superpowers:executing-plans`](https://github.com/anthropics/claude-plugins-official)?

Yes — that is the intent. The plan agent is explicitly instructed to invoke `superpowers:writing-plans`, which produces plans in the format that `superpowers:executing-plans` and `superpowers:subagent-driven-development` both consume. The implementation agent then invokes `superpowers:subagent-driven-development` to execute the plan. This is why Shopfloor installs the superpowers plugin automatically.
