# Consumer Setup Hook for Shopfloor Agent Stages

## Problem

Every consumer of Shopfloor's reusable workflow runs Claude against an
unconfigured workspace: a clean `actions/checkout` and nothing else. Real
projects need a configured workspace before any meaningful exploration:
dependencies installed, `.env` written, package registries authenticated,
peer repositories cloned, background services started.

A representative consumer (`konfirmity-frontend`) has an
`./.github/actions/setup` composite action that does all of the above —
`pnpm install`, Playwright browser install, `.env` materialization with
ten Clerk-related secrets, a separate GitHub App token mint to clone two
private peer repos (`konfirmity/bricks`, `Konfirmity/frontend-testcases`),
and a backgrounded storybook server. None of this can run inside Shopfloor
today.

Without a hook, the only options are:

1. Fork `shopfloor.yml` and inline setup steps. Defeats the point of a
   reusable workflow.
2. Skip dependency-aware tooling. The triage / spec / plan / implement
   agents lose `pnpm exec tsc`, resolved imports for grep, working tests.

This spec describes a generic, opt-in hook that lets consumers run a
composite action of their own design before the agent step on every
agent stage, with a clean contract for forwarding values (including
secrets) into the action's environment.

## Goals

- Consumers can run arbitrary setup (other actions, shells, services)
  before each agent stage, with a configured workspace by the time
  `claude-code-action` starts.
- The hook is opt-in. Default behavior (no hook configured) is unchanged
  for every existing consumer.
- Secrets and multi-line values (PEM keys, `.env` blobs) flow safely from
  the caller workflow into the consumer's setup action without log leaks.
- Setup runs on the four agent stages by default. Review stages
  (read-only PR commenters) only run setup when explicitly opted in.
- Zero changes required to `router/`, `prompts/`, or `mcp-servers/`.

## Non-goals

- Caching `node_modules` or other build artifacts across Shopfloor runs.
  Consumers handle this inside their own setup action via
  `actions/setup-node` / `actions/cache`.
- Auto-detecting the consumer's setup action without an explicit
  opt-in. Implicit behavior is rejected; consumers must declare intent.
- Running setup before pre-checkout-dependent steps (App token mint,
  precheck). Setup runs after the workspace is ready and after Shopfloor
  has decided this stage will actually execute.
- Generalizing setup to `route`, `bootstrap-labels`, `review-skip-check`,
  `review-aggregator`, or `handle-merge`. None of those jobs touch the
  codebase.
- Letting the consumer's setup action live at an arbitrary path.
  GitHub Actions does not allow expressions in `uses:`, and a runtime
  trampoline workaround was rejected in favor of a fixed convention path.

## User-facing contract

### What the consumer puts in their repo

A composite action at exactly:

```
./.github/actions/shopfloor-setup/action.yml
```

The action takes **no `inputs:`**. It reads everything from environment
variables. Shopfloor exports four well-known variables on every invocation:

| Variable                | Source                                        |
| ----------------------- | --------------------------------------------- |
| `SHOPFLOOR_STAGE`       | Literal job name (`triage`, `spec`, `plan`, `implement`, `review-compliance`, `review-bugs`, `review-security`, `review-smells`) |
| `SHOPFLOOR_ISSUE_NUMBER`| `needs.route.outputs.issue_number`            |
| `SHOPFLOOR_BRANCH_NAME` | `needs.route.outputs.branch_name`             |
| `SHOPFLOOR_GITHUB_TOKEN`| Stage's pre-agent App installation token, or `secrets.GITHUB_TOKEN` if no Shopfloor App is configured |

Any further values the action needs (Clerk keys, `.env` content, peer-App
credentials) come from the `setup_env_json` secret described below. Each
key in that JSON object becomes an env var of the same name in the job
running setup.

### What the consumer puts in their caller workflow

```yaml
jobs:
  shopfloor:
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@main
    with:
      setup_enabled: true
      # setup_review_enabled: true  # only if review jobs need a built workspace
    secrets:
      ...existing Shopfloor secrets...
      setup_env_json: |
        {
          "APP_ID": "${{ vars.GH_APP_ID }}",
          "PRIVATE_KEY": ${{ toJSON(secrets.GH_APP_PRIVATE_KEY) }},
          "DOT_ENV": ${{ toJSON(vars.DOT_ENV) }},
          "CLERK_SECRET_KEY": "${{ secrets.CLERK_SECRET_KEY }}"
        }
```

