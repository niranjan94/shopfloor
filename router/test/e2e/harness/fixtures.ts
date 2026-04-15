import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface GitHubEvent {
  eventName: string;
  payload: unknown;
}

export interface LoadEventOverrides {
  issueNumber?: number;
  prNumber?: number;
  sha?: string;
}

// Use import.meta.url-based resolution to avoid the __dirname-undefined-in-ESM
// footgun called out in the plan. This works under both ESM and CJS vitest.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", "fixtures", "events");

function inferEventName(payload: any): string {
  if (payload.review !== undefined && payload.pull_request !== undefined) {
    return "pull_request_review";
  }
  if (payload.pull_request !== undefined) return "pull_request";
  if (payload.issue !== undefined) return "issues";
  throw new Error(
    `loadEvent: cannot infer event name from payload keys: ${Object.keys(payload).join(",")}`,
  );
}

function patchOverrides(payload: any, ov: LoadEventOverrides | undefined): any {
  if (!ov) return payload;
  const next = JSON.parse(JSON.stringify(payload));
  if (ov.issueNumber !== undefined) {
    if (next.issue) next.issue.number = ov.issueNumber;
    if (next.pull_request) next.pull_request.number = ov.issueNumber;
  }
  if (ov.prNumber !== undefined) {
    if (next.pull_request) next.pull_request.number = ov.prNumber;
  }
  if (ov.sha !== undefined) {
    if (next.pull_request) {
      next.pull_request.head = { ...(next.pull_request.head ?? {}), sha: ov.sha };
    }
  }
  return next;
}

export function loadEvent(
  fixtureName: string,
  overrides?: LoadEventOverrides,
): GitHubEvent {
  const raw = readFileSync(join(FIXTURE_ROOT, fixtureName), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const patched = patchOverrides(parsed, overrides);
  return { eventName: inferEventName(patched), payload: patched };
}
