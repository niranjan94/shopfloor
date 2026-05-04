# Triage-Stage Root Cause Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For bug-shaped issues, the triage agent attempts a static-analysis root cause hypothesis and surfaces it as a `### Suspected root cause` H3 subsection appended to its existing `rationale` string, propagating to downstream stages naturally via the issue comment.

**Architecture:** Prompt-only behavior change. Three edits to `prompts/triage.md`: add a new `<root_cause_analysis>` section, update one rule in `<output_format>`, add one new example. No router code changes. One regression test added in `router/test/helpers/apply-triage-decision.test.ts` to lock in that a rationale carrying the RCA subsection gets posted verbatim. The existing prompt-render snapshot in `router/test/__snapshots__/prompt-render.test.ts.snap` is regenerated.

**Tech Stack:** Markdown prompt template, vitest, pnpm.

**Reference spec:** `docs/superpowers/specs/2026-05-04-triage-rca-design.md`

---

## File Structure

| File                                                   | Change | Responsibility                                                                  |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------- |
| `prompts/triage.md`                                    | Modify | Add `<root_cause_analysis>` section, update `<output_format>` rule, add example |
| `router/test/helpers/apply-triage-decision.test.ts`    | Modify | New test: rationale carrying RCA subsection survives into the posted comment    |
| `router/test/__snapshots__/prompt-render.test.ts.snap` | Modify | Regenerate to reflect the new prompt content                                    |

No new files. No router/`src/` source changes. The `TriageOutput` interface in `router/src/helpers/apply-triage-decision.ts` stays as-is; RCA rides inside the existing `rationale` string.

---

## Pre-flight

- [ ] **Step 0a: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean` (or only the spec/plan docs from this brainstorming session showing as untracked).

- [ ] **Step 0b: Verify spec is committed or staged**

```bash
ls docs/superpowers/specs/2026-05-04-triage-rca-design.md
```

Expected: file exists.

- [ ] **Step 0c: Confirm baseline tests pass**

```bash
pnpm test
```

Expected: all router and mcp-server tests pass. Note the run time so you can spot regressions.

- [ ] **Step 0d: Confirm baseline typecheck passes**

```bash
pnpm -r typecheck
```

Expected: no errors.

---

### Task 1: Add the RCA pass-through regression test

This test goes first so the contract is documented before the prompt rules. The test will pass on first run because `apply-triage-decision.ts` already concatenates `rationale` into the comment body verbatim (lines 199-204). The test's job is to lock in that pass-through so a future helper rewrite cannot silently strip the subsection.

**Files:**

- Modify: `router/test/helpers/apply-triage-decision.test.ts`

- [ ] **Step 1.1: Read the existing test file's structure**

```bash
sed -n '1,90p' router/test/helpers/apply-triage-decision.test.ts
```

Expected: see imports and the first `describe(...)` block. Note the `makeMockAdapter()` helper and the pattern of mocking `getIssue` once (for the unexpected-label assertion check) and a second time (for the advance-state from-labels check).

- [ ] **Step 1.2: Append the new test inside the existing `describe("applyTriageDecision", () => { ... })` block**

Find the closing `});` of the `describe` block (last line of the file). Just before it, paste this test:

```ts
test("classified path with RCA subsection: posts the full subsection verbatim in the triage comment", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  const rationaleWithRca = [
    "Narrow router bug. The dedupe key collides across issues.",
    "",
    "### Suspected root cause",
    "**Confidence:** medium",
    "**Hypothesis:** `routeEvent` builds the dedupe key from the label name only.",
    "**Evidence:**",
    "- `router/src/state.ts:142` - dedupe key omits issue number",
    "- `router/src/state.ts:189` - dedupe set is per-process, not per-issue",
    "**Suspected fix area:** `router/src/state.ts` - `routeEvent` dedupe key construction.",
  ].join("\n");
  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    baseBranch: "main",
    decision: {
      status: "classified",
      complexity: "quick",
      rationale: rationaleWithRca,
      clarifying_questions: [],
    },
  });
  expect(bundle.mocks.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining("### Suspected root cause"),
    }),
  );
  expect(bundle.mocks.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining(
        "**Suspected fix area:** `router/src/state.ts` - `routeEvent` dedupe key construction.",
      ),
    }),
  );
  expect(bundle.mocks.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining("**Confidence:** medium"),
    }),
  );
});

