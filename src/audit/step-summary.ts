import { appendFileSync } from "node:fs";
import type { AuditEvent, AuditEmitter } from "./events.js";

const MIRRORED = new Set<AuditEvent["type"]>([
  "stage_started",
  "stage_decided",
  "stage_failed",
  "label_applied",
  "pr_opened",
  "review_posted",
  "budget_exceeded",
]);

export interface CreateMirrorArgs {
  path?: string;
}

export function createStepSummaryMirror(
  args: CreateMirrorArgs = {},
): AuditEmitter {
  const path = args.path ?? process.env.GITHUB_STEP_SUMMARY;
  return (event) => {
    if (!path) return;
    if (!MIRRORED.has(event.type)) return;
    appendFileSync(path, renderRow(event) + "\n");
  };
}

function renderRow(e: AuditEvent): string {
  switch (e.type) {
    case "stage_started":
      return `- **${e.stage}** started with model \`${e.model}\``;
    case "stage_decided":
      return `- **${e.stage}** decided (tokens: ${e.tokensUsed}, cost: $${e.costUsd.toFixed(4)})`;
    case "stage_failed":
      return `- **${e.stage}** failed: \`${e.error.kind}\`: ${e.error.message}`;
    case "label_applied":
      return `- labels on #${e.issueNumber}: +[${e.add.join(", ")}] -[${e.remove.join(", ")}]`;
    case "pr_opened":
      return `- PR opened for **${e.stage}** stage: #${e.prNumber}`;
    case "review_posted":
      return `- review #${e.iteration} on PR #${e.prNumber}: **${e.verdict}**`;
    case "budget_exceeded":
      return `- budget exceeded in **${e.stage}**: $${e.spentUsd.toFixed(2)} / $${e.capUsd.toFixed(2)}`;
    default:
      return `- ${(e as { type: string }).type}`;
  }
}
