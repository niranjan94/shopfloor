# Per-Stage Runner Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mode: auto | resolve | execute` and `stages:` inputs to the Shopfloor v2 action so consumers can split routing from execution into two GitHub Actions jobs and assign different `runs-on:` per stage.

**Architecture:** Extend `parseConfig` with two new inputs; change `runOrchestrator` to return `{ stage, executed }`; in `mode: resolve` exit after `resolveStage()`; in `mode: execute` apply the `stages:` filter and fetch live issue labels from the GitHub API before precheck. Wire outputs through `entry.ts` via `core.setOutput()`. Single-job consumers (`mode: auto`) see no behavior change.

**Tech Stack:** TypeScript, vitest, Zod, `@actions/core`, `@octokit/rest`, esbuild.

**Spec:** `docs/superpowers/specs/2026-05-14-per-stage-runners-design.md`

---

## File map

| File                                                                       | Action  | Responsibility                                                                          |
| -------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `src/config/inputs.ts`                                                     | Modify  | Parse `mode` and `stages`; expose on `Config`.                                          |
| `test/config/inputs.test.ts`                                               | Modify  | Cover defaults and validation for `mode`/`stages`.                                      |
| `test/_harness/config.ts`                                                  | Modify  | Add `mode: "auto"` and `stages: []` defaults to `baseConfig`.                           |
| `src/orchestrator.ts`                                                      | Modify  | Return `OrchestratorResult`; branch on `config.mode`; live-label precheck in execute.   |
| `test/orchestrator.test.ts`                                                | Modify  | Update existing tests to handle return; add cases for resolve/execute modes.            |
| `src/entry.ts`                                                             | Modify  | Add `mode`/`stages` to `INPUT_KEYS`; call `core.setOutput('stage' | 'executed', …)`.    |
| `test/entry.test.ts`                                                       | Modify  | Assert outputs are emitted.                                                             |
| `action.yml`                                                               | Modify  | Add `mode` and `stages` inputs; add `outputs:` section.                                 |
| `examples/shopfloor-split-runners.yml`                                     | Create  | Two-job sample workflow showing resolve + execute pattern with `concurrency:` block.    |
| `README.md`                                                                | Modify  | Document new inputs/outputs and link the split-runners example.                         |
| `CLAUDE.md`                                                                | Modify  | One-paragraph note under a new "Modes" subsection.                                      |
| `dist/index.cjs`                                                           | Rebuild | `pnpm build` output, committed.                                                         |

---

## Task 1: Config schema additions

**Files:**

- Modify: `src/config/inputs.ts`
- Modify: `test/config/inputs.test.ts`
- Modify: `test/_harness/config.ts`

The `stages` input is a comma-separated string at the action surface and parses to `Stage[]` (from `src/state/labels.ts`). The `mode` input is a string enum. Both have defaults that preserve current behavior.

- [ ] **Step 1: Write failing tests for `mode` and `stages` parsing.**

Append the following cases to `test/config/inputs.test.ts`:

```typescript
  it("defaults mode to auto and stages to empty list", () => {
    const cfg = parseConfig(baseInputs);
    expect(cfg.mode).toBe("auto");
    expect(cfg.stages).toEqual([]);
  });

  it("parses mode=resolve and mode=execute", () => {
    expect(parseConfig({ ...baseInputs, mode: "resolve" }).mode).toBe("resolve");
    expect(parseConfig({ ...baseInputs, mode: "execute" }).mode).toBe("execute");
  });

  it("rejects an unknown mode value", () => {
    expect(() => parseConfig({ ...baseInputs, mode: "wat" })).toThrow();
  });

  it("parses a comma-separated stages list, trimming whitespace", () => {
    const cfg = parseConfig({
      ...baseInputs,
      stages: "triage, implement ,review",
    });
    expect(cfg.stages).toEqual(["triage", "implement", "review"]);
  });

  it("rejects an unknown stage name in stages", () => {
    expect(() =>
      parseConfig({ ...baseInputs, stages: "triage,nonsense" }),
    ).toThrow();
  });
```

- [ ] **Step 2: Run the new tests to verify they fail.**

```bash
pnpm vitest run test/config/inputs.test.ts
```

