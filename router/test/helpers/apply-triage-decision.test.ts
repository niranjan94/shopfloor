import { describe, expect, test } from "vitest";
import { applyTriageDecision } from "../../src/helpers/apply-triage-decision";
import { makeMockAdapter } from "./_mock-adapter";

describe("applyTriageDecision", () => {
  test("needs_clarification: posts questions and applies awaiting-info", async () => {
    const bundle = makeMockAdapter();
    // triage assertion check: no unexpected labels present
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    // advance-state from-labels check: shopfloor:triaging present
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
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
    // triage assertion check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    // advance-state from-labels check (soft-fail: triaging present, awaiting-info absent is ok)
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
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
    // triage assertion check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    // advance-state from-labels check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
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
    // triage assertion check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    // advance-state from-labels check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
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

  test("first-time triage with no transient labels present: classified quick succeeds", async () => {
    // Regression: Task 6a made advance-state hard-fail when all from_labels
    // are missing. apply-triage-decision used to pass a fixed from_labels
    // list regardless of what was actually present, and the triage workflow
    // never sets shopfloor:triaging, so every first-time triage threw.
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "Narrow single-file fix.",
        clarifying_questions: [],
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:quick");
    expect(labelCalls.flat()).toContain("shopfloor:needs-impl");
    expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
  });

  test("first-time triage with no transient labels: needs_clarification succeeds", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [], state: "open" },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "needs_clarification",
        complexity: "large",
        rationale: "Scope ambiguous.",
        clarifying_questions: ["Which subsystem?"],
      },
    });
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:awaiting-info"] }),
    );
    expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
  });

  test("classified path persists the computed slug in the issue body", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: "Please rate-limit this.",
      },
    });
    // advance-state second getIssue for the from-labels present check
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: "Please rate-limit this.",
      },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "medium",
        rationale: "Small cross-file feature.",
        clarifying_questions: [],
      },
    });
    expect(bundle.mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining(
          "Shopfloor-Slug: add-rate-limiting-to-api",
        ),
      }),
    );
    // original body content is preserved, not clobbered
    const call = bundle.mocks.updateIssue.mock.calls.find(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect(call).toBeDefined();
    expect((call![0] as { body: string }).body).toContain(
      "Please rate-limit this.",
    );
  });

  test("classified path is idempotent: does not rewrite an already-correct block", async () => {
    const bundle = makeMockAdapter();
    const existingBody = [
      "Please rate-limit this.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: add-rate-limiting-to-api",
      "-->",
    ].join("\n");
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: existingBody,
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: existingBody,
      },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "medium",
        rationale: "Small cross-file feature.",
        clarifying_questions: [],
      },
    });
    // The triage helper must not call update with a body when nothing changed.
    const bodyWrites = bundle.mocks.updateIssue.mock.calls.filter(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect(bodyWrites).toHaveLength(0);
  });

  test("needs_clarification path does NOT persist a slug", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: "Please rate-limit this.",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add rate limiting to /api/users endpoint",
        body: "Please rate-limit this.",
      },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "needs_clarification",
        complexity: "medium",
        rationale: "Need more info.",
        clarifying_questions: ["Which route?"],
      },
    });
    const bodyWrites = bundle.mocks.updateIssue.mock.calls.filter(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect(bodyWrites).toHaveLength(0);
  });

  test("parses supplied_spec and supplied_plan as null without changing behavior", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: null,
        supplied_plan: null,
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:needs-spec");
  });

  test("supplied_spec=path: writes spec path metadata, advances to needs-plan", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "Body. Spec at docs/specs/oauth.md.",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "path", path: "docs/specs/oauth.md" },
        supplied_plan: null,
      },
    });

    const updateCall = bundle.mocks.updateIssue.mock.calls.find(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![0] as { body: string }).body).toContain(
      "Shopfloor-Spec-Path: docs/specs/oauth.md",
    );

    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:needs-plan");
    expect(labelCalls.flat()).not.toContain("shopfloor:needs-spec");
  });

  test("supplied_plan=path: writes plan path metadata, advances to needs-impl", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "Body.",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: null,
        supplied_plan: { source: "path", path: "docs/plans/oauth.md" },
      },
    });

    const updateCall = bundle.mocks.updateIssue.mock.calls.find(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect((updateCall![0] as { body: string }).body).toContain(
      "Shopfloor-Plan-Path: docs/plans/oauth.md",
    );

    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:needs-impl");
    expect(labelCalls.flat()).not.toContain("shopfloor:needs-plan");
  });

  test("both paths supplied: writes both metadata keys, advances to needs-impl", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "Body.",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "path", path: "docs/specs/oauth.md" },
        supplied_plan: { source: "path", path: "docs/plans/oauth.md" },
      },
    });

    const updateCall = bundle.mocks.updateIssue.mock.calls.find(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    const updatedBody = (updateCall![0] as { body: string }).body;
    expect(updatedBody).toContain("Shopfloor-Spec-Path: docs/specs/oauth.md");
    expect(updatedBody).toContain("Shopfloor-Plan-Path: docs/plans/oauth.md");

    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:needs-impl");
  });

  test("supplied_spec=body: opens seed spec PR, advances to spec-in-review", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "## Shopfloor Spec\nbody",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
    bundle.mocks.getContent.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 7, html_url: "https://x/pr/7" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "body", content: "# Spec\n\nbody" },
        supplied_plan: null,
      },
    });

    expect(bundle.mocks.createRef).toHaveBeenCalled();
    expect(bundle.mocks.createPr).toHaveBeenCalled();
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:spec-in-review");
  });

  test("supplied_plan=body: opens seed plan PR, advances to plan-in-review", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "## Shopfloor Plan\nplan body",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
    bundle.mocks.getContent.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 8, html_url: "https://x/pr/8" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: null,
        supplied_plan: { source: "body", content: "# Plan" },
      },
    });

    expect(bundle.mocks.createPr).toHaveBeenCalled();
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:plan-in-review");
  });

  test("supplied_spec=path + supplied_plan=body: writes spec metadata + seeds plan PR + advances to plan-in-review", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "Add OAuth",
        body: "Body.\n\n## Shopfloor Plan\nplan body",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
    bundle.mocks.getContent.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 9, html_url: "https://x/pr/9" },
    });

    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "path", path: "docs/specs/oauth.md" },
        supplied_plan: { source: "body", content: "# Plan" },
      },
    });

    const updateCall = bundle.mocks.updateIssue.mock.calls.find(
      (c) => (c[0] as { body?: string }).body !== undefined,
    );
    expect((updateCall![0] as { body: string }).body).toContain(
      "Shopfloor-Spec-Path: docs/specs/oauth.md",
    );
    expect(bundle.mocks.createPr).toHaveBeenCalled();
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:plan-in-review");
  });

  test("supplied artifact + quick complexity gets promoted to medium", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "x",
        body: "",
      },
    });
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
    });
    await applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "quick",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "path", path: "docs/specs/x.md" },
        supplied_plan: null,
      },
    });
    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).toContain("shopfloor:medium");
    expect(labelCalls.flat()).not.toContain("shopfloor:quick");
  });

  test("seedStagePr failure leaves no state-flip labels behind", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:triaging" }],
        state: "open",
        title: "x",
        body: "",
      },
    });
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("server error"), { status: 500 }),
    );

    await expect(
      applyTriageDecision(bundle.adapter, {
        issueNumber: 42,
        decision: {
          status: "classified",
          complexity: "large",
          rationale: "r",
          clarifying_questions: [],
          supplied_spec: { source: "body", content: "# Spec" },
          supplied_plan: null,
        },
      }),
    ).rejects.toThrow("server error");

    const labelCalls = bundle.mocks.addLabels.mock.calls.map(
      (c) => (c[0] as { labels: string[] }).labels,
    );
    expect(labelCalls.flat()).not.toContain("shopfloor:spec-in-review");
  });

  test("throws when a non-triaging state label is already present", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:needs-impl" }],
        state: "open",
      },
    });
    await expect(
      applyTriageDecision(bundle.adapter, {
        issueNumber: 42,
        decision: {
          status: "classified",
          complexity: "quick",
          rationale: "x",
          clarifying_questions: [],
        },
      }),
    ).rejects.toThrow(/shopfloor:needs-impl/);
    expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
  });
});
