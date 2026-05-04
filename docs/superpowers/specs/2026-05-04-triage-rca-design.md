# Triage-Stage Root Cause Analysis for Bug-Shaped Issues

## Problem

Triage today does one thing: classify an issue into `quick`, `medium`, or
`large` (or return `needs_clarification`) and surface a 1-3 sentence
`rationale`. For bug reports, the rationale typically reads as
"narrow CI fix with an obvious cause" - a complexity verdict, not a
defect diagnosis. Nothing in the pipeline does an explicit root cause
analysis:

- `prompts/triage.md` allows Read/Glob/Grep/WebFetch but only directs the
  agent to "ground your decision," not to identify the cause of a bug.
- `prompts/spec.md` runs only on `large` issues and frames its work as a
  design document, not a defect investigation.
- `prompts/plan.md` runs on `medium` and `large` and produces phases and
  tasks, not a hypothesis about why something is broken.
- `prompts/implement-quick.md` (the path most bugs take) jumps straight
  to "make the change" with no discrete diagnose step.

Result: for a `quick`-classified bug the human reviewer reading the
triage comment sees only the routing decision. They get no early signal
about whether triage even understood the defect. The implementer agent
also re-investigates from scratch on every run, even when triage already
read the relevant files to make its classification call.

This spec adds an opt-out-free root cause analysis subsection to the
triage comment for bug-shaped issues, costing zero schema changes, zero
helper code changes, and zero downstream prompt changes.

## Goals

- Triage attempts a root cause analysis for every bug-shaped issue and
  surfaces the result in its existing comment on the origin issue.
- Confidence-gated output: triage only emits a hypothesis when it has
  medium or high confidence grounded in code it actually read. Low
  confidence is reported as a single line so the reviewer knows triage
  tried and could not pin it down.
- Downstream agents (`spec`, `plan`, `implement-quick`) inherit the
  hypothesis automatically because every stage already interpolates
  `{{issue_comments}}` into its prompt context. No explicit plumbing.
- The change is contained to `prompts/triage.md`. No router code, no
  schema changes, no new test fixtures beyond a snapshot for the
  enriched rationale.

## Non-goals

- A structured `root_cause_analysis` field on the triage decision JSON.
  Considered and rejected: the only consumer is the triage comment, the
  router does not branch on RCA content, and adding a typed field would
  cascade through `router/src/types.ts`, `apply-triage-decision.ts`, and
  the e2e fixtures for one prose subsection.
- RCA on feature requests, refactors, dependency bumps, doc-only
  changes, or pure config edits. "Root cause" does not apply to absence
  of a feature.
- RCA on `needs_clarification` issues. Insufficient information to
  classify implies insufficient information to diagnose; layering
  guesses on guesses dilutes the signal.
- RCA on issues that already supply a spec or plan (inline or by path).
  The human author has already done the analysis; triage repeating the
  exercise wastes tokens and risks contradicting the supplied artifact.
- Telling downstream prompts to trust, distrust, or verify the
  hypothesis. The hypothesis arrives as part of `issue_comments` and the
  downstream agent uses it as it sees fit. A dedicated downstream
  contract is a separate change that can ship later if value emerges.
- Reproduction steps or runtime traces. Triage has no Bash and cannot
  execute the code. RCA is necessarily static-analysis-grade.
- Full code-path tracing or call-graph documentation. Triage stays
  cheap; the cap is ~150 words for the RCA subsection.

## What "bug-shaped" means

The triage prompt defines bug-shaped as an issue whose body or title
describes any of:

- An observed defect, regression, crash, hang, or freeze.
- An error message, stack trace, or failing test output.
- Behavior that diverges from documented or expected behavior.
- A security or data-integrity defect (data loss, leak, race, deadlock).

It is NOT bug-shaped when the issue describes:

- A new feature, capability, or user story ("we should add X", "users
  want Y").
- A refactor, code-quality improvement, or rename without a defect.
- A dependency bump, version pin, or registry change without a defect.
- A documentation, comment, or copy update.
- A pure configuration change (CI tweak, lint rule addition) without an
  observed defect being fixed.

Mixed issues (a feature request that mentions a related bug) get RCA
only if the primary ask is the bug. Triage uses judgment, errs on the
side of skipping RCA when the framing is feature-first.

## Output shape

Triage's existing JSON schema is unchanged:

```
{
  "status": "classified" | "needs_clarification",
  "complexity": "quick" | "medium" | "large",
  "rationale": "string",
  "clarifying_questions": [...],
  "supplied_spec": ... | null,
  "supplied_plan": ... | null
}
```

The `rationale` string remains 1-3 sentences for the routing verdict.
For a bug-shaped issue with no supplied artifact and `status: classified`,
the rationale is followed by an `### Suspected root cause` H3
subsection. The full rationale string fed into the comment looks like:

```
Narrow router bug. The dedupe key is built from the label name only,
so two different label flips on the same issue collide.

### Suspected root cause
**Confidence:** medium
**Hypothesis:** `routeEvent` constructs the dedupe key from
`event.label.name` without including the issue number, so concurrent
labels on different issues map to the same key and the second loses.
**Evidence:**
- `router/src/state.ts:142` - `const dedupeKey = ${'`'}label:${'${'}name}${'`'}`
- `router/src/state.ts:189` - dedupe set scoped per-process, no
  per-issue partition
**Suspected fix area:** `router/src/state.ts` - `routeEvent` dedupe key
construction.
```

For low-confidence cases the subsection is a single line:

```
### Suspected root cause
Couldn't pin down a likely cause from static reading.
```

The H3 (rather than H2) keeps the subsection visually subordinate to the
parent comment heading the router prepends
(`**Shopfloor triage: classified as ${'`'}quick${'`'}.**`).

