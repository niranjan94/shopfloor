# Distill superpowers skills into stage prompts — design

## Problem

The spec, plan, and implement stage system prompts instruct the agent to "Invoke the `superpowers:<skill-name>` skill" as their primary methodology. The Claude Agent SDK in shopfloor does not load the superpowers plugin; the SDK's `plugins` option is never set. The instructions reference capabilities the runtime does not provide. The agent currently free-rides on whatever its training remembers about skill names like `writing-plans`, `brainstorming`, and `subagent-driven-development`.

The instructions also assume a human partner is available to answer clarifying questions, approve design choices, and decide when work is finished. Shopfloor stage agents are autonomous, single-pass, and emit a single Zod-typed JSON decision via the SDK's `outputFormat: json_schema`. Skills written for interactive use do not transfer cleanly.

The four prompts that reference superpowers are:

- `src/stages/spec/prompt.system.md` (2 references)
- `src/stages/plan/prompt.system.md` (2 references)
- `src/stages/implement/prompt.system.md` (5 references)
- `src/stages/implement/prompt.system.quick.md` (2 references, currently untracked)

No other source files reference superpowers.

## Goal

Replace each prompt's references to externally-loaded skills with self-contained, distilled methodology and self-review rubrics drawn from the original skill content, adapted to shopfloor's autonomous structured-output model. After the change, no system prompt references a skill that the SDK cannot load.

The work also introduces a binding rule for the testing layers each stage must consider, so that decisions about what kinds of tests to write are made once (in the spec or, for medium-complexity work, in the plan) and propagated through implementation without being re-derived.

## Non-goals

- Loading the SDK `plugins` option, or any other code path for fetching plugins at runtime or build time.
- Adding a generic plugin loader or new action inputs.
- Modifying the triage, review, or any review-lens stage prompts. The current scope is limited to stages whose prompts reference superpowers.
- Changing any Zod decision schema, MCP tool, runner control flow, or test infrastructure beyond prompt-string assertion updates.
- Renaming the `docs/superpowers/` directory. It is the workspace for human-written design documents (this one included); it is not pipeline-facing.

## Source skills referenced

The distilled content is drawn from these published skills:

- `brainstorming/spec-document-reviewer-prompt.md` — reviewer rubric for the spec stage
- `writing-plans/SKILL.md` — plan composition rules
- `writing-plans/plan-document-reviewer-prompt.md` — reviewer rubric for the plan stage
- `executing-plans/SKILL.md` — execution discipline for the implement stage
- `finishing-a-development-branch/SKILL.md` — verify-tests-before-claiming-done rule (the rest is shopfloor's router responsibility, not the agent's)
- `test-driven-development/SKILL.md` — TDD iron rules
- `test-driven-development/testing-anti-patterns.md` — testing anti-pattern gate functions

## Architecture

Each affected prompt keeps its existing XML scaffold (`<role>`, `<allowed_tools>`, `<prohibited>`, `<progress_tracking>` where applicable, `<output>`) byte-for-byte. Only the `<primary_methodology>` block is rewritten. No runner, schema, or tool surface changes.

One new shared markdown file holds the TDD and testing anti-pattern content that both implement prompts use identically. Each implement runner imports it alongside its system prompt and concatenates the two before passing the result to `runStage`. The alternative — duplicating ~400 words verbatim across two prompts — creates drift risk for content that should remain synchronised.

### Files changing

| File | Change |
|------|--------|
| `src/stages/spec/prompt.system.md` | Rewrite `<primary_methodology>`. Require a `Testing strategy` section in `spec_markdown`. |
| `src/stages/plan/prompt.system.md` | Rewrite `<primary_methodology>`. Inherit `Testing strategy` from spec when present; investigate the project and write it directly when spec is absent (medium flow). |
| `src/stages/implement/prompt.system.md` | Rewrite `<primary_methodology>`. Append shared TDD partial in the runner. |
| `src/stages/implement/prompt.system.quick.md` | Rewrite `<primary_methodology>`. Drop the "Do NOT invoke `superpowers:X`" lines. Track the file in git. (Partial-append happens later, in the PR that wires the quick-path runner.) |
| `src/stages/_shared/prompts/tdd-and-anti-patterns.md` | New shared partial: TDD iron rules, testing anti-pattern gates, minimize-overengineering block, pre-output checklist. |
| `src/stages/implement/runner.ts` | Concatenate system prompt with shared partial before calling `runStage`. |
| `dist/index.cjs` | Rebuild via `pnpm build`. CI fails on push if `dist/` is out of sync. |

The quick-path runner branch (`prompt.system.quick.md` → `runStage`) is not yet wired up; integrating it is owned by whichever later PR introduces the quick path. For this design, the quick prompt is rewritten and tracked; the runner glue is out of scope.

### Stage-by-stage methodology contents

#### Spec (`src/stages/spec/prompt.system.md`)

New `<primary_methodology>` contains, in order — and as part of this rewrite, every reference to `superpowers:brainstorming` (currently lines 8 and 15 of the file) is deleted:

