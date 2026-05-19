# Smoke runner

Local TypeScript runner that drives `niranjan94/shopfloor-smoke` through a fixed catalogue of end-to-end scenarios against the real `niranjan94/shopfloor@v2` action.

This is a developer tool. It is not invoked from CI by default. Each full run burns roughly 30 to 40 minutes of GitHub Actions time on the smoke repo and a non-trivial number of Anthropic API tokens.

## Setup

1. Mint a fine-grained personal access token scoped to `niranjan94/shopfloor-smoke`:
   - Issues: read / write
   - Pull requests: read / write
   - Contents: read / write
   - Administration: read / write (required for GraphQL `deleteIssue`)

2. Copy `.env.example` to `.env` and fill in the token plus the bot logins for the Shopfloor apps installed on `shopfloor-smoke`.

3. Make sure `niranjan94/shopfloor`'s `v2` ref points at the commit you want to test. The runner does NOT push this for you. From this repo:

   ```bash
   git push origin HEAD:refs/tags/v2 --force   # only if you really want v2 = current HEAD
   ```

## Running

```bash
pnpm smoke                            # all scenarios in parallel
pnpm smoke -- --only quick,medium     # subset
pnpm smoke -- --sequential            # one at a time (easier logs)
pnpm smoke -- --tag X                 # reuse a tag (debugging)
pnpm smoke -- --allow-stale           # skip the previous-run gate
pnpm smoke -- --poll-ms 15000         # override default poll interval (debugging the runner)
pnpm smoke -- cleanup                 # close PRs, delete branches, delete issues for any smoke-* artifact
pnpm smoke -- cleanup --tag X         # cleanup only artifacts tagged X
```

Exit code: 0 if every scenario is PASS or PASS\*. Nonzero if any FAIL or TIMEOUT.

## Scenarios

| ID                     | Path                                                                               | Timeout | Notes                                         |
| ---------------------- | ---------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
| quick                  | triage(quick) -> impl -> review -> merge -> done                                   | 10m     |                                               |
| medium                 | triage(medium) -> plan -> merge -> impl -> review -> merge -> done                 | 20m     |                                               |
| large                  | triage(large) -> spec -> merge -> plan -> merge -> impl -> review -> merge -> done | 40m     |                                               |
| awaiting-info          | vague brief -> triage clarifies -> answer -> triage classifies                     | 10m     |                                               |
| review-only            | human-authored PR -> shopfloor-review.yml posts review                             | 12m     | Asserts on `<!-- shopfloor-review -->` marker |
| revision-loop          | impl -> request-changes -> revise -> approve                                       | 20m     | `flaky: true`. First-shot approve = PASS\*    |
| skip-review-and-revise | skip-review path + revise(plan)                                                    | 15m     | Two micro-scenarios in one file               |

## Cleanup model

Issues are deleted via GraphQL (`deleteIssue` mutation). PRs cannot be deleted via the GitHub API. The runner closes them and deletes their branches. PRs persist in the timeline as `closed - branch deleted` forever; this is a GitHub limitation, not a runner bug.

Cleanup on PASS is automatic per scenario. On FAIL or TIMEOUT, artifacts are left in place for inspection. Run `pnpm smoke -- cleanup` to purge everything matching `smoke-` (or pass `--tag X` to scope).

## Known flakiness

- **revision-loop** is flagged `flaky: true`. If the review approves the first impl iteration, the scenario returns `PASS*` rather than failing, because the loop wasn't exercised but nothing is actually broken. This is unavoidable without a deterministic way to force `REQUEST_CHANGES`.
- **Triage classification drift** between runs is possible. The same brief may be classified `quick` or `medium`. Scenarios that care use a regex (`/^shopfloor:(quick|medium)$/`) rather than pinning the exact label.

## Maintenance

If the PR footer format in `src/state/metadata.ts` changes, update the matching regex in `scripts/smoke/lib/footer.ts` and the test in `test/smoke/footer.test.ts`. If the review marker in `src/stages/review/aggregate.ts` changes, update `scripts/smoke/scenarios/review-only.ts`. These duplications are deliberate: the smoke runner intentionally does not import from `src/`.