`toJSON()` is required for any value containing newlines or quote characters
(PEM keys, multi-line `.env` blobs). Single-line scalars use the
double-quoted string form.

When `setup_enabled` is false (the default) Shopfloor behaves exactly as
today and ignores `setup_env_json` entirely.

### Disallowed configurations

- `setup_review_enabled: true` while `setup_enabled: false` is a no-op,
  not an error. The review hook is gated on both.
- A composite action at `./.github/actions/shopfloor-setup` declaring
  `inputs:` is allowed but unused. Shopfloor never passes inputs.
- Malformed JSON in `setup_env_json` causes the export step to fail with
  a `jq` parse error. This is a fail-loud, fail-early signal.

## Architecture

### New workflow surface in `.github/workflows/shopfloor.yml`

Two new inputs and one new secret declared at the top of `workflow_call`:

```yaml
setup_enabled:
  type: boolean
  default: false
  description: >-
    When true, Shopfloor invokes ./.github/actions/shopfloor-setup on every
    agent stage between precheck and the agent step. The action must exist
    at exactly that path. When false (default), no setup runs and
    setup_env_json is ignored.

setup_review_enabled:
  type: boolean
  default: false
  description: >-
    When true AND setup_enabled is true, also runs the setup action on the
    four review stages (review-compliance, review-bugs, review-security,
    review-smells). Off by default since reviews are read-only PR
    commenters that rarely need a built workspace.
```

```yaml
# under secrets:
setup_env_json:
  required: false
  description: >-
    JSON object whose keys/values are exported as env vars in every job
    that runs setup. Use toJSON() in the caller workflow for multi-line
    values (PEM keys, .env blobs). Each value is registered for log
    masking via ::add-mask::.
```

### Per-job step insertions

Each agent job (`triage`, `spec`, `plan`, `implement`) gains two
contiguous steps. The same two steps are inserted into the four review
jobs, gated additionally on `inputs.setup_review_enabled`.

```yaml
- name: Export Shopfloor setup env
  if: inputs.setup_enabled && steps.precheck.outputs.skip != 'true'
  env:
    SETUP_ENV_JSON: ${{ secrets.setup_env_json }}
    SHOPFLOOR_STAGE: triage  # literal, varies per job
    SHOPFLOOR_ISSUE_NUMBER: ${{ needs.route.outputs.issue_number }}
    SHOPFLOOR_BRANCH_NAME: ${{ needs.route.outputs.branch_name }}
    SHOPFLOOR_GITHUB_TOKEN: ${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}
  run: |
    {
      printf 'SHOPFLOOR_STAGE=%s\n' "$SHOPFLOOR_STAGE"
      printf 'SHOPFLOOR_ISSUE_NUMBER=%s\n' "$SHOPFLOOR_ISSUE_NUMBER"
      printf 'SHOPFLOOR_BRANCH_NAME=%s\n' "$SHOPFLOOR_BRANCH_NAME"
      printf 'SHOPFLOOR_GITHUB_TOKEN=%s\n' "$SHOPFLOOR_GITHUB_TOKEN"
    } >> "$GITHUB_ENV"
    if [ -n "$SETUP_ENV_JSON" ]; then
      # Register every value for log masking BEFORE writing them anywhere
      # the runner could log. secrets.setup_env_json is masked as a single
      # blob; substring values inside it are not, so they would otherwise
      # leak in clear text in subsequent logs.
      while IFS= read -r v; do
        [ -n "$v" ] && echo "::add-mask::$v"
      done < <(printf '%s' "$SETUP_ENV_JSON" | jq -r '.[] | tostring')
      # Use the GITHUB_ENV multi-line delimiter form so PEM keys and .env
      # content survive intact. The delimiter is randomized per run to
      # avoid the (vanishingly unlikely) collision with a value that
      # contains the literal delimiter token.
      DELIM="SHOPFLOOR_ENV_$(date +%s%N)_$RANDOM"
      printf '%s' "$SETUP_ENV_JSON" | jq -r --arg d "$DELIM" '
        to_entries[] | "\(.key)<<\($d)\n\(.value)\n\($d)"
      ' >> "$GITHUB_ENV"
    fi

- name: Run consumer setup
  if: inputs.setup_enabled && steps.precheck.outputs.skip != 'true'
  uses: ./.github/actions/shopfloor-setup
```

