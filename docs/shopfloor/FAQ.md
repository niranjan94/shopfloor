# Shopfloor FAQ

## How do I trust Shopfloor? What about supply-chain attacks?

Short answer: do not trust it by default. Audit it, then pin to a SHA.

Shopfloor is [MIT licensed](../../LICENSE) and fully open source. The runtime is a few thousand lines of TypeScript plus the action manifest — small enough to read in an afternoon. Before running it on anything important:

1. **Read the source.** Start with [`src/state/machine.ts`](../../src/state/machine.ts), [`src/github/adapter.ts`](../../src/github/adapter.ts), [`src/orchestrator.ts`](../../src/orchestrator.ts), and the per-stage prompts under [`src/stages/*/prompt.*.md`](../../src/stages/). Every decision Shopfloor makes about your repository originates in one of those places.
2. **Verify the bundled artifact.** The committed `dist/index.cjs` is the actual code that runs on your runners. Clone the repo, run `pnpm build`, and `git diff dist` to confirm the bundle is reproducible from source. CI runs this check on every push to main.
3. **Pin to a 40-character commit SHA, not a moving tag.** `@v2` and even named release tags are mutable. Replace them with a SHA you have audited:

   ```yaml
   uses: niranjan94/shopfloor@<40-char-sha>
   ```

   Then let Dependabot or Renovate propose SHA bumps as normal pull requests you review like any other dependency update.

4. **Fork if you need full control.** Forking `niranjan94/shopfloor` and pinning your caller to your fork removes the upstream maintainer from your supply chain entirely. You can still pull upstream changes manually when you want to.

If none of those steps is acceptable for your threat model, do not run Shopfloor on production repositories. Use it on scratch repositories and personal projects first. See the [install guide](install.md#step-0-audit-the-source-before-you-trust-it) for the full recommended workflow.

## Will this commit secrets to my repository?

No. Shopfloor's agents do not have access to any repository secret directly. Secrets live in GitHub Actions and are read by the action's entry point; they are never injected into prompt context or made available as agent tools. The agent SDK's default tool surface does not include arbitrary shell access, and commit authorship is the bot identity.

That said: agents will print anything you tell them to print. If you inline a token into a prompt or expose it through a custom MCP tool, the agent can log it. Don't.

## Does it work on private repositories?

Yes. Shopfloor uses your GitHub App's installation token (or `GITHUB_TOKEN` if you fall back to it) for every mutation, so access is scoped to whatever the token can see. Agents downloading user-uploaded attachments from private repos authenticate via the same token.

## Can I override the model per stage?

Yes. Every stage has its own model input. See [configuration.md](configuration.md) for the full list — at minimum you can set `triage_model`, `spec_model`, `plan_model`, `impl_model`, and the four `review_*_model` inputs independently.

Common patterns:

- **Budget:** use `claude-haiku` for triage and all four reviewer lenses, `claude-sonnet` for spec/plan/impl.
- **Quality:** use `claude-opus` everywhere.
- **Balanced (the default):** `claude-haiku` for triage, `claude-opus` for spec/plan/impl and all four reviewer lenses.

## What if I do not want the agent to review my PR?

Apply the `shopfloor:skip-review` label to the PR or to its origin issue. The state machine returns `stage=none` and the four reviewer lenses do not run. Nothing will cost you tokens.

Per-lens enable/disable toggles are not exposed as inputs in v2. If a specific lens is consistently noisy on your codebase, open an issue.

## How do I pause the pipeline?

Three ways, each appropriate for a different situation:

- **Pause after triage, waiting for clarifying answers:** the triage agent applies `shopfloor:awaiting-info` automatically when it needs more information. The pipeline pauses until you remove that label.
- **Pause manually at any stage:** close the issue. Every event arriving for a closed issue resolves to `stage=none`, so nothing runs. Reopen to resume.
- **Pause one PR without touching the issue:** convert the PR to draft, or apply the `shopfloor:wip` label. The state machine treats both as "do nothing"; the review stage does not fire until you mark the PR ready for review (or remove the WIP label).

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

Not yet. Every stage has real side effects — it posts comments, pushes branches, opens PRs. The closest thing to a dry-run is:

- Use a scratch repository with `shopfloor:skip-review` pre-applied to every issue to suppress the review matrix.
- Watch the workflow runs in the Actions UI without merging any of the PRs they open.

A true `dry_run: true` mode is a reasonable future feature; open an issue if you'd use it.

## Why does Shopfloor open a PR for every stage? That is a lot of PRs.

Because every stage is a human checkpoint. The spec PR is a chance to reshape the design before a plan is written. The plan PR is a chance to catch a bad decomposition before real code is committed. The impl PR is the normal code-review flow. Three PRs per feature is roughly the same churn as a normal "design doc → tracking issue → implementation PR" flow, just more explicit and more structured.

If you want fewer PRs for simple changes, triage will classify them as `quick` and skip straight to implementation. `medium` skips the spec. `large` runs all three. The complexity label controls the PR count.

## What if the review loop is giving me too many false positives?

The dials available in v2:

1. **Drop `max_review_iterations`** to 1 or 2. Shopfloor will give up faster and hand off to a human sooner (the PR gets `shopfloor:review-stuck`).
2. **Apply `shopfloor:skip-review`** on PRs you want to land without an agent pass.

The confidence threshold (hardcoded to 60) and per-lens enable toggles are not currently exposed. If a specific lens is consistently noisy on your codebase, open an issue.

## Does Shopfloor work with monorepos?

Yes, with caveats. The state machine does not know about packages — it treats every issue as a single feature. If your monorepo has multiple packages, you will likely want to:

- Add a `CODEOWNERS` file so package owners get notified on spec/plan/impl PRs.
- Add a `CLAUDE.md` at each package root with package-specific conventions; the compliance reviewer reads them.

## Can I run Shopfloor without Claude at all?

No. The whole point is Claude-driven automation. If you want issue labeling and PR automation without an AI, use a general-purpose action like `github/issue-labeler` or write your own workflow.

## Is the plan file format compatible with [`superpowers:executing-plans`](https://github.com/anthropics/claude-plugins-official)?

Yes — that is the intent. The plan agent is explicitly instructed to invoke `superpowers:writing-plans`, which produces plans in the format that `superpowers:executing-plans` and `superpowers:subagent-driven-development` both consume. The implementation agent then invokes `superpowers:subagent-driven-development` to execute the plan. This is why Shopfloor installs the superpowers plugin automatically.