test("classified path with low-confidence RCA placeholder: posts the placeholder line verbatim", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  const rationale = [
    "Bug-shaped but root cause unclear from static reading.",
    "",
    "### Suspected root cause",
    "Couldn't pin down a likely cause from static reading.",
  ].join("\n");
  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    baseBranch: "main",
    decision: {
      status: "classified",
      complexity: "quick",
      rationale,
      clarifying_questions: [],
    },
  });
  expect(bundle.mocks.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining(
        "Couldn't pin down a likely cause from static reading.",
      ),
    }),
  );
});
```

Note: the dashes inside the test strings are plain ASCII hyphen-minus, not em-dashes. CLAUDE.md forbids em-dashes in committed artifacts.

- [ ] **Step 1.3: Run only the new tests to confirm they pass**

```bash
pnpm exec vitest run router/test/helpers/apply-triage-decision.test.ts -t "RCA"
```

Expected: 2 passed. (The greppy `-t "RCA"` matches both new test names.)

- [ ] **Step 1.4: Run the full apply-triage-decision suite to confirm nothing regressed**

```bash
pnpm exec vitest run router/test/helpers/apply-triage-decision.test.ts
```

Expected: every test in that file passes.

- [ ] **Step 1.5: Commit**

```bash
git add router/test/helpers/apply-triage-decision.test.ts
git commit -m "test(router): lock in RCA subsection pass-through in triage comment"
```

---

### Task 2: Add the `<root_cause_analysis>` section to the triage prompt

**Files:**

- Modify: `prompts/triage.md`

- [ ] **Step 2.1: Read the prompt to find the insertion point**

```bash
sed -n '67,72p' prompts/triage.md
```

Expected: see the `<investigation>` block followed by a blank line and `<output_format>`. The new section goes between them.

- [ ] **Step 2.2: Insert the `<root_cause_analysis>` section**

After the `</investigation>` closing tag (currently around line 69) and before `<output_format>`, insert this block. Use the Edit tool with the existing `</investigation>\n\n<output_format>` pattern as the unique anchor:

```
</investigation>

<root_cause_analysis>
For bug-shaped issues only, attempt a static-analysis root cause hypothesis grounded in code you actually read during `<investigation>`. Surface it as a trailing `### Suspected root cause` subsection appended to your `rationale` string.

An issue is **bug-shaped** when its title or body describes any of:

- An observed defect, regression, crash, hang, or freeze.
- An error message, stack trace, or failing test output.
- Behavior that diverges from documented or expected behavior.
- A security or data-integrity defect (data loss, leak, race, deadlock).

It is **not bug-shaped** when the issue describes a new feature, a refactor without a defect, a dependency bump, a documentation or comment update, or a pure configuration change. For mixed issues that mention a defect alongside a primary feature ask, treat the primary framing as decisive and skip RCA when feature-first.

Skip the RCA subsection entirely (do not emit the heading at all) when ANY of the following apply:

- The issue is not bug-shaped per the above.
- `status` is `needs_clarification`.
- A supplied spec or supplied plan is detected per `<artifact_detection>`.

When you do emit RCA, pick a confidence level:

- **high**: clear chain from the reported symptom to specific code lines you read. The fix is essentially obvious from the evidence.
- **medium**: plausible code path identified; one or two judgment calls bridge symptom to code.
- **low**: you read the relevant area but cannot form a defensible hypothesis.

Format for `medium` and `high` confidence (cap the entire subsection at ~150 words including bullets):

```

### Suspected root cause

**Confidence:** medium
**Hypothesis:** <1-2 sentences>
**Evidence:**

- `path/to/file.ext:NN` - <what you observed at that location>
- `path/to/other.ext:NN` - <what you observed at that location>
  **Suspected fix area:** `path/to/file.ext` (function or region name).

```

Format for `low` confidence (single line, no bullets):

```

### Suspected root cause

Couldn't pin down a likely cause from static reading.

```

Hard rules:

- Every `**Evidence:**` bullet MUST cite a real `path:line` reference you observed via Read or Grep. Do NOT invent line numbers. If you cannot ground a bullet in a real reference, drop it (or downgrade to `low` confidence if no bullets remain).
- Use plain ASCII hyphen-minus characters in the format. Do not use em-dashes anywhere in the subsection.
- The H3 heading text is exactly `### Suspected root cause`. Do not localize, abbreviate, or change capitalization.
- The subsection appears at the very end of the `rationale` string, separated from the preceding sentences by exactly one blank line.
</root_cause_analysis>