For review jobs the gate becomes
`inputs.setup_enabled && inputs.setup_review_enabled`, the
`SHOPFLOOR_STAGE` literal becomes the review job name, and there is no
`steps.precheck.outputs.skip` clause (review jobs have no precheck step).

### Insertion point per stage

| Job             | Inserted between                                                                  |
| --------------- | --------------------------------------------------------------------------------- |
| `triage`        | `Mark triage as running` ↔ `Build triage context`                                 |
| `spec`          | `Mark spec as running` ↔ `Build spec context` (or revision builder, whichever runs) |
| `plan`          | `Mark plan as running` ↔ `Build plan context` (or revision builder, whichever runs) |
| `implement`     | `Mark implement as running` ↔ `Create impl branch`                                |
| `review-*` (×4) | Immediately after `actions/checkout`, gated on `setup_review_enabled`             |

For `implement` specifically, setup runs **before** the impl branch is
created. Two reasons:

1. The expensive parts (`pnpm install`, Playwright browser install, peer
   repo clones, storybook server start) are branch-agnostic. Doing them
   on the default branch and letting the subsequent
   `git checkout -b "$BRANCH_NAME"` preserve untracked files (`.env`,
   `node_modules`, `.bricks/`, `.test-plans/`) is the natural ordering.
2. Revision runs replace the branch creation step with
   `Checkout existing impl branch` (a fetch + checkout). Setup still runs
   before that fetch and the same untracked files survive.

### Why setup runs after precheck

Precheck can decide a stage will skip (label race conditions, an issue
that has already advanced past this stage). Running setup before precheck
would mean paying the install/clone/server-start costs only to throw the
work away. The `if: ... && steps.precheck.outputs.skip != 'true'` gate
ensures setup only runs when the agent is actually going to follow.

### Trampoline rejected

An earlier draft of this design accepted a `setup_action_path` input and
generated a runtime trampoline `action.yml` (literal `uses:` baked in via
shell heredoc) so the consumer's action could live at any path.

Rejected for this version because:

- The hardcoded path adds a one-time placement cost (rename or wrap) and
  removes runtime YAML generation, an unnecessary moving part.
- A trampoline file in the workspace is untracked and risks being
  staged by a permissive `git add` from the agent or the consumer's
  setup itself.
- Future flexibility is reachable: the input-driven trampoline approach
  is additive and can ship later without breaking the convention path.

If a consumer cannot rename their existing `./.github/actions/setup`
(e.g. other workflows reference it), they wrap it:

```yaml
# .github/actions/shopfloor-setup/action.yml
name: 'Shopfloor setup wrapper'
description: 'Delegates to the canonical project setup action.'
runs:
  using: 'composite'
  steps:
    - uses: ./.github/actions/setup
```

`uses: ./relative` inside a composite action resolves relative to
`GITHUB_WORKSPACE`, so the wrapper-and-delegate pattern works without
path math.

## Caller migration: konfirmity-frontend

Two files change.

### `./.github/actions/setup/action.yml`

Refactored to read everything from env vars. No `inputs:` block. Echo
calls switched to `printf '%s\n'` so backslash- and dollar-bearing values
in `DOT_ENV` and PEM keys survive intact. `persist-credentials: false`
added to peer-repo `actions/checkout` calls (matches Shopfloor's own
checkout discipline). The action itself moves to (or is wrapped at)
`./.github/actions/shopfloor-setup`.

