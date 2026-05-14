import { describe, expect, it } from "vitest";
import { createAuditEmitter, type AuditEvent } from "../../src/audit/events.js";

describe("AuditEmitter", () => {
  it("writes one JSONL line per event with ts and runId", () => {
    const sink: string[] = [];
    const emit = createAuditEmitter({ runId: "r1", sink: (line) => sink.push(line) });
    emit({ type: "stage_resolved", stage: "triage", reason: "issue.opened", issueNumber: 7 } as AuditEvent);
    expect(sink).toHaveLength(1);
    const parsed = JSON.parse(sink[0]!);
    expect(parsed).toMatchObject({ type: "stage_resolved", stage: "triage", runId: "r1", issueNumber: 7 });
    expect(typeof parsed.ts).toBe("string");
  });

  it("serializes nested decision payloads", () => {
    const sink: string[] = [];
    const emit = createAuditEmitter({ runId: "r2", sink: (line) => sink.push(line) });
    emit({ type: "stage_decided", stage: "triage", decision: { complexity: "large" }, tokensUsed: 100, costUsd: 0.01 } as AuditEvent);
    const parsed = JSON.parse(sink[0]!);
    expect(parsed.decision).toEqual({ complexity: "large" });
  });
});
