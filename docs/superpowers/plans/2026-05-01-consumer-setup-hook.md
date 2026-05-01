# Consumer Setup Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in pre-agent setup hook to Shopfloor's reusable workflow so consumers can install dependencies, write `.env` files, start services, and run other setup actions before each agent stage starts.

**Architecture:** Two new workflow inputs (`setup_enabled`, `setup_review_enabled`) and one new secret (`setup_env_json`). When `setup_enabled` is true, two contiguous YAML steps are inserted into each agent job (and optionally each review job): (1) an "Export Shopfloor setup env" step that writes four well-known `SHOPFLOOR_*` env vars and decodes `setup_env_json` into masked, multi-line-safe env vars, and (2) a `uses: ./.github/actions/shopfloor-setup` step that invokes the consumer's composite action at a fixed convention path. No router/TypeScript/MCP changes.

**Tech Stack:** GitHub Actions YAML, jq, bash. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-01-consumer-setup-hook-design.md`

---

## File Structure

| File                                                  | Change | Responsibility                                                       |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `.github/workflows/shopfloor.yml`                     | Modify | Add inputs/secret + insert two-step setup block into 8 jobs          |
| `docs/shopfloor/install.md` (if exists)               | Modify | Document the new opt-in hook for consumers                           |
| `CLAUDE.md` (project)                                 | Modify | Add a one-liner under "GitHub Actions gotchas" if any new gotcha is discovered during implementation |

No tests to add. The router (`router/`) and MCP server (`mcp-servers/`) do not touch this code path. Validation is done via YAML-parse checks and downstream end-to-end tests on a real consumer (`konfirmity-frontend`), which is out of scope of this plan and tracked separately.

---

## Pre-flight

- [ ] **Step 0a: Verify clean working tree**

```bash
git status
```
Expected: `nothing to commit, working tree clean` (or only the plan/spec docs added during planning).

- [ ] **Step 0b: Verify spec is committed**

```bash
git log --oneline -- docs/superpowers/specs/2026-05-01-consumer-setup-hook-design.md
```
Expected: at least one commit touching the spec.

- [ ] **Step 0c: Confirm baseline workflow parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`. This is the parse check we rerun after each YAML edit to catch indentation drift or mis-quoted expressions.

---

### Task 1: Add new workflow inputs and secret

**Files:**
- Modify: `.github/workflows/shopfloor.yml` (the `workflow_call.inputs` block ends around line 125; the `workflow_call.secrets` block ends around line 149)

- [ ] **Step 1.1: Add `setup_enabled` and `setup_review_enabled` inputs**

Open `.github/workflows/shopfloor.yml`. Find the line `runner_review:` near line 120, scroll past its `description:` block to find the next entry (`secrets:` around line 126). Just **before** the `secrets:` line, append:

```yaml
      setup_enabled:
        type: boolean
        default: false
        description: >-
          When true, Shopfloor invokes ./.github/actions/shopfloor-setup
          on every agent stage between precheck and the agent step. The
          action must exist at exactly that path. When false (default),
          no setup runs and setup_env_json is ignored.
      setup_review_enabled:
        type: boolean
        default: false
        description: >-
          When true AND setup_enabled is true, also runs the setup action
          on the four review stages (review-compliance, review-bugs,
          review-security, review-smells). Off by default since reviews
          are read-only PR commenters that rarely need a built workspace.
```

Indentation: same six-space indent as sibling input blocks (e.g. `runner_review:`).

- [ ] **Step 1.2: Add `setup_env_json` secret**

In the same file, find the `secrets:` block (the one inside `workflow_call`, around line 126). The last entry is `ssh_signing_key: { required: false }` near line 149. Just **after** that line, append:

```yaml
      setup_env_json:
        required: false
        description: >-
          JSON object whose keys/values are exported as env vars in every
          job that runs setup. Use toJSON() in the caller workflow for
          multi-line values (PEM keys, .env blobs). Each value is
          registered for log masking via ::add-mask::. Reserved keys
          (SHOPFLOOR_STAGE, SHOPFLOOR_ISSUE_NUMBER, SHOPFLOOR_BRANCH_NAME,
          SHOPFLOOR_GITHUB_TOKEN) are dropped with a workflow warning.
```