```yaml
name: 'Setup Project'
description: 'Install dependencies and setup project for Shopfloor agents'

runs:
  using: 'composite'
  steps:
    - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v5.0.0
      with:
        version: 10
        run_install: false
    - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
      with:
        node-version: lts/*
        cache: pnpm
    - name: Authenticate pnpm
      shell: bash
      run: pnpm config set "//npm.pkg.github.com/:_authToken=${SHOPFLOOR_GITHUB_TOKEN}"
    - run: pnpm install --frozen-lockfile
      shell: bash
    - name: Write .env file
      shell: bash
      run: |
        {
          printf '%s\n' "$DOT_ENV"
          printf 'CLERK_SECRET_KEY=%s\n' "$CLERK_SECRET_KEY"
          printf 'E2E_CLERK_USER_USERNAME=%s\n' "$E2E_CLERK_USER_USERNAME"
          printf 'E2E_CLERK_USER_PASSWORD=%s\n' "$E2E_CLERK_USER_PASSWORD"
          printf 'E2E_CLERK_EMPLOYEE_USERNAME=%s\n' "$E2E_CLERK_EMPLOYEE_USERNAME"
          printf 'E2E_CLERK_EMPLOYEE_PASSWORD=%s\n' "$E2E_CLERK_EMPLOYEE_PASSWORD"
          printf 'E2E_CLERK_VIEWER_USERNAME=%s\n' "$E2E_CLERK_VIEWER_USERNAME"
          printf 'E2E_CLERK_VIEWER_PASSWORD=%s\n' "$E2E_CLERK_VIEWER_PASSWORD"
          printf 'CLERK_MACHINE_SECRET_KEY=%s\n' "$CLERK_MACHINE_SECRET_KEY"
        } > .env
    - run: npx playwright install --with-deps chromium
      shell: bash
    - name: Get bricks version
      id: bricks-version
      shell: bash
      run: |
        VERSION=$(jq -r '.dependencies["@konfirmity/bricks"]' package.json | sed 's/[\^~]//g')
        echo "@konfirmity/bricks version detected: $VERSION"
        echo "version=$VERSION" >> "$GITHUB_OUTPUT"
    - uses: actions/create-github-app-token@f8d387b68d61c58ab83c6c016672934102569859 # v3.0.0
      id: bot-app-token
      with:
        app-id: ${{ env.APP_ID }}
        private-key: ${{ env.PRIVATE_KEY }}
        owner: konfirmity
    - name: Checkout bricks
      uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      with:
        repository: konfirmity/bricks
        ref: ${{ steps.bricks-version.outputs.version }}
        path: .bricks
        token: ${{ steps.bot-app-token.outputs.token }}
        persist-credentials: false
    - name: Install bricks dependencies
      shell: bash
      run: |
        cd .bricks
        pnpm install --frozen-lockfile
    - name: Start storybook server
      shell: bash
      env:
        STORYBOOK_DISABLE_TELEMETRY: '1'
      run: |
        cd .bricks
        pnpm run storybook &
    - name: Checkout test plans
      uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      with:
        repository: Konfirmity/frontend-testcases
        ref: main
        path: .test-plans
        token: ${{ steps.bot-app-token.outputs.token }}
        persist-credentials: false
```

### `./.github/workflows/shopfloor.yml`

```yaml
jobs:
  shopfloor:
    if: >-
      !(github.event_name == 'pull_request' || github.event_name == 'pull_request_review')
      || contains(github.event.pull_request.body, 'Shopfloor-Stage:')
    uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@main
    permissions:
      contents: read
      issues: read
      pull-requests: read
    secrets:
      shopfloor_github_app_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_CLIENT_ID }}
      shopfloor_github_app_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY }}
      shopfloor_github_app_review_client_id: ${{ secrets.SHOPFLOOR_GITHUB_APP_REVIEW_CLIENT_ID }}
      shopfloor_github_app_review_private_key: ${{ secrets.SHOPFLOOR_GITHUB_APP_REVIEW_PRIVATE_KEY }}
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      setup_env_json: |
        {
          "APP_ID": "${{ vars.GH_APP_ID }}",
          "PRIVATE_KEY": ${{ toJSON(secrets.GH_APP_PRIVATE_KEY) }},
          "DOT_ENV": ${{ toJSON(vars.DOT_ENV) }},
          "CLERK_SECRET_KEY": "${{ secrets.CLERK_SECRET_KEY }}",
          "E2E_CLERK_USER_USERNAME": "${{ secrets.E2E_CLERK_USER_USERNAME }}",
          "E2E_CLERK_USER_PASSWORD": "${{ secrets.E2E_CLERK_USER_PASSWORD }}",
          "E2E_CLERK_EMPLOYEE_USERNAME": "${{ secrets.E2E_CLERK_EMPLOYEE_USERNAME }}",
          "E2E_CLERK_EMPLOYEE_PASSWORD": "${{ secrets.E2E_CLERK_EMPLOYEE_PASSWORD }}",
          "E2E_CLERK_VIEWER_USERNAME": "${{ secrets.E2E_CLERK_VIEWER_USERNAME }}",
          "E2E_CLERK_VIEWER_PASSWORD": "${{ secrets.E2E_CLERK_VIEWER_PASSWORD }}",
          "CLERK_MACHINE_SECRET_KEY": "${{ secrets.CLERK_MACHINE_SECRET_KEY }}"
        }
    with:
      runner_agent: 'the-outpost-small-plain'
      runner_impl: 'the-outpost-medium-6g-plain'
      runner_router: 'the-outpost-small-1g-plain'
      runner_review: 'the-outpost-small-1g-plain'
      trigger_label: 'shopfloor:trigger'
      setup_enabled: true
```