Expected: 5 new tests fail with property `mode`/`stages` not present on the parsed config or with Zod parse errors not happening.

- [ ] **Step 3: Extend the Zod schema and exported `Config` in `src/config/inputs.ts`.**

Add inside `RawInputs.object({ ... })` (alongside other inputs):

```typescript
    mode: z.enum(["auto", "resolve", "execute"]).default("auto"),
    stages: z.string().default(""),
```

Add this helper near the top of the file, after the `num` helper:

```typescript
const STAGE_NAMES = ["triage", "spec", "plan", "implement", "review"] as const;
type StageName = (typeof STAGE_NAMES)[number];

function parseStagesList(raw: string): StageName[] {
  if (!raw.trim()) return [];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(STAGE_NAMES as readonly string[]).includes(p)) {
      throw new Error(
        `invalid stage name in stages: ${p} (valid: ${STAGE_NAMES.join(", ")})`,
      );
    }
  }
  return parts as StageName[];
}
```

Inside `parseConfig`, after `const parsed = RawInputs.parse(cleaned);`, add the parsed `mode` and `stages` to the returned object (just before the closing `} as const;`):

```typescript
    mode: parsed.mode,
    stages: parseStagesList(parsed.stages),
```

- [ ] **Step 4: Run the config tests to verify they pass.**

```bash
pnpm vitest run test/config/inputs.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Update the test harness `baseConfig` to include the new fields.**

In `test/_harness/config.ts`, add to the `baseConfig` object literal (before the closing `};`):

```typescript
  mode: "auto" as const,
  stages: [] as Array<"triage" | "spec" | "plan" | "implement" | "review">,
```

- [ ] **Step 6: Run the full test suite to confirm no regressions.**

```bash
pnpm test
```

Expected: all tests pass, including pre-existing orchestrator and entry tests.

- [ ] **Step 7: Commit.**

```bash
git add src/config/inputs.ts test/config/inputs.test.ts test/_harness/config.ts
git commit -m "feat(config): add mode and stages action inputs"
```

---

## Task 2: Orchestrator returns `OrchestratorResult`

**Files:**

- Modify: `src/orchestrator.ts`
- Modify: `test/orchestrator.test.ts`

Refactor only. No behavior change. The signature becomes `Promise<OrchestratorResult>`; existing tests are updated to await the result (and optionally assert on it).

- [ ] **Step 1: Write a failing test that asserts the return shape.**

Add this test inside the `describe("runOrchestrator", () => { ... })` block in `test/orchestrator.test.ts`:

```typescript
  it("returns { stage: 'none', executed: false } when the event does not route to a stage", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const result = await runOrchestrator({
      event: { name: "push", payload: {} as never },
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit: audit.emit,
      config: baseConfig,
      runId: "r1",
    });
    expect(result).toEqual({ stage: "none", executed: false });
  });