Indentation: same six-space indent as sibling secret blocks.

- [ ] **Step 1.3: Verify the workflow parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 1.4: Verify the new inputs/secret show up in the parsed structure**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
ins = wf[True]['workflow_call']['inputs']
secs = wf[True]['workflow_call']['secrets']
assert 'setup_enabled' in ins, 'setup_enabled missing'
assert 'setup_review_enabled' in ins, 'setup_review_enabled missing'
assert 'setup_env_json' in secs, 'setup_env_json missing'
assert ins['setup_enabled']['default'] is False
assert ins['setup_review_enabled']['default'] is False
print('ok')
"
```

(Note: PyYAML parses the `on:` key as the Python boolean `True`. That's why the access uses `wf[True]`. This is benign and only affects this verification script.)

Expected: `ok`.

- [ ] **Step 1.5: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): declare setup hook inputs and secret"
```

---

### Task 2: Define the reusable setup-export YAML block (reference for tasks 3-7)

This task does not modify any file. It locks down the exact text to be inserted in subsequent tasks so they all stay byte-identical except for the per-job substitutions called out in the spec.

The block consists of **two steps**. Substitute `<STAGE_NAME>` (literal, e.g. `triage`) and `<APP_TOKEN_STEP_ID>` (`app_token` for triage/spec/plan/review-*; `app_token_pre` for implement) per the table in the spec.

```yaml
      - name: Export Shopfloor setup env
        if: <SKIP_GATE>
        env:
          SETUP_ENV_JSON: ${{ secrets.setup_env_json }}
          SHOPFLOOR_STAGE: <STAGE_NAME>
          SHOPFLOOR_ISSUE_NUMBER: ${{ needs.route.outputs.issue_number }}
          SHOPFLOOR_BRANCH_NAME: ${{ needs.route.outputs.branch_name }}
          SHOPFLOOR_GITHUB_TOKEN: ${{ steps.<APP_TOKEN_STEP_ID>.outputs.token || secrets.GITHUB_TOKEN }}
        run: |
          {
            printf 'SHOPFLOOR_STAGE=%s\n' "$SHOPFLOOR_STAGE"
            printf 'SHOPFLOOR_ISSUE_NUMBER=%s\n' "$SHOPFLOOR_ISSUE_NUMBER"
            printf 'SHOPFLOOR_BRANCH_NAME=%s\n' "$SHOPFLOOR_BRANCH_NAME"
            printf 'SHOPFLOOR_GITHUB_TOKEN=%s\n' "$SHOPFLOOR_GITHUB_TOKEN"
          } >> "$GITHUB_ENV"
          if [ -n "$SETUP_ENV_JSON" ]; then
            RESERVED='["SHOPFLOOR_STAGE","SHOPFLOOR_ISSUE_NUMBER","SHOPFLOOR_BRANCH_NAME","SHOPFLOOR_GITHUB_TOKEN"]'
            printf '%s' "$SETUP_ENV_JSON" | jq -r --argjson r "$RESERVED" '
              keys_unsorted as $ks | $r[] | select(. as $k | $ks | index($k))
            ' | while IFS= read -r dropped; do
              [ -n "$dropped" ] && echo "::warning title=Shopfloor setup::Ignoring reserved key '$dropped' in setup_env_json"
            done
            SAFE_JSON=$(printf '%s' "$SETUP_ENV_JSON" | jq -c --argjson r "$RESERVED" 'with_entries(select(.key as $k | $r | index($k) | not))')
            while IFS= read -r v; do
              [ -n "$v" ] && echo "::add-mask::$v"
            done < <(printf '%s' "$SAFE_JSON" | jq -r '.[]')
            DELIM="SHOPFLOOR_ENV_$(openssl rand -hex 8)"
            printf '%s' "$SAFE_JSON" | jq -r --arg d "$DELIM" '
              to_entries[] | "\(.key)<<\($d)\n\(.value)\n\($d)"
            ' >> "$GITHUB_ENV"
          fi
      - name: Run consumer setup
        if: <SKIP_GATE>
        uses: ./.github/actions/shopfloor-setup
```