1. **Operating-model framing.** One paragraph stating that the spec agent runs autonomously, has no user to query, must resolve ambiguity by reading code or recording it under an `Open questions` heading, and emits the spec via structured output rather than writing to disk.
2. **Composition rules** (5–7 bullets distilled from the spec brainstorming workflow): investigate before deciding; commit to one approach with a brief `Trade-offs` note when alternatives are viable; YAGNI; decompose into well-bounded units each with a stated purpose, interface, and dependency set; include targeted fixes for nearby problems but no drive-by refactors; scope-check (propose decomposition into sub-specs if the work spans independent subsystems); record genuinely unresolved questions under `Open questions` and pick a defensible default for the rest.
3. **Testing-strategy requirement.** The spec MUST include a `Testing strategy` section listing the test layers in scope, derived from investigation of the project's existing test directories, package scripts, and contributor docs. Layers may not be introduced where the project does not already exercise them; layers may be skipped when the project's docs, the issue body, or the triage rationale explicitly say so.
4. **Self-review block** containing the source skill's reviewer rubric (Completeness / Consistency / Clarity / Scope / YAGNI) and calibration note, plus an instruction to score the draft against the rubric and revise inline before emitting the structured output.
5. **Attribution footer** crediting `obra/superpowers`.

The `Completeness` row of the rubric explicitly lists `Testing strategy` as a required section so a missing section trips the self-review.

#### Plan (`src/stages/plan/prompt.system.md`)

New `<primary_methodology>` contains, in order — and as part of this rewrite, every reference to `superpowers:writing-plans` (currently lines 8 and 14 of the file) is deleted:

1. **Operating-model framing.** Same shape as the spec stage, adapted to the plan's contract role: the plan is the contract for an autonomous implementer that cannot ask questions, so every step must contain literal content the implementer can act on.
2. **Composition rules** distilled from `writing-plans/SKILL.md`: bite-sized atomic tasks; no placeholders, "TBD", or "similar to Task N"; all code blocks complete (no `...` elisions); precise file paths, commands, and expected outputs; each task declares affected files (Create / Modify / Test); each feature task follows the TDD five-step shape (write failing test → verify failure → implement → verify pass → commit) at every layer named in the testing strategy; non-feature tasks (doc-only, formatting, dist rebuild, prompt-only changes) skip the test steps and state so on the task line; each task supplies a valid Conventional Commits message.
3. **Testing-strategy branch.**
   - If a spec exists, read its `Testing strategy` section and use it as the source of truth.
   - If no spec exists (medium-complexity flow), perform the same project investigation the spec stage would have done and write the resulting `Testing strategy` section at the top of `plan_markdown`. Derive task-level test steps from that section.
   - Never introduce a layer that neither the spec nor the project's existing test surface names.
4. **Self-review block** containing the plan reviewer rubric (Completeness / Spec Alignment / Task Decomposition / Buildability), calibration note, and red-flag re-scan (ambiguous language, deferred work, undefined types, type/method name drift across tasks). The `Completeness` row requires a `Testing strategy` section (inherited from spec or established by the plan itself).
5. **Attribution footer.**

#### Implement, regular (`src/stages/implement/prompt.system.md`)

New `<primary_methodology>` contains, in order — and as part of this rewrite, every reference to `superpowers:subagent-driven-development`, `superpowers:using-git-worktrees`, and `superpowers:finishing-a-development-branch` (currently lines 8, 12, 18, 20, and 24) is deleted:

1. **Operating-model framing.** Single pre-checked-out branch, router pushes for you, no worktrees, no clarifying questions.
2. **Plan-first reading discipline.** Read the plan end-to-end; record contradictions in the progress comment with `[!]` markers; pick the most defensible interpretation rather than inventing missing task content; trust the plan's testing-layer decisions verbatim.
3. **Per-task execution loop.** For each task, dispatch a fresh implementer subagent via the `Agent` tool with only that task's content; after it returns, dispatch a second subagent for a focused diff review (spec/plan compliance + code quality in a single call); the implementer agent fixes real issues, ignores style preferences; progress comment updated once per task completion.
4. **Stop-on-blocker rule.** If a task is impossible as specified, mark `[!]` in the progress comment, do not invent workarounds, and emit the structured output describing what completed and what was blocked. The router and human reviewer will re-triage.
5. **Pointer to the shared TDD partial** that the runner appends.

#### Implement, quick (`src/stages/implement/prompt.system.quick.md`)

Smaller delta. The current quick prompt is already correctly shaped; the only changes — and as part of this rewrite, every reference to `superpowers:subagent-driven-development` and `superpowers:writing-plans` (currently lines 17 and 39) is deleted:

1. Drop the "Do NOT invoke `superpowers:...`" sentences from the methodology and prohibited blocks.
2. Replace the current step 4 ("Run any relevant tests from the Bash allowlist") with a paragraph that investigates the project's existing test layers (same investigation as spec/plan), adds tests at every layer the project uses for the area being touched, never introduces a new layer, and notes "no testable surface" in the structured output if the touched area genuinely has no tests in the project.
3. Keep the one-Explore-call rule and the re-triage signal verbatim.
4. Pointer to the shared TDD partial.