```

- [ ] **Step 2: Run the test and confirm it fails.**

```bash
pnpm vitest run test/orchestrator.test.ts
```

Expected: the new test fails because `runOrchestrator` returns `undefined`.

- [ ] **Step 3: Refactor `runOrchestrator` to return `OrchestratorResult`.**

In `src/orchestrator.ts`, add the type near the top (after `OrchestratorArgs`):

```typescript
export interface OrchestratorResult {
  stage: Stage | "none";
  executed: boolean;
}
```

Change the function signature:

```typescript
export async function runOrchestrator(
  args: OrchestratorArgs,
): Promise<OrchestratorResult> {
```

Add returns at every exit:

- After the `stage_resolved` audit emit for `decision.stage === "none"`, replace `if (decision.stage === "none") return;` with:

```typescript
  if (decision.stage === "none") {
    return { stage: "none", executed: false };
  }
```

- After `if (!precheck.ok) { ... }` add `return { stage, executed: false };`:

```typescript
  if (!precheck.ok) {
    args.audit({ type: "precheck_failed", stage, reason: precheck.reason });
    return { stage, executed: false };
  }
```

- At the bottom of the `try` block (after the `await RUNNERS[stage].execute(...)` line, still inside the `try`), the existing `finally` releases the mutex. Add the return as the last statement before the `catch`, but it has to be expressed after the full `try/catch/finally` resolves. Restructure the tail of the function as:

```typescript
  try {
    await RUNNERS[stage].execute(ctx, decision);
  } catch (err) {
    await reportFailure(ctx, stage, err);
    throw err;
  } finally {
    if (mutex && decision.issueNumber !== undefined) {
      await args.github.removeLabel(decision.issueNumber, mutex);
    }
  }
  return { stage, executed: true };
}
```

- [ ] **Step 4: Run the orchestrator tests to confirm they pass.**

```bash
pnpm vitest run test/orchestrator.test.ts
```

Expected: the new test passes; all existing tests still pass (TypeScript will not complain because `Promise<OrchestratorResult>` is a supertype of `Promise<void>` at call sites that ignore the value).

- [ ] **Step 5: Run typecheck and full test suite.**

```bash
pnpm exec tsc --noEmit
pnpm test
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "refactor(orchestrator): return OrchestratorResult"
```

---

## Task 3: Resolve mode

**Files:**

- Modify: `src/orchestrator.ts`
- Modify: `test/orchestrator.test.ts`

In `mode: resolve`, after `resolveStage()` runs and the `stage_resolved` audit fires, exit with `{ stage, executed: false }`. No precheck, no mutex, no agent, no apply.

- [ ] **Step 1: Write failing test for resolve mode.**

Add to `test/orchestrator.test.ts`:

```typescript
  it("mode=resolve emits stage_resolved and exits without mutex or agent calls", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const agent = new MockAgentAdapter([]);
    const runStageSpy = vi.spyOn(agent, "runStage");
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({ number: 7, title: "A new feature" }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: { ...baseConfig, mode: "resolve" },
      runId: "r2",
    });
    expect(result).toEqual({ stage: "triage", executed: false });
    expect(runStageSpy).not.toHaveBeenCalled();
    expect(mg.addLabel).not.toHaveBeenCalled();
    expect(mg.getIssue).not.toHaveBeenCalled();
    const types = audit.events.map((e) => e.type);
    expect(types).toEqual(["stage_resolved"]);
  });
```

Also add the `vi` import at the top:

```typescript
import { describe, expect, it, vi } from "vitest";
```

- [ ] **Step 2: Run the test and confirm it fails.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "mode=resolve"
```

Expected: fails because resolve mode currently runs the full pipeline (will try to call agent).

- [ ] **Step 3: Add resolve-mode short-circuit in `runOrchestrator`.**

In `src/orchestrator.ts`, immediately after the existing `args.audit({ type: "stage_resolved", ... });` block (before the `if (decision.stage === "none") ...` line), add:

```typescript
  if (args.config.mode === "resolve") {
    return { stage: decision.stage, executed: false };
  }
```

This sits between the audit emit and the `none` short-circuit. Order matters: resolve mode reports `stage: "triage"` (or whichever) without doing any work.

- [ ] **Step 4: Run the resolve-mode test.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "mode=resolve"
```

Expected: passes.

- [ ] **Step 5: Run full orchestrator tests.**

```bash
pnpm vitest run test/orchestrator.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): short-circuit in resolve mode"
```

---

## Task 4: Execute-mode stages filter

**Files:**

- Modify: `src/orchestrator.ts`
- Modify: `test/orchestrator.test.ts`

When `mode: execute`, the resolved stage is checked against `config.stages`. Empty list = no filter (all stages allowed). On filter miss, return `{ stage, executed: false }` with no mutations.

- [ ] **Step 1: Write failing tests.**

Add to `test/orchestrator.test.ts`:

```typescript
  it("mode=execute with stages filter miss exits without running the agent", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const agent = new MockAgentAdapter([]);
    const runStageSpy = vi.spyOn(agent, "runStage");
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({ number: 8, title: "Feature" }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: { ...baseConfig, mode: "execute", stages: ["implement"] },
      runId: "r3",
    });
    expect(result).toEqual({ stage: "triage", executed: false });
    expect(runStageSpy).not.toHaveBeenCalled();
    expect(mg.addLabel).not.toHaveBeenCalled();
  });

  it("mode=execute with empty stages list runs the resolved stage", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: "Feature title",
        decision: {
          status: "classified",
          complexity: "quick",
          rationale:
            "A small change touching one file with obvious behavior, easy to verify.",
          clarifying_questions: [],
          supplied_spec: null,
          supplied_plan: null,
        },
      },
    ]);
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({ number: 9, title: "Feature title" }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: { ...baseConfig, mode: "execute", stages: [] },
      runId: "r4",
    });
    expect(result.executed).toBe(true);
    expect(result.stage).toBe("triage");
  });