<output_format>
```

The Edit tool call: `old_string` is `</investigation>\n\n<output_format>`, `new_string` is the full block above ending with `\n<output_format>`.

- [ ] **Step 2.3: Verify the file still parses as the surrounding XML-tag-style sections**

```bash
grep -c '^<root_cause_analysis>' prompts/triage.md && grep -c '^</root_cause_analysis>' prompts/triage.md
```

Expected: `1` printed twice (one open tag, one close tag).

- [ ] **Step 2.4: Verify the existing `<output_format>` block is still intact**

```bash
grep -n '^<output_format>' prompts/triage.md
```

Expected: exactly one line, immediately following the new `</root_cause_analysis>` closing tag.

---

### Task 3: Update the `<output_format>` rules block

**Files:**

- Modify: `prompts/triage.md`

- [ ] **Step 3.1: Read the existing rules block**

```bash
sed -n '93,100p' prompts/triage.md
```

(Line numbers may have shifted by the insertion in Task 2; adjust by viewing `<output_format>` and reading the `Rules:` block within it.)

Expected: see the bullet list starting `- \`status: "classified"\` requires...`and ending with`- Do not include any field not in the schema.`.

- [ ] **Step 3.2: Insert one new bullet into the rules list**

Add a new bullet immediately after the bullet that begins `- Every string in \`clarifying_questions\` must be...`. Use the Edit tool. The new bullet:

```
- If the issue is bug-shaped per `<root_cause_analysis>` and `status` is `classified` and no `supplied_spec` or `supplied_plan` is detected, the `rationale` string MUST end with a `### Suspected root cause` subsection per `<root_cause_analysis>`. Otherwise the `rationale` MUST NOT contain such a subsection.
```

Anchor: the existing line `- Every string in \`clarifying_questions\` must be a single, specific, answerable question. No multi-part questions.` is unique in the file. Insert the new bullet immediately after it.

- [ ] **Step 3.3: Verify the rule list is still well-formed**

```bash
sed -n '/^Rules:$/,/^<\/output_format>$/p' prompts/triage.md
```

Expected: see a contiguous bulleted list with the new RCA bullet between the `clarifying_questions` rule and the `supplied_spec` / `supplied_plan` rule. No stray indentation.

---

### Task 4: Add a bug-shaped RCA example to `<examples>`

**Files:**

- Modify: `prompts/triage.md`

- [ ] **Step 4.1: Read the existing examples block to find the closing tag**

```bash
grep -n '</examples>' prompts/triage.md
```

Expected: exactly one match.

- [ ] **Step 4.2: Insert a new `<example>` block immediately before `</examples>`**

