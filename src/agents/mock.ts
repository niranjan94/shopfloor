import type { AgentAdapter, AgentErrorKind, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";

export type CannedResponse =
  | { matchUserPromptIncludes: string; decision: unknown }
  | { matchUserPromptIncludes: string; error: { kind: AgentErrorKind; message: string } };

export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly responses: CannedResponse[]) {}

  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    for (const r of this.responses) {
      if (!args.userPrompt.includes(r.matchUserPromptIncludes)) continue;
      if ("error" in r) throw new AgentError(r.error.kind, r.error.message);
      return args.decisionSchema.parse(r.decision);
    }
    throw new Error(`MockAgentAdapter: no canned decision matched prompt: ${args.userPrompt.slice(0, 80)}`);
  }
}