`<SKIP_GATE>` substitutions:

| Job                                | `<SKIP_GATE>` value                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `triage`, `spec`, `plan`           | `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`                  |
| `implement`                        | `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`                  |
| `review-{compliance,bugs,security,smells}` | `inputs.setup_enabled && inputs.setup_review_enabled`                    |

Indentation: six spaces of leading whitespace (matching sibling `- name:` step entries inside `jobs.<job>.steps`). The `run:` body is indented twelve spaces beyond the `run: |` line per YAML block-scalar conventions.

- [ ] **Step 2.1: No-op confirmation**

This task is documentation only. Confirm by re-reading this section. No commit.

---

### Task 3: Insert setup steps into the `triage` job

**Files:**
- Modify: `.github/workflows/shopfloor.yml`, between `Mark triage as running` and `Build triage context` inside `jobs.triage.steps`

- [ ] **Step 3.1: Locate the insertion point**

```bash
grep -n "^  triage:\|Mark triage as running\|Build triage context" .github/workflows/shopfloor.yml
```
Expected: three line numbers. The insertion goes immediately **after** the last step of `Mark triage as running` (i.e. before the `- name: Build triage context` line).

- [ ] **Step 3.2: Insert the two-step block**

Substitute into the Task 2 template:
- `<STAGE_NAME>` -> `triage`
- `<APP_TOKEN_STEP_ID>` -> `app_token`
- `<SKIP_GATE>` -> `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`

Insert the resulting two steps immediately before the `- name: Build triage context` step in `jobs.triage.steps`.

- [ ] **Step 3.3: Verify the workflow parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 3.4: Verify the steps landed in the right job and order**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
steps = [s.get('name', s.get('uses', '')) for s in wf['jobs']['triage']['steps']]
i_mark = next(i for i, n in enumerate(steps) if n == 'Mark triage as running')
i_export = next(i for i, n in enumerate(steps) if n == 'Export Shopfloor setup env')
i_setup = next(i for i, n in enumerate(steps) if n == 'Run consumer setup')
i_ctx = next(i for i, n in enumerate(steps) if n == 'Build triage context')
assert i_mark < i_export < i_setup < i_ctx, f'order wrong: {steps}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 3.5: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add setup hook to triage job"
```

---

### Task 4: Insert setup steps into the `spec` job

**Files:**
- Modify: `.github/workflows/shopfloor.yml`, immediately **before** `Build spec context`. Note that unlike the `implement` job, the `spec` job has intermediate steps (`Create spec branch` or `Checkout existing spec branch`) between `Mark spec as running` and `Build spec context`; setup lands **after** those branch steps and right before the context build. Spec/plan installs are typically lighter than implement's, so running them post-branch-checkout is fine and matches the spec's per-stage insertion table.

- [ ] **Step 4.1: Locate the insertion point**

```bash
grep -n "^  spec:\|Mark spec as running\|Build spec context\|Build spec revision context" .github/workflows/shopfloor.yml
```
Expected output identifies the `spec:` job line and the relevant adjacent steps. The insertion goes after `Mark spec as running` and before whichever context-build step appears first in the file.

- [ ] **Step 4.2: Insert the two-step block**

Same template as Task 3.2 with:
- `<STAGE_NAME>` -> `spec`
- `<APP_TOKEN_STEP_ID>` -> `app_token`
- `<SKIP_GATE>` -> `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`

- [ ] **Step 4.3: Verify the workflow parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 4.4: Verify ordering**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
steps = [s.get('name', s.get('uses', '')) for s in wf['jobs']['spec']['steps']]
i_export = next(i for i, n in enumerate(steps) if n == 'Export Shopfloor setup env')
i_setup = next(i for i, n in enumerate(steps) if n == 'Run consumer setup')
assert i_export + 1 == i_setup, f'export and setup must be adjacent; got {steps}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 4.5: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add setup hook to spec job"
```

---

### Task 5: Insert setup steps into the `plan` job