```

- [ ] **Step 2: Confirm the new tests fail.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "mode=execute"
```

Expected: the filter-miss test fails (currently the agent runs because no filter exists).

- [ ] **Step 3: Add the filter check in `runOrchestrator`.**

In `src/orchestrator.ts`, immediately after the resolve-mode short-circuit from Task 3, and before the `if (decision.stage === "none")` block, add:

```typescript
  if (
    args.config.mode === "execute" &&
    args.config.stages.length > 0 &&
    decision.stage !== "none" &&
    !args.config.stages.includes(decision.stage as Stage)
  ) {
    return { stage: decision.stage, executed: false };
  }
```

The `decision.stage !== "none"` guard ensures the `none` case falls through to the existing `none` return path; the filter only matters for real stages.

- [ ] **Step 4: Run the filter tests.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "mode=execute"
```

Expected: both new tests pass.

- [ ] **Step 5: Run full test suite.**

```bash
pnpm test
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): stages filter for execute mode"
```

---

## Task 5: Live-label fetch for precheck in execute mode

**Files:**

- Modify: `src/orchestrator.ts`
- Modify: `test/orchestrator.test.ts`

In `mode: execute`, when an issue number is known, fetch live labels via `args.github.getIssue(n)` and use those in `precheckStage()` instead of the event payload's labels. Required to close the label-flip race that widens in the two-job split (v1 commit `aaef95f`).

- [ ] **Step 1: Write failing tests.**

These tests exercise the triage stage because its precheck (`TRIAGE_BLOCKING_STATE_LABELS` in `src/orchestrator.ts`) is a straightforward "do these labels exist?" gate. We engineer scenarios where the event-payload label set and the live-API label set disagree.

Add to `test/orchestrator.test.ts`:

```typescript
  it("mode=execute uses live API labels (live shows clean state when payload looks blocked)", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    // Live API: no blocking label, triage may run.
    mg.getIssue.mockResolvedValueOnce({
      labels: [],
      state: "open",
      title: "Feature",
      body: null,
    });
    const agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: "Feature",
        decision: {
          status: "classified",
          complexity: "quick",
          rationale:
            "Small isolated change, no architectural impact, fast to verify.",
          clarifying_questions: [],
          supplied_spec: null,
          supplied_plan: null,
        },
      },
    ]);
    // Event payload: stale snapshot still shows shopfloor:quick (a triage
    // blocking label). Without the live fetch, precheck would fail here.
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({
        number: 11,
        title: "Feature",
        labels: ["shopfloor:quick"],
      }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: { ...baseConfig, mode: "execute", stages: ["triage"] },
      runId: "r5",
    });
    expect(mg.getIssue).toHaveBeenCalledWith(11);
    expect(result).toEqual({ stage: "triage", executed: true });
  });

  it("mode=execute uses live API labels (live shows blocked state when payload looks clean)", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    // Live API: shopfloor:quick present, triage already completed, must abort.
    mg.getIssue.mockResolvedValueOnce({
      labels: [{ name: "shopfloor:quick" }],
      state: "open",
      title: "Feature",
      body: null,
    });
    const agent = new MockAgentAdapter([]);
    const runStageSpy = vi.spyOn(agent, "runStage");
    // Event payload: empty label set; payload-based precheck would pass.
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({ number: 12, title: "Feature" }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: { ...baseConfig, mode: "execute", stages: ["triage"] },
      runId: "r6",
    });
    expect(mg.getIssue).toHaveBeenCalledWith(12);
    expect(runStageSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ stage: "triage", executed: false });
    const precheckFail = audit.events.find((e) => e.type === "precheck_failed");
    expect(precheckFail).toBeDefined();
  });

  it("mode=auto continues to use event payload labels for precheck (no extra getIssue call)", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: "Simple task",
        decision: {
          status: "classified",
          complexity: "quick",
          rationale:
            "Small isolated change, no architectural impact, fast to verify.",
          clarifying_questions: [],
          supplied_spec: null,
          supplied_plan: null,
        },
      },
    ]);
    const result = await runOrchestrator({
      event: makeIssuesOpenedEvent({ number: 13, title: "Simple task" }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: baseConfig,
      runId: "r7",
    });
    expect(mg.getIssue).not.toHaveBeenCalled();
    expect(result.executed).toBe(true);
  });