#### Shared TDD partial (`src/stages/_shared/prompts/tdd-and-anti-patterns.md`)

New file. Imported by the regular and quick implement runners and concatenated onto the system prompt. Contents:

1. **TDD iron rules**: no production code without a failing test first; RED → verify-fails → GREEN → verify-passes → REFACTOR; watching the test fail is mandatory; test names describe behavior; one assertion per behavior; real code preferred over mocks; bug fix means write the reproducing test first. Exception clause: non-testable changes (doc-only, formatting, dist rebuild, prompt-only edits) skip the cycle and state so in the commit body or progress update.
2. **Testing anti-pattern gates**: don't assert on `*-mock` test IDs; don't add test-only methods to production classes; understand a method's side effects before mocking it; mirror the complete real shape in mock responses, never partial.
3. **Minimize-overengineering block** (verbatim from the prompt-engineering reference): scope, documentation, defensive coding, abstractions — four constraints.
4. **Pre-output checklist**: `git status` clean; every commit message is valid CC and matches its change; tests pass at every named layer; no test-only methods leaked to production; no mock-identity assertions; no em dashes; no co-authors.

## Data flow

The testing-strategy decision flows through the pipeline:

- **Large flow:** spec writes `Testing strategy` → plan inherits and produces per-task test steps → implement honours the plan's test steps verbatim.
- **Medium flow:** plan investigates and writes `Testing strategy` → produces per-task test steps → implement honours the plan's test steps verbatim.
- **Quick flow:** implement-quick investigates and adds tests at every layer the project already uses for the touched area.

No layer of the pipeline reinvents the testing decision. The same investigation logic appears in the spec prompt and the plan prompt (medium branch) and the quick prompt; these copies are intentionally duplicated rather than factored, because the surrounding context for each invocation differs.

## Open questions

None. All design decisions were resolved during brainstorming.

## Trade-offs

- **Prompt size grows.** Combined system-prompt token count rises by an estimated 1.5–2× per affected stage. Mitigated by the SDK's prompt caching (system prompts are cacheable across iterations) and by shopfloor's existing per-stage budget caps. Worth the cost: the rewrites replace hand-wavy skill-name references with binding rules the model can actually act on.
- **Distillation is editorial.** Each rewrite trims source skills written for interactive use into rules adapted for autonomous use. Future drift between the source skills and these prompts is expected and acceptable; the attribution footer points at the source for anyone tracking upstream evolution.
- **Identical content lives in one partial, not three.** Factoring the TDD content into a shared partial creates one runner-side concatenation step that didn't exist before. The benefit (no drift between the two implement prompts) outweighs the small mechanical cost.

## Testing strategy

This change modifies prompt text only; no production-code logic changes. The project's test layers are unit (Vitest, in `test/stages/*.test.ts` and friends) and end-to-end (Vitest, in `test/e2e/`).

- **Unit-test impact:** Any test in `test/stages/{spec,plan,implement,triage,review}.test.ts` that asserts on a substring of the system prompt may need updating. Substring assertions on now-removed phrases like `Invoke the \`superpowers:writing-plans\` skill` will break; substring assertions on `<role>`, `<output>`, `<allowed_tools>`, and tool names will continue to pass because those sections are untouched.
- **E2E-test impact:** `test/e2e/orchestrator.e2e.test.ts` mocks the agent and asserts on Octokit calls, not prompt content. No impact expected.
- **No new tests required.** Prompt content is not behavior under test; the structured-output schema continues to define the contract, and that is unchanged.

## Implementation tasks (Conventional Commits)

Each task is independently reviewable and can land as a separate commit or PR.

1. `chore(prompts): add shared TDD and testing-anti-patterns partial`
2. `refactor(prompts/spec): inline methodology and require Testing strategy section`
3. `refactor(prompts/plan): inline methodology, handle spec-absent (medium) branch`
4. `refactor(prompts/implement): inline per-task execution discipline, append TDD partial`
5. `refactor(prompts/implement-quick): inline test-layer discovery, drop superpowers references, track file in git`
6. `test(stages): update prompt-string assertions for rewritten methodology blocks`
7. `chore(dist): rebuild for prompt restructure`

Tasks 2–5 are independent. Task 1 blocks 4 and 5. Task 6 blocks 7 (the dist rebuild should reflect a green test suite).

## Risks

- **Self-review pass is a behavioral guarantee, not enforceable in code.** The structured-output schema cannot verify that the agent actually re-scored its draft against the rubric. The prompt instructs the model; the model decides. Cost of non-compliance is mitigated by the existing review-stage matrix that runs after implement.
- **Distillation may drop something binding.** Each rewrite is reviewed against the source skill before commit. The attribution footer makes the source easy to re-consult.
- **Quick-path runner is not yet wired.** The quick prompt's runner integration ships in a later PR. Until then, the rewritten `prompt.system.quick.md` is dormant content.
