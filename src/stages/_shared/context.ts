import type { AgentAdapter } from "../../agents/adapter.js";
import type { GitHubAdapter } from "../../github/adapter.js";
import type { AuditEmitter } from "../../audit/events.js";
import type { Config } from "../../config/inputs.js";
import type { EventPayload, RouterDecision } from "../../state/types.js";

export interface StageContext {
  event: EventPayload;
  repo: { owner: string; name: string };
  decision: RouterDecision;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    labels: string[];
  };
  pr?: {
    number: number;
    title: string;
    body: string | null;
    headRef: string;
    headSha: string;
    baseRef: string;
  };
  github: GitHubAdapter;
  // Distinct App for posting reviews; null when no review App is configured.
  // Falling back to ctx.github causes GitHub to reject APPROVE/REQUEST_CHANGES
  // because the bot would be reviewing its own PR.
  reviewGithub: GitHubAdapter | null;
  agent: AgentAdapter;
  audit: AuditEmitter;
  config: Config;
  runId: string;
}