```

- [ ] **Step 2: Confirm the new tests fail.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "live API labels"
```

Expected: both live-label tests fail (current precheck uses payload labels regardless of mode).

- [ ] **Step 3: Replace the precheck label source in execute mode.**

In `src/orchestrator.ts`, find the existing precheck block:

```typescript
  const precheck = precheckStage(stage, new Set(issue?.labels ?? []));
```

Replace it with:

```typescript
  // In execute mode, the resolve→execute gap can be 30-60s, long enough for
  // labels to flip after the event fired. Fetch live labels from the API so
  // precheck sees current state. v1 commit aaef95f.
  let precheckLabels: Set<string>;
  if (args.config.mode === "execute" && decision.issueNumber !== undefined) {
    const live = await args.github.getIssue(decision.issueNumber);
    precheckLabels = new Set(live.labels.map((l) => l.name));
  } else {
    precheckLabels = new Set(issue?.labels ?? []);
  }
  const precheck = precheckStage(stage, precheckLabels);
```

- [ ] **Step 4: Run the live-label tests.**

```bash
pnpm vitest run test/orchestrator.test.ts -t "live API labels"
```

Expected: both pass; the `mode=auto` test confirms no regression for the payload-labels path.

- [ ] **Step 5: Run full test suite.**

```bash
pnpm test
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): fetch live labels for precheck in execute mode"
```

---

## Task 6: Wire `mode` and `stages` through `entry.ts` and emit outputs

**Files:**

- Modify: `src/entry.ts`
- Modify: `test/entry.test.ts`

`INPUT_KEYS` is the source-of-truth list for action inputs `entry.ts` reads. Add `mode` and `stages`. After `runOrchestrator()` returns, emit `core.setOutput('stage', ...)` and `core.setOutput('executed', ...)`.

The existing `test/entry.test.ts` mocks `@actions/core` at module level (lines 6-16). That mock currently lists `getInput`, `setFailed`, `info`, `warning`, `error` but not `setOutput`. We add `setOutput` to the mock and assert on it. The entry's no-route fixture (lines 40-84) already drives the orchestrator end-to-end and resolves to `stage: "none"`, which gives us a concrete return value to assert against without injecting any stub.

- [ ] **Step 1: Extend the `@actions/core` module mock to include `setOutput`.**

In `test/entry.test.ts`, modify the `vi.mock("@actions/core", ...)` block (lines 6-16) to add `setOutput: vi.fn()`:

```typescript
vi.mock("@actions/core", async (orig) => {
  const real = (await orig()) as typeof import("@actions/core");
  return {
    ...real,
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
});
```

Also extend the `beforeEach` reset block (around line 32) to reset `setOutput`:

```typescript
    vi.mocked(core.getInput).mockReset();
    vi.mocked(core.setOutput).mockReset();
    vi.mocked(core.setFailed).mockReset();
```

- [ ] **Step 2: Write a failing test for output emission.**

Add to the existing `describe("runEntry", () => { ... })` block in `test/entry.test.ts`:

