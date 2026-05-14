import { describe, expect, it } from "vitest";
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
});