### Confidence ladder

| Level    | Meaning                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `high`   | Clear chain from the reported symptom to specific code lines triage actually read. The fix is essentially obvious from the evidence. |
| `medium` | Plausible code path identified; one or two judgment calls bridge the gap between symptom and code.                                   |
| `low`    | Triage read the relevant area but cannot form a defensible hypothesis. Emit the single-line "couldn't pin down" form.                |

The ladder lives in the prompt; downstream consumers do not branch on
it programmatically.

### Word budget

The `### Suspected root cause` subsection is capped at ~150 words
including bullets. The cap is enforced by the prompt, not by code.
Triage's investigation step already says "do not exhaustively read the
codebase," so the RCA stays in the same cheap-and-focused spirit.

### Evidence grounding

Every bullet under `**Evidence:**` must be a real `path:line` reference
that triage observed via Read/Grep, written in the format
`` `path/to/file.ts:NN` `` followed by an em-dash-free explanatory
clause. Triage MUST NOT invent line numbers; the prompt explicitly
forbids that.

## Skip conditions

Triage skips the RCA subsection entirely (no `### Suspected root cause`
heading, no placeholder line) when any of:

- The issue is not bug-shaped per the rubric above.
- `status` is `needs_clarification`.
- A supplied spec or supplied plan is detected (via the existing
  `<artifact_detection>` rules).

A skipped RCA leaves the rationale string exactly as it is today.

## Architecture

### Prompt changes (`prompts/triage.md`)

Three edits, no others:

1. **New `<root_cause_analysis>` section after `<investigation>`.**
   Defines bug-shaped, lists skip conditions, specifies the H3 format,
   defines the confidence ladder, sets the 150-word cap, mandates real
   `file:line` evidence, and explicitly forbids invented references.

2. **Update the `<output_format>` rules block.** Add one bullet:
   "If the issue is bug-shaped and no supplied artifact is detected and
   `status` is `classified`, the `rationale` MUST end with a
   `### Suspected root cause` subsection per `<root_cause_analysis>`.
   Otherwise the `rationale` MUST NOT contain such a subsection."

3. **Add one example to `<examples>`.** A bug-shaped issue whose
   expected output's `rationale` contains the `### Suspected root cause`
   subsection with confidence `medium`. Demonstrates the format and
   reinforces the file:line discipline.

### No code changes

- `router/src/helpers/apply-triage-decision.ts` already posts the
  `rationale` verbatim inside the triage comment (see lines 199-204).
  The new subsection rides along automatically.
- The `TriageOutput` interface (defined in
  `router/src/helpers/apply-triage-decision.ts`, not in
  `router/src/types.ts`) stays as-is.
- `router/src/state.ts` does not branch on rationale content.
- No new GitHub Actions plumbing.

### No downstream prompt changes

`prompts/spec.md`, `prompts/plan.md`, and `prompts/implement-quick.md`
all interpolate `{{issue_comments}}`. The triage comment carrying the
RCA appears in that interpolation on every subsequent stage. None of
the downstream prompts are told to trust, distrust, or verify the
hypothesis; they receive it as one more piece of context and use it at
their discretion. This is deliberately the lowest-coupling shape; we
can revisit if downstream agents prove to ignore or misuse the
hypothesis in practice.

## Testing

### New snapshot test

Add a fixture and snapshot in `router/test/` exercising
`apply-triage-decision.ts` with a `TriageOutput` whose `rationale`
includes a representative `### Suspected root cause` subsection.
Confirm the posted comment body in the snapshot includes the
subsection verbatim, including the H3 heading, confidence line, and
file:line evidence bullets.

### Existing tests

The existing triage decision tests in `router/test/state.test.ts` and
the helper tests under `router/test/` continue to pass unchanged. RCA
is invisible to the state machine; no test that reads `complexity`,
`status`, or routing labels needs an update.

### Prompt sanity check

Render the updated `prompts/triage.md` against a representative bug
fixture (e.g. a small contrived "router dedupe collides" scenario)
through `router/src/helpers/render-prompt.ts` and confirm:

- The rendered prompt contains the new `<root_cause_analysis>` section.
- The new example in `<examples>` interpolates correctly.
- No template variable is dangling.

This is exercised by the existing render-prompt tests once the new
example block is in place.

## Security considerations

- The RCA subsection is derived from issue body text and code that
  triage reads. No user secrets transit through this path that did not
  already transit through `rationale`. The existing
  `apply-triage-decision.ts` posts arbitrary `rationale` content today;
  appending another subsection does not change the trust boundary.
- Evidence bullets are file:line references, not file contents. Triage
  does not paste source snippets into the comment, so leaking a
  secret-bearing file's contents via RCA is structurally prevented by
  the format.
- The 150-word cap caps the impact of a misbehaving triage agent that
  tries to dump large excerpts. The cap lives in the prompt only;
  treat it as best-effort, not a hard guarantee.

## Out of scope for this change

- Programmatic enforcement of the 150-word cap or the H3 format. Both
  live in the prompt and are observed in tests, not validated by code.
- A typed `root_cause_analysis` field on `TriageOutput`. Reserved for a
  future change if downstream stages ever need to branch on RCA.
- Changes to the review-matrix prompts. Reviewers see the RCA via
  comments naturally; they do not need explicit instruction.
- Telemetry or analytics on RCA accuracy. Adding "did the implementer's
  fix match the suspected fix area" tracking is a separate, larger
  effort.
- Localization or translation of the H3 heading text. Single-language
  for now.

## Open questions

None remaining. Scope (bug-shaped only), output channel (rationale
string, no schema change), confidence handling, downstream coupling
(none), and skip conditions are all settled above.