**Files:**
- Modify: `.github/workflows/shopfloor.yml`, immediately **before** `Build plan context`. Same caveat as Task 4: the `plan` job has `Create plan branch` / `Checkout existing plan branch` between `Mark plan as running` and `Build plan context`; setup lands after those and right before the context build.

- [ ] **Step 5.1: Locate the insertion point**

```bash
grep -n "^  plan:\|Mark plan as running\|Build plan context\|Build plan revision context" .github/workflows/shopfloor.yml
```

- [ ] **Step 5.2: Insert the two-step block**

Same template as Task 3.2 with:
- `<STAGE_NAME>` -> `plan`
- `<APP_TOKEN_STEP_ID>` -> `app_token`
- `<SKIP_GATE>` -> `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`

- [ ] **Step 5.3: Verify parse**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 5.4: Verify ordering**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
steps = [s.get('name', s.get('uses', '')) for s in wf['jobs']['plan']['steps']]
i_export = next(i for i, n in enumerate(steps) if n == 'Export Shopfloor setup env')
i_setup = next(i for i, n in enumerate(steps) if n == 'Run consumer setup')
assert i_export + 1 == i_setup, f'export and setup must be adjacent; got {steps}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 5.5: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add setup hook to plan job"
```

---

### Task 6: Insert setup steps into the `implement` job

**Files:**
- Modify: `.github/workflows/shopfloor.yml`, after `Mark implement as running` and before either `Create impl branch` (first runs) or `Checkout existing impl branch` (revision runs)

**This task is the only one that uses `app_token_pre` instead of `app_token`. Get this right — it's the bug the spec review caught.**

- [ ] **Step 6.1: Locate the insertion point and confirm step id**

```bash
grep -n "^  implement:\|Mark implement as running\|Create impl branch\|Checkout existing impl branch\|Mint pre-agent GitHub App token\|app_token_pre\|app_token_post" .github/workflows/shopfloor.yml
```
Confirm `id: app_token_pre` (under the `Mint pre-agent GitHub App token` step) exists in the `implement` job. The insertion goes after `Mark implement as running` and before `Create impl branch`. Both `Create impl branch` (first run) and `Checkout existing impl branch` (revision) come after our insertion — they are mutually exclusive via `if:`, so we sit before whichever runs.

- [ ] **Step 6.2: Insert the two-step block**

Same template as Task 3.2 with:
- `<STAGE_NAME>` -> `implement`
- `<APP_TOKEN_STEP_ID>` -> **`app_token_pre`** (NOT `app_token`)
- `<SKIP_GATE>` -> `inputs.setup_enabled && steps.precheck.outputs.skip != 'true'`

- [ ] **Step 6.3: Verify parse**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 6.4: Verify the implement job uses `app_token_pre` in the export step**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
impl_steps = wf['jobs']['implement']['steps']
export = next(s for s in impl_steps if s.get('name') == 'Export Shopfloor setup env')
token_expr = export['env']['SHOPFLOOR_GITHUB_TOKEN']
assert 'steps.app_token_pre.outputs.token' in token_expr, f'expected app_token_pre in implement job, got: {token_expr}'
assert 'steps.app_token.outputs.token' not in token_expr, f'must NOT reference app_token (which does not exist in implement); got: {token_expr}'
print('ok')
"
```
Expected: `ok`. **A failure here means the silent-fallback bug.**

