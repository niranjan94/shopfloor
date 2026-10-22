import type { Stage } from "../state/labels.js";

export type AuditEvent =
  | {
      type: "stage_resolved";
      stage: Stage | "none";
      reason: string;
      issueNumber?: number;
      // Event context captured at routing time. Lets a single log line answer
      // "which webhook delivery did the router see, and which labels did it
      // resolve against" without trawling the workflow event payload.
      eventName?: string;
      action?: string;
      labelName?: string;
      payloadLabels?: string[];
      liveLabels?: string[];
    }
  | { type: "precheck_failed"; stage: Stage; reason: string }
  | { type: "stage_started"; stage: Stage; model: string; runId: string }
  | { type: "agent_tool_call"; stage: Stage; tool: string; argsPreview: string }
  | {
      type: "stage_decided";
      stage: Stage;
      decision: unknown;
      tokensUsed: number;
      costUsd: number;
    }
  | {
      type: "label_applied";
      issueNumber: number;
      add: string[];
      remove: string[];
    }
  | {
      // Low-level mutation record emitted by the GitHub adapter for every
      // single addLabel / removeLabel API call. label_applied (above) carries
      // the orchestrator's INTENT for a transition; label_mutated is the
      // ground-truth API write. Both are emitted: the high-level event tells
      // you what the stage wanted; the low-level events tell you what
      // actually hit GitHub (including mutex acquire/release and any retries).
      type: "label_mutated";
      issueNumber: number;
      op: "add" | "remove";
      label: string;
    }
  | { type: "pr_opened"; stage: Stage; prNumber: number }
  | {
      type: "review_posted";
      prNumber: number;
      verdict: "approve" | "request_changes" | "errored";
      iteration: number;
    }
  | {
      type: "stage_failed";
      stage: Stage;
      error: { message: string; kind: string };
    }
  | { type: "budget_exceeded"; stage: Stage; spentUsd: number; capUsd: number }
  | { type: "labels_bootstrapped"; created: string[] };

export type AuditEmitter = (event: AuditEvent) => void;

export interface CreateAuditEmitterArgs {
  runId: string;
  sink?: (line: string) => void;
}

export function createAuditEmitter(args: CreateAuditEmitterArgs): AuditEmitter {
  const sink = args.sink ?? ((line) => process.stdout.write(`${line}\n`));
  return (event) => {
    const payload = {
      ts: new Date().toISOString(),
      runId: args.runId,
      ...event,
    };
    sink(JSON.stringify(payload));
  };
}

// Combine multiple emitters into one -- useful for fanning a single stream out
// to JSONL stdout and a step-summary markdown mirror.
export function combineEmitters(...emitters: AuditEmitter[]): AuditEmitter {
  return (event) => {
    for (const e of emitters) e(event);
  };
}