```typescript
  it("emits stage and executed action outputs after the orchestrator returns", async () => {
    fs.writeFileSync(
      tmpEventPath,
      JSON.stringify({
        action: "edited", // an action that won't route to any stage
        issue: {
          number: 7,
          title: "x",
          body: "y",
          labels: [],
          state: "open",
        },
        repository: { owner: { login: "octo" }, name: "demo" },
      }),
    );

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        anthropic_api_key: "sk-test",
        github_app_client_id: "Iv23x",
        github_app_private_key:
          "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
        github_app_token: "ghs_preminted",
      };
      return inputs[name] ?? "";
    });

    await runEntry({
      octokitFactory: (_auth) =>
        ({
          rest: { issues: {}, pulls: {}, repos: {}, git: {} },
          graphql: () => Promise.resolve({}),
        }) as never,
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("stage", "none");
    expect(core.setOutput).toHaveBeenCalledWith("executed", "false");
  });
```

- [ ] **Step 3: Run the new test and confirm it fails.**

```bash
pnpm vitest run test/entry.test.ts -t "emits stage and executed"
```

Expected: fail. `setOutput` is never called because `entry.ts` doesn't emit outputs yet.

- [ ] **Step 4: Add `mode` and `stages` to `INPUT_KEYS` in `src/entry.ts`.**

In the `INPUT_KEYS` array (lines 27-59), add two entries before the closing `] as const`:

```typescript
  "mode",
  "stages",
```

- [ ] **Step 5: Capture the orchestrator's result and emit outputs.**

In `src/entry.ts`, change the `await runOrchestrator({ ... });` call (line 142) to capture the return value, then call `core.setOutput` for both outputs. Replace lines 142-152 with:

```typescript
    const result = await runOrchestrator({
      event,
      repo: { owner, name: repo },
      github,
      reviewGithub,
      agent,
      audit,
      config,
      runId,
      ...(reviewOnly ? { reviewOnly: true } : {}),
    });
    core.setOutput("stage", result.stage);
    core.setOutput("executed", result.executed ? "true" : "false");
```

- [ ] **Step 6: Run the entry tests.**

```bash
pnpm vitest run test/entry.test.ts
```

Expected: all pass.

- [ ] **Step 7: Run full suite and typecheck.**

```bash
pnpm exec tsc --noEmit
pnpm test
```

Expected: clean.

- [ ] **Step 8: Commit.**

```bash
git add src/entry.ts test/entry.test.ts
git commit -m "feat(entry): wire mode/stages inputs and emit action outputs"
```

---

## Task 7: Action manifest updates

**Files:**

- Modify: `action.yml`

Add the new inputs and an `outputs:` block. No test (YAML; covered by manual review and the build step).

- [ ] **Step 1: Add `mode` input.**

Find the existing `review_only:` input block in `action.yml`. Below it (or wherever fits the ordering), add:

```yaml
  mode:
    description: |
      Action invocation mode.

      - `auto` (default): resolve the stage and execute it in one process.
        Backwards-compatible with single-job consumer workflows.
      - `resolve`: run only the state-machine routing and emit the `stage`
        output. No mutex, no agent, no GitHub mutations. Intended for a cheap
        "router" job in a two-job split workflow.
      - `execute`: resolve the stage, apply the optional `stages` filter, and
        run the stage end-to-end if it passes. Intended for one or more
        per-stage execute jobs that gate on the router's `stage` output.

      See examples/shopfloor-split-runners.yml for the two-job pattern.
    required: false
    default: "auto"
  stages:
    description: |
      Comma-separated list of stage names this `execute` invocation will run.
      Empty (default) means all stages. When non-empty and the resolved stage
      is not in this list, the action exits 0 silently without acquiring the
      mutex or running the agent. Ignored when `mode` is not `execute`.

      Valid stage names: triage, spec, plan, implement, review.
    required: false
    default: ""
```

- [ ] **Step 2: Add the `outputs:` section.**

After the final `inputs:` entry and before `runs:`, add:

```yaml
outputs:
  stage:
    description: |
      The stage the action's state machine resolved for this event:
      one of `triage`, `spec`, `plan`, `implement`, `review`, or `none`.
      Always set, regardless of `mode`. Use this output from a `mode: resolve`
      router job to gate downstream `mode: execute` jobs via `if:` expressions.
  executed:
    description: |
      `"true"` if the action actually ran a stage's agent and applied its
      decision, `"false"` otherwise. False covers: `mode: resolve` invocations,
      `mode: execute` filter misses, `none` routes, precheck failures, and
      any other early-exit cases.
```

