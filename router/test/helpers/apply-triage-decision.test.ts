import { describe, expect, test } from "vitest";
import { applyTriageDecision } from "../../src/helpers/apply-triage-decision";
import { makeMockAdapter } from "./_mock-adapter";

describe("applyTriageDecision", () => {
  test("needs_clarification: posts questions and applies awaiting-info", async () => {
    const bundle = makeMockAdapter();
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "needs_clarification",
        complexity: "large",
        rationale: "Need more info before proceeding.",
        clarifying_questions: ["Which provider?", "Where does session live?"],
      },
    });
    expect(bundle.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Which provider?"),
      }),
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:awaiting-info"] }),
    );
  });

  test("classified large: applies complexity + needs-spec labels", async () => {
    const bundle = makeMockAdapter();
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "Large feature touching auth subsystem.",
        clarifying_questions: [],
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:large");
    expect(labelCalls.flat()).toContain("shopfloor:needs-spec");
  });

  test("classified quick: applies complexity + needs-impl labels", async () => {
    const bundle = makeMockAdapter();
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "Narrow config fix.",
        clarifying_questions: [],
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:quick");
    expect(labelCalls.flat()).toContain("shopfloor:needs-impl");
  });

  test("classified medium: applies complexity + needs-plan labels", async () => {
    const bundle = makeMockAdapter();
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "medium",
        rationale: "Small cross-file feature.",
        clarifying_questions: [],
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:medium");
    expect(labelCalls.flat()).toContain("shopfloor:needs-plan");
  });
});
