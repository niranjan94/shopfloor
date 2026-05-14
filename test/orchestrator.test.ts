import { describe, expect, it, vi } from "vitest";
import { runOrchestrator } from "../src/orchestrator.js";
import { MockAgentAdapter } from "../src/agents/mock.js";
import { asAdapter, makeMockGithub } from "./github/_mock-github.js";
import type { MockGithub } from "./github/_mock-github.js";
import { baseConfig } from "./_harness/config.js";
import type { AuditEvent } from "../src/audit/events.js";

function makeAudit() {
  const events: AuditEvent[] = [];
  return {
    emit: (e: AuditEvent) => events.push(e),
    events,
  };
}

function makeIssuesOpenedEvent(opts: {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
}) {
  return {
    name: "issues",
    payload: {
      action: "opened",
      issue: {
        number: opts.number,
        title: opts.title,
        body: opts.body ?? null,
        labels: (opts.labels ?? []).map((name) => ({ name })),
        state: "open" as const,
      },
      repository: { owner: { login: "octo" }, name: "demo" },
    },
  };
}

describe("runOrchestrator", () => {
  it("emits stage_resolved=none and returns for unrelated events", async () => {
    const audit = makeAudit();
    const mg: MockGithub = makeMockGithub();
    await runOrchestrator({
      event: { name: "push", payload: {} as never },
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit: audit.emit,
      config: baseConfig,
      runId: "r1",
    });
    const resolved = audit.events.find((e) => e.type === "stage_resolved");
    expect(resolved).toBeDefined();
    if (resolved && resolved.type === "stage_resolved") {
      expect(resolved.stage).toBe("none");
    }
    expect(mg.addLabel).not.toHaveBeenCalled();
  });

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

  it("routes issues.opened to triage and runs the runner + apply", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: "search bar",
        decision: {
          status: "classified",
          complexity: "large",
          rationale:
            "Multiple files, multiple subsystems, and unclear performance characteristics make this a large feature.",
          clarifying_questions: [],
          supplied_spec: null,
          supplied_plan: null,
        },
      },
    ]);

    await runOrchestrator({
      event: makeIssuesOpenedEvent({
        number: 42,
        title: "Add a search bar",
        body: "Implement a search bar with filters and pagination.",
        labels: [],
      }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent,
      audit: audit.emit,
      config: baseConfig,
      runId: "r1",
    });

    const types = audit.events.map((e) => e.type);
    expect(types).toContain("stage_resolved");
    expect(types).toContain("stage_started");
    expect(types).toContain("stage_decided");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:large");
    expect(mg.addLabel).toHaveBeenCalledWith(42, "shopfloor:needs-spec");
  });

  it("on failure, applies failed:<stage> label, posts comment, audits stage_failed, and rethrows", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    const failing = new MockAgentAdapter([]);
    // MockAgentAdapter throws when no matching response is registered.

    await expect(
      runOrchestrator({
        event: makeIssuesOpenedEvent({
          number: 99,
          title: "noop",
          body: "noop",
          labels: [],
        }),
        repo: { owner: "octo", name: "demo" },
        github: asAdapter(mg),
        reviewGithub: null,
        agent: failing,
        audit: audit.emit,
        config: baseConfig,
        runId: "r2",
      }),
    ).rejects.toThrow();

    expect(mg.addLabel).toHaveBeenCalledWith(99, "shopfloor:failed:triage");
    expect(mg.postIssueComment).toHaveBeenCalledWith(
      99,
      expect.stringContaining("Shopfloor triage failure"),
    );
    const failedEvent = audit.events.find((e) => e.type === "stage_failed");
    expect(failedEvent).toBeDefined();
  });

  it("blocks triage when issue already carries an advanced state label", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
    await runOrchestrator({
      event: makeIssuesOpenedEvent({
        number: 7,
        title: "x",
        body: "y",
        labels: ["shopfloor:needs-impl"],
      }),
      repo: { owner: "octo", name: "demo" },
      github: asAdapter(mg),
      reviewGithub: null,
      agent: new MockAgentAdapter([]),
      audit: audit.emit,
      config: baseConfig,
      runId: "r3",
    });
    // resolveStage routes to implement via state-label advancement, but the
    // state machine only triggers needs-impl on a 'labeled' event, not an
    // opened event. So we expect stage_resolved=none with reason
    // "no_matching_label_rule" -- no further action.
    const types = audit.events.map((e) => e.type);
    expect(types).toEqual(["stage_resolved"]);
    expect(mg.addLabel).not.toHaveBeenCalled();
  });

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

  it("mode=execute uses live API labels (live shows clean state when payload looks blocked)", async () => {
    const audit = makeAudit();
    const mg = makeMockGithub();
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
    mg.getIssue.mockResolvedValueOnce({
      labels: [{ name: "shopfloor:quick" }],
      state: "open",
      title: "Feature",
      body: null,
    });
    const agent = new MockAgentAdapter([]);
    const runStageSpy = vi.spyOn(agent, "runStage");
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
});