## Security considerations

### Log masking of forwarded values

GitHub Actions automatically masks the literal value of any registered
secret in workflow logs. When `setup_env_json` is forwarded as a single
secret, the masking system masks the whole JSON blob — but not its
individual values as substrings. A subsequent step that printed the
literal value of `CLERK_SECRET_KEY` would output the secret in clear.

The export step explicitly re-registers each value via `::add-mask::`
before any path that could log them, including before writing to
`$GITHUB_ENV` (where verbose-mode runners may echo names of variables
being set, but not values).

### Token scope of `SHOPFLOOR_GITHUB_TOKEN`

Shopfloor exports its pre-agent App installation token as
`SHOPFLOOR_GITHUB_TOKEN`. The token's scope is whatever the Shopfloor App
is installed with — typically `contents:read`, `issues:write`,
`pull-requests:write`, `metadata:read`. Consumer setup actions that need
package-registry read (`konfirmity-frontend`'s
`pnpm config set //npm.pkg.github.com/:_authToken=...`) require the App
installation to include `packages:read`. If the consumer's App is not
installed with that scope, they pass a separate token via `setup_env_json`
(e.g. `"NPM_AUTH_TOKEN"`) and reference it from the action.

### Secret bleed across stages

Each agent stage runs in its own runner. `$GITHUB_ENV` writes are scoped
to a single job. Setup env vars set in `triage` do not bleed into `spec`,
even on the same issue.

### Untrusted setup action contents

The setup action lives in the consumer's repo and is loaded by the
runner from the checked-out commit. A malicious PR that modifies
`./.github/actions/shopfloor-setup` cannot affect a Shopfloor run on
`main`-branch issues because Shopfloor runs `actions/checkout` on the
default branch. PR-event runs (`pull_request_review`) checkout the PR
head, so a malicious PR could in principle modify setup — but Shopfloor's
existing review chain runs on the PR's own branch context anyway, so
this is not a new attack surface introduced by setup.

## Testing

### Manual end-to-end on `konfirmity-frontend`

Migrate the consumer side as described above. File a `shopfloor:trigger`
issue. Verify:

1. The triage job logs show `Run consumer setup` succeeds before
   `Build triage context`.
2. `.env`, `node_modules/`, `.bricks/`, `.test-plans/` exist in the
   workspace by the time `claude-code-action` starts.
3. `pnpm exec tsc` and `pnpm test` work inside the agent's allowlisted
   bash if requested.
4. The implement job runs setup before `Create impl branch` and the
   untracked files survive the branch checkout.
5. Disabling `setup_enabled` returns the workflow to today's behavior
   exactly.

### Workflow lint

`actionlint` (or equivalent) on the modified `shopfloor.yml` to catch
expression-context errors, indentation drift, and undeclared step ids.

### No router/MCP changes required

Setup is pure workflow YAML. `router/` (TypeScript helpers) and
`mcp-servers/shopfloor-mcp` are untouched. No new vitest fixtures.

## Out of scope for this change

- `setup_review_enabled` plumbed through but no consumer needs it on day
  one. Ship the input; document; leave default off.
- A trampoline-based `setup_action_path` input. Additive; can ship later.
- Caching coordination across stages. Consumers handle via their own
  setup-node / setup-pnpm cache directives.
- A "post-setup" or "teardown" hook (for stopping the storybook server
  cleanly, etc.). Background processes die with the runner; consumers
  who care can add traps inside their setup action.

## Open questions

None remaining. Dependencies, ordering, secret handling, opt-in mechanics,
review-stage gating, and consumer migration path are all settled above.