Use the Edit tool with `</example>\n</examples>` (the trailing example's close + the outer close) as the anchor. Insert the new example between them:

```
<example>
<scenario>Issue: "Router drops the second of two label flips fired at the same time on different issues."</scenario>
<expected_output>
{
  "status": "classified",
  "complexity": "quick",
  "rationale": "Narrow router dedupe bug; one or two files in `router/src/state.ts` need attention.\n\n### Suspected root cause\n**Confidence:** medium\n**Hypothesis:** `routeEvent` builds the dedupe key from the label name without the issue number, so concurrent label flips on different issues collide and the second loses.\n**Evidence:**\n- `router/src/state.ts:142` - dedupe key composed from `event.label.name` only\n- `router/src/state.ts:189` - dedupe set is per-process, not partitioned per issue\n**Suspected fix area:** `router/src/state.ts` - `routeEvent` dedupe key construction.",
  "clarifying_questions": []
}
</expected_output>
</example>
```

Replace `</example>\n</examples>` with the trailing example, the new example, and the closing `</examples>` tag.

Concretely the edit is:

- `old_string` (must be unique in file; check with `grep -n '</example>' prompts/triage.md` first; if multiple, use the LAST one's surrounding context as a unique anchor by including the immediately preceding `<scenario>` line):

  ```
  </example>
  </examples>
  ```

- `new_string`:

  ```
  </example>

  <example>
  <scenario>Issue: "Router drops the second of two label flips fired at the same time on different issues."</scenario>
  <expected_output>
  {
    "status": "classified",
    "complexity": "quick",
    "rationale": "Narrow router dedupe bug; one or two files in `router/src/state.ts` need attention.\n\n### Suspected root cause\n**Confidence:** medium\n**Hypothesis:** `routeEvent` builds the dedupe key from the label name without the issue number, so concurrent label flips on different issues collide and the second loses.\n**Evidence:**\n- `router/src/state.ts:142` - dedupe key composed from `event.label.name` only\n- `router/src/state.ts:189` - dedupe set is per-process, not partitioned per issue\n**Suspected fix area:** `router/src/state.ts` - `routeEvent` dedupe key construction.",
    "clarifying_questions": []
  }
  </expected_output>
  </example>
  </examples>
  ```

If `</example>\n</examples>` is not unique (it should be, since `</examples>` appears once), expand the anchor to include the previous `<expected_output>...</expected_output>` block as needed.

- [ ] **Step 4.3: Sanity-check the example count went up by one**

```bash
grep -c '<example>' prompts/triage.md
```

Expected: previous count + 1. (The previous count from the file as shipped was 4; new total should be 5. Confirm by reading the file's `<examples>` block visually if uncertain.)

---

### Task 5: Regenerate the prompt-render snapshot

The triage prompt content changed; the existing snapshot in `router/test/__snapshots__/prompt-render.test.ts.snap` for the `triage prompt renders with fixture context` test is now stale.

**Files:**

- Modify: `router/test/__snapshots__/prompt-render.test.ts.snap`

- [ ] **Step 5.1: Run the prompt-render tests and confirm only the triage snapshot fails**

```bash
pnpm exec vitest run router/test/prompt-render.test.ts
```

Expected: `triage prompt renders with fixture context` fails with a snapshot mismatch. All other prompt snapshots pass (we did not touch spec/plan/implement/review prompts).

If any other snapshot fails, STOP. That means an upstream prompt was edited unintentionally. Roll back to the last committed state and figure out why.

- [ ] **Step 5.2: Update the snapshot**

```bash
pnpm exec vitest run router/test/prompt-render.test.ts -u
```

Expected: tests pass; `1 snapshot updated` reported.

- [ ] **Step 5.3: Visually diff the snapshot delta**

```bash
git --no-pager diff router/test/__snapshots__/prompt-render.test.ts.snap
```

Expected: the diff contains:

- A new `<root_cause_analysis>...</root_cause_analysis>` block.
- A new bullet in the `Rules:` list under `<output_format>` mentioning RCA.
- A new `<example>` block at the end of `<examples>`.

Nothing else (no churn in spec/plan/implement/review prompts in the same snapshot file).

If the diff is larger than expected, STOP and inspect. Stale unrelated edits cannot ship in this commit.

---

### Task 6: Full verification

- [ ] **Step 6.1: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6.2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 6.3: Format check**

```bash
pnpm format:check
```

Expected: no formatting violations. If violations exist, run `pnpm format` and re-run the check.

- [ ] **Step 6.4: Build the router**

```bash
pnpm --filter @shopfloor/router build
```

Expected: `dist/index.cjs` is rebuilt without errors. Note: the router source did not change in this plan, so `dist/index.cjs` should be byte-identical (or differ only in build-time metadata). If the bundle changed materially, STOP and investigate.

- [ ] **Step 6.5: Read the rendered prompt one more time as a sanity check**

```bash
pnpm exec vitest run router/test/prompt-render.test.ts -t "triage" --reporter verbose
```

Then open the snapshot file and read the triage block end-to-end:

```bash
sed -n '/^exports\[`triage prompt renders with fixture context/,/^`;$/p' router/test/__snapshots__/prompt-render.test.ts.snap | head -200
```

Confirm the new section reads naturally and the rules and example are integrated cleanly.

---

### Task 7: Commit

- [ ] **Step 7.1: Stage and commit the prompt + snapshot together**

```bash
git add prompts/triage.md router/test/__snapshots__/prompt-render.test.ts.snap
git commit -m "feat(prompts): add root cause analysis to triage for bug-shaped issues"
```

The dist/ bundle is intentionally NOT staged here; if `pnpm --filter @shopfloor/router build` produced a meaningful change to `router/dist/index.cjs`, that goes in a separate `chore(router): rebuild dist` commit (see CLAUDE.md note that dist is committed). If the diff is empty, do nothing.

- [ ] **Step 7.2: Confirm the commit log looks right**

```bash
git --no-pager log --oneline -5
```

Expected: at least the two new commits at the top:

- `feat(prompts): add root cause analysis to triage for bug-shaped issues`
- `test(router): lock in RCA subsection pass-through in triage comment`

(Spec and plan documents may also appear if you committed them earlier.)

---

## Out of plan scope

- Committing `docs/superpowers/specs/2026-05-04-triage-rca-design.md` and `docs/superpowers/plans/2026-05-04-triage-rca.md`. The user's policy is to commit those explicitly; do not bundle them into the implementation commits above.
- Changes to downstream prompts (`spec.md`, `plan.md`, `implement-quick.md`). The spec deliberately leaves them alone; the RCA arrives via `{{issue_comments}}` interpolation.
- Programmatic enforcement of the 150-word cap or the H3 heading format. Both live in the prompt only.
- A typed `root_cause_analysis` field on `TriageOutput`. Reserved for a future change if downstream stages ever need to branch on RCA.
- Telemetry on RCA accuracy (matching suspected-fix-area against actual implementer changes). Separate effort.

## Rollback

This plan is fully reversible by reverting the two commits. The RCA feature is gated entirely by prompt content; the helper code path is unchanged.

```bash
git revert <feat-commit-sha>
git revert <test-commit-sha>
```

The prompt reverts to its prior shape and triage emits no RCA subsections. No data migration, no follow-up.
