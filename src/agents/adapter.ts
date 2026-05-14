import type { z } from "zod";
import type { SdkTool } from "../tools/types.js";

export type AgentErrorKind =
  | "agent_timeout"
  | "agent_budget"
  | "agent_max_turns"
  | "agent_invalid_output"
  | "agent_execution";

export class AgentError extends Error {
  constructor(
    public readonly kind: AgentErrorKind,
    message: string,
    public readonly subtype?: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface RunStageArgs<T> {
  systemPrompt: string;
  userPrompt: string;
  tools: SdkTool[];
  // Loosened input type to `unknown` so schemas with `.default()` (whose input
  // is a partial of the output) still satisfy the constraint.
  decisionSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  model: string;
  budgetUsd?: number;
  timeoutMs?: number;
  abortController?: AbortController;
}

export interface AgentAdapter {
  runStage<T>(args: RunStageArgs<T>): Promise<T>;
}