- [ ] **Step 3: Validate the YAML is well-formed.**

The repo uses prettier on YAML, which fails on malformed input. Use it as the validator:

```bash
pnpm prettier --check action.yml
```

Expected: passes. If it fails on whitespace, run `pnpm format` then re-check.

- [ ] **Step 4: Commit.**

```bash
git add action.yml
git commit -m "feat(action): declare mode/stages inputs and stage/executed outputs"
```

---

## Task 8: Sample split-runners workflow

**Files:**

- Create: `examples/shopfloor-split-runners.yml`

A documented two-job example. Consumers copy this in alongside or instead of the single-job `examples/shopfloor.yml`.

- [ ] **Step 1: Create the file with this exact content.**

```yaml
# Two-job Shopfloor workflow: a cheap "resolve" job decides the stage, then a
# stage-specific "execute" job runs on the runner of your choice. The resolve
# job is always quick (a few seconds) and uses ubuntu-latest. The execute jobs
# can use different runner sizes per stage -- typically a small runner for
# triage/spec/plan/review and a beefier one for implement.
#
# See docs/superpowers/specs/2026-05-14-per-stage-runners-design.md for the
# design rationale, and CLAUDE.md "Modes" for the mode/stages contract.

name: Shopfloor (split runners)

on:
  issues:
    types: [opened, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, ready_for_review, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: read
  pull-requests: read

# Serialize events that touch the same issue. Without this, a label flip from
# one stage's apply() can race the next stage's start. v1 caught this class of
# bug in commit aaef95f ("per-stage concurrency groups and precheck wiring").
concurrency:
  group: shopfloor-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  resolve:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      stage: ${{ steps.r.outputs.stage }}
    steps:
      - uses: niranjan94/shopfloor@v2
        id: r
        with:
          mode: resolve
          # Prefer client credentials over preminted tokens. The resolve→execute
          # gap can be 60+ seconds, which tightens the 60-minute installation
          # token TTL budget. Client credentials refresh transparently per request.
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}

  light:
    needs: resolve
    if: contains(fromJSON('["triage","spec","plan","review"]'), needs.resolve.outputs.stage)
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: niranjan94/shopfloor@v2
        with:
          mode: execute
          stages: triage,spec,plan,review
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
          github_app_review_client_id: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID }}
          github_app_review_private_key: ${{ secrets.SHOPFLOOR_REVIEW_APP_KEY }}

  implement:
    needs: resolve
    if: needs.resolve.outputs.stage == 'implement'
    runs-on: ubuntu-latest-8core   # whatever beefy runner label your account exposes
    timeout-minutes: 60
    steps:
      - uses: niranjan94/shopfloor@v2
        with:
          mode: execute
          stages: implement
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
```

- [ ] **Step 2: Validate the workflow YAML.**

```bash
pnpm prettier --check examples/shopfloor-split-runners.yml
```

Expected: passes. If it fails on whitespace, run `pnpm format` then re-check.

- [ ] **Step 3: Commit.**

```bash
git add examples/shopfloor-split-runners.yml
git commit -m "docs(examples): add split-runners workflow example"
```

---

## Task 9: README and CLAUDE.md notes

**Files:**

- Modify: `README.md`
- Modify: `CLAUDE.md`

Document the new inputs/outputs and link the example.

- [ ] **Step 1: Inspect the README to find where to insert.**

```bash
grep -n "^##\|^###" README.md
```

Find the section that describes inputs (likely "Inputs" or "Configuration") and the section that describes example workflows.

- [ ] **Step 2: Add a "Per-stage runners" subsection to README.md.**