- [ ] **Step 6.5: Verify implement ordering**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
steps = [s.get('name', s.get('uses', '')) for s in wf['jobs']['implement']['steps']]
i_mark = next(i for i, n in enumerate(steps) if n == 'Mark implement as running')
i_export = next(i for i, n in enumerate(steps) if n == 'Export Shopfloor setup env')
i_setup = next(i for i, n in enumerate(steps) if n == 'Run consumer setup')
i_create = next(i for i, n in enumerate(steps) if n == 'Create impl branch')
assert i_mark < i_export < i_setup < i_create, f'order wrong: {steps}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 6.6: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add setup hook to implement job"
```

---

### Task 7: Insert setup steps into the four review jobs

**Files:**
- Modify: `.github/workflows/shopfloor.yml`, four contiguous insertions (one per review job)

Review jobs (`review-compliance`, `review-bugs`, `review-security`, `review-smells`) all share the same shape: `actions/checkout` → `Mint GitHub App token` → `Build review context` → render-prompt → agent. There is no precheck step. The insertion goes between `Mint GitHub App token` and `Build review context`.

The gate is different from agent jobs: `inputs.setup_enabled && inputs.setup_review_enabled` (no `precheck.skip` clause).

- [ ] **Step 7.1: Locate insertion points**

```bash
grep -n "^  review-compliance:\|^  review-bugs:\|^  review-security:\|^  review-smells:\|Mint GitHub App token\|Build review context\|Build bugs review context\|Build security review context\|Build smells review context" .github/workflows/shopfloor.yml
```
Confirm each of the four review jobs has a `Mint GitHub App token` step (with `id: app_token`) and a context-build step that follows.

- [ ] **Step 7.2: Insert into `review-compliance`**

Use the Task 2 template with:
- `<STAGE_NAME>` -> `review-compliance`
- `<APP_TOKEN_STEP_ID>` -> `app_token`
- `<SKIP_GATE>` -> `inputs.setup_enabled && inputs.setup_review_enabled`

Insert immediately before the `- name: Build review context` step (or whatever the per-job equivalent is named) in `jobs.review-compliance.steps`.

- [ ] **Step 7.3: Insert into `review-bugs`**

Same template with `<STAGE_NAME>` -> `review-bugs`. Other substitutions identical.

- [ ] **Step 7.4: Insert into `review-security`**

Same template with `<STAGE_NAME>` -> `review-security`.

- [ ] **Step 7.5: Insert into `review-smells`**

Same template with `<STAGE_NAME>` -> `review-smells`.

- [ ] **Step 7.6: Verify parse**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 7.7: Verify all four review jobs have the setup steps and the right gate**

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
review_jobs = ['review-compliance', 'review-bugs', 'review-security', 'review-smells']
for j in review_jobs:
    steps = wf['jobs'][j]['steps']
    export = next((s for s in steps if s.get('name') == 'Export Shopfloor setup env'), None)
    setup = next((s for s in steps if s.get('name') == 'Run consumer setup'), None)
    assert export is not None, f'{j} missing export step'
    assert setup is not None, f'{j} missing setup step'
    assert export['env']['SHOPFLOOR_STAGE'] == j, f'{j} has wrong SHOPFLOOR_STAGE: {export[\"env\"][\"SHOPFLOOR_STAGE\"]}'
    gate = export['if']
    assert 'setup_enabled' in gate and 'setup_review_enabled' in gate, f'{j} gate missing review flag: {gate}'
    assert 'precheck' not in gate, f'{j} gate must not reference precheck: {gate}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 7.8: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add setup hook to review jobs"
```

---

### Task 8: End-to-end YAML and step inventory check

**Files:** read-only verification of `.github/workflows/shopfloor.yml`

- [ ] **Step 8.1: Confirm exactly 8 setup-step pairs were inserted**

```bash
grep -c "Export Shopfloor setup env" .github/workflows/shopfloor.yml
```
Expected: `8`.

```bash
grep -c "Run consumer setup" .github/workflows/shopfloor.yml
```
Expected: `8`.

- [ ] **Step 8.2: Confirm `app_token_pre` is referenced exactly once for the SHOPFLOOR_GITHUB_TOKEN export**

