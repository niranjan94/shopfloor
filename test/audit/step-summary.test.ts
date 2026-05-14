import { describe, expect, it } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepSummaryMirror } from "../../src/audit/step-summary.js";
import { combineEmitters, createAuditEmitter, type AuditEvent } from "../../src/audit/events.js";

describe("step-summary mirror", () => {
  it("appends a markdown row for curated event types", () => {
    const dir = mkdtempSync(join(tmpdir(), "summary-"));
    const path = join(dir, "summary.md");
    writeFileSync(path, "");
    const mirror = createStepSummaryMirror({ path });
    mirror({ type: "stage_started", stage: "triage", model: "claude-haiku", runId: "r1" });
    mirror({ type: "label_applied", issueNumber: 42, add: ["shopfloor:triaging"], remove: [] });
    mirror({ type: "agent_tool_call", stage: "triage", tool: "update_progress", argsPreview: "..." });

    const out = readFileSync(path, "utf8");
    expect(out).toContain("triage");
    expect(out).toContain("shopfloor:triaging");
    expect(out).not.toContain("agent_tool_call");
  });

  it("is a no-op when no path is configured and GITHUB_STEP_SUMMARY is unset", () => {
    const prev = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      const mirror = createStepSummaryMirror();
      expect(() =>
        mirror({ type: "stage_started", stage: "spec", model: "x", runId: "r" }),
      ).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.GITHUB_STEP_SUMMARY = prev;
    }
  });
});

describe("combineEmitters", () => {
  it("fans events out to all emitters", () => {
    const a: string[] = [];
    const b: string[] = [];
    const ea = createAuditEmitter({ runId: "r", sink: (line) => a.push(line) });
    const eb = createAuditEmitter({ runId: "r", sink: (line) => b.push(line) });
    const fan = combineEmitters(ea, eb);
    fan({ type: "stage_started", stage: "spec", model: "m", runId: "r" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