Append the following under the existing inputs/configuration section, or as its own section near the bottom (placement should match the README's existing structure):

```markdown
### Per-stage runners (advanced)

By default Shopfloor runs as a single GitHub Actions job per event (`mode: auto`).
If you want different stages to run on different runners — typically a small
runner for triage/spec/plan/review and a beefier one for implement — split the
workflow into two jobs using the `mode: resolve` / `mode: execute` pattern.

See `examples/shopfloor-split-runners.yml` for a copy-pasteable workflow.

Inputs:

| Input    | Default | Notes                                                                                                                            |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `auto`  | `auto` (single-job, current behavior), `resolve` (route only, emit `stage` output), `execute` (run a stage if `stages` permits). |
| `stages` | `""`    | Comma-separated allowlist for `mode: execute`. Empty means all stages.                                                           |

Outputs (always set):

| Output     | Notes                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `stage`    | `triage`, `spec`, `plan`, `implement`, `review`, or `none`.                    |
| `executed` | `"true"` if a stage ran end-to-end, `"false"` for resolve / filter / precheck. |

Notes:
- Execute mode fetches live issue labels from the GitHub API before precheck,
  not the event payload's snapshot, to close the label-flip race window between
  the resolve and execute jobs.
- Use client-credential auth (`github_app_client_id` + `github_app_private_key`)
  in split mode — preminted installation tokens have a 60-minute TTL that the
  resolve→execute gap eats into.
- Always set a workflow-level `concurrency:` group keyed on issue number when
  splitting; see the example.
```

- [ ] **Step 3: Add a "Modes" subsection to CLAUDE.md.**

Insert after the existing "Stage Flow" subsection in `CLAUDE.md`:

```markdown
## Modes

`mode` action input gates what an invocation does:

- `auto` (default): single-process resolve + execute. No workflow changes needed.
- `resolve`: run only `resolveStage()`; emit `stage` output; no mutex / agent / mutations.
- `execute`: re-resolve, apply `stages` allowlist, fetch live labels via `github.getIssue()` for precheck, then run end-to-end.

Split-runner consumer workflows pair one `resolve` job with one or more `execute` jobs gated on the router's `stage` output. See `examples/shopfloor-split-runners.yml`.
```

- [ ] **Step 4: Run prettier so the new sections match repo style.**

```bash
pnpm format
```

- [ ] **Step 5: Commit.**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document mode/stages inputs and split-runners pattern"
```

---

## Task 10: Rebuild and commit `dist`

**Files:**

- Modify: `dist/index.cjs`

The committed bundle must reflect the new code so CI's "dist is current" check passes.

- [ ] **Step 1: Rebuild.**

```bash
pnpm build
```

Expected: produces `dist/index.cjs` with no errors.

- [ ] **Step 2: Verify rebuild is stable (idempotent).**

```bash
pnpm build
git diff --quiet dist/index.cjs && echo "stable" || echo "NOT stable — investigate"
```

Expected: `stable`. If not stable, find the source of nondeterminism in the bundle (likely a timestamp or path) before committing.

- [ ] **Step 3: Run the smoke test.**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm format:check
```

Expected: all green.

- [ ] **Step 4: Commit the bundle.**

```bash
git add dist/index.cjs
git commit -m "chore(dist): rebuild for mode/stages action inputs"
```

---

## Verification (after all tasks)

- [ ] **Full test suite passes:** `pnpm test`
- [ ] **Typecheck clean:** `pnpm exec tsc --noEmit`
- [ ] **Format clean:** `pnpm format:check`
- [ ] **Dist is current:** `pnpm build && git diff --quiet dist/index.cjs`
- [ ] **Spec coverage:** every section of the spec maps to a task:
  - §3.1 Inputs and outputs → Tasks 1, 6, 7
  - §3.2 Mode semantics → Tasks 3, 4
  - §3.3 Sample workflow → Task 8
  - §3.4 Live-label fetch → Task 5
  - §3.5 Audit events → Tasks 3, 4 (no schema change; existing events reused)
  - §3.6 review_only → covered by `mode: auto` unchanged plus execute path (already routes via `resolveReviewOnly` based on `reviewOnly` arg passed by entry; orchestrator branch is mode-agnostic and runs `resolveStage`/`resolveReviewOnly` selection before the mode-specific code paths)
  - §3.7 Token guidance → Task 8 (docs in sample workflow) + Task 9 (README)
  - §4 Implementation file map → matches plan file map
  - §5 Edge case table → entries covered by Tasks 4, 5, 8
  - §6 Testing → Tasks 1, 2, 3, 4, 5, 6
  - §7 Commit plan → matches plan task commit messages (close enough; granularity adjusted)
  - §8 Open question → deliberately not implemented this plan; noted as follow-up