```bash
grep -c "steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN" .github/workflows/shopfloor.yml
```
Expected: at least `1` (this should be the implement job's export step). Also verify that this expression appears in the same job as `Mark implement as running`:

```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/shopfloor.yml'))
for job_name, job in wf['jobs'].items():
    for s in job.get('steps', []):
        if s.get('name') == 'Export Shopfloor setup env':
            tok = s['env']['SHOPFLOOR_GITHUB_TOKEN']
            expected_id = 'app_token_pre' if job_name == 'implement' else 'app_token'
            assert f'steps.{expected_id}.outputs.token' in tok, f'job {job_name}: token expr {tok} does not use {expected_id}'
print('ok')
"
```
Expected: `ok`.

- [ ] **Step 8.3: Run the full project type-check to confirm nothing else regressed**

```bash
pnpm exec tsc --noEmit
```
Expected: no errors. (This change does not touch TS code, so this is just a smoke check.)

- [ ] **Step 8.4: Run vitest to confirm router tests still pass**

```bash
pnpm test
```
Expected: all tests pass. (Same rationale — should be untouched, but cheap to verify.)

- [ ] **Step 8.5: Optional — install and run actionlint**

If `actionlint` is available (`brew install actionlint` on macOS), run:

```bash
actionlint .github/workflows/shopfloor.yml
```
Expected: no errors. If actionlint is unavailable, skip this step — the YAML parse + structural assertions above are sufficient.

- [ ] **Step 8.6: No commit needed for verification**

If any step above fails, fix the underlying issue and amend the affected feat commit (or add a fixup commit).

---

### Task 9: Update consumer-facing docs

**Files:**
- Modify: `docs/shopfloor/install.md` (if it exists in the repo)

- [ ] **Step 9.1: Check whether install docs exist**

```bash
ls docs/shopfloor/install.md docs/shopfloor/README.md 2>/dev/null
```

If neither file exists, **skip to step 9.4** — the spec is the source of truth, and there's no docs file to update.

- [ ] **Step 9.2: Read the existing docs to understand structure**

```bash
cat docs/shopfloor/install.md 2>/dev/null | head -40
```
Look for a section about "secrets" or "inputs" or "configuration" where the new hook fits.

- [ ] **Step 9.3: Add a short "Optional: pre-agent setup hook" section**

Add a section that says, in roughly 80-120 words:
- The hook is opt-in (`setup_enabled: true`)
- The consumer's setup action must live at `./.github/actions/shopfloor-setup`
- The action is composite, takes no inputs, reads from env vars
- Four `SHOPFLOOR_*` env vars are always exported (list them)
- Caller-supplied env vars come from the `setup_env_json` secret (JSON object, scalar string values, use `toJSON()` for multi-line values)
- Reserved keys (the four `SHOPFLOOR_*` names) are dropped with a warning
- Review-stage setup is gated separately by `setup_review_enabled` (default off)

Include the konfirmity-frontend example caller snippet from the spec (the `setup_env_json: |` JSON block).

- [ ] **Step 9.4: Commit (or skip if no docs file)**

```bash
git add docs/shopfloor/install.md
git commit -m "docs(install): document optional pre-agent setup hook"
```

If no docs file existed, no commit is needed.

---

### Task 10: Final review

- [ ] **Step 10.1: Confirm final commit graph is clean**

```bash
git log --oneline -10
```
Expected: ~4-5 commits, each with a Conventional Commits prefix (feat/docs).

- [ ] **Step 10.2: Confirm working tree is clean**

```bash
git status
```
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 10.3: Final parse check**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml')); print('ok')"
```
Expected: `ok`.

---

## Conventional Commits checklist

The plan produces these commits in order:

1. `feat(workflow): declare setup hook inputs and secret` (Task 1)
2. `feat(workflow): add setup hook to triage job` (Task 3)
3. `feat(workflow): add setup hook to spec job` (Task 4)
4. `feat(workflow): add setup hook to plan job` (Task 5)
5. `feat(workflow): add setup hook to implement job` (Task 6)
6. `feat(workflow): add setup hook to review jobs` (Task 7)
7. `docs(install): document optional pre-agent setup hook` (Task 9, optional)

## Out-of-scope follow-ups

These are intentionally **not** part of this plan; track them separately if needed:

- Migrating `konfirmity-frontend`'s `./.github/actions/setup` to read from env vars and either rename to `./.github/actions/shopfloor-setup` or wrap. Tracked in the consumer repo, not Shopfloor.
- Extracting the inline export+invoke YAML block into a reusable Shopfloor-internal composite action (`.github/actions/shopfloor-setup-bridge`) to remove duplication across the eight insertion sites. Real DRY win, but additive and out of scope here.
- Adding `actionlint` to CI as a permanent gate.
- Auto-detecting whether `./.github/actions/shopfloor-setup` exists in the consumer repo and skipping the hook with a friendly warning when `setup_enabled: true` but the action is missing.
