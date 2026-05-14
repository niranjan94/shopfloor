import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";

const SUBTYPE_TO_KIND: Record<
  string,
  | "agent_budget"
  | "agent_max_turns"
  | "agent_invalid_output"
  | "agent_execution"
> = {
  error_max_budget_usd: "agent_budget",
  error_max_turns: "agent_max_turns",
  error_max_structured_output_retries: "agent_invalid_output",
  error_during_execution: "agent_execution",
};

export class ClaudeAgentAdapter implements AgentAdapter {
  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    const controller = args.abortController ?? new AbortController();
    const timer =
      args.timeoutMs != null
        ? setTimeout(() => controller.abort(), args.timeoutMs)
        : null;

    try {
      const mcpServer = createSdkMcpServer({
        name: "shopfloor",
        version: "2.0.0",
        tools: args.tools as any,
      });

      const stream = query({
        prompt: args.userPrompt,
        options: {
          model: args.model,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: args.systemPrompt,
            excludeDynamicSections: true,
          },
          mcpServers: { shopfloor: mcpServer },
          allowedTools: args.tools.map((t) => `mcp__shopfloor__${t.name}`),
          outputFormat: {
            type: "json_schema",
            schema: zodToJsonSchema(args.decisionSchema as z.ZodTypeAny),
          },
          ...(args.budgetUsd !== undefined
            ? { maxBudgetUsd: args.budgetUsd }
            : {}),
          abortController: controller,
        },
      });

      for await (const msg of stream) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success") {
          return args.decisionSchema.parse(msg.structured_output);
        }
        const kind =
          SUBTYPE_TO_KIND[msg.subtype as string] ?? "agent_execution";
        throw new AgentError(
          kind,
          `claude session ended with ${msg.subtype}`,
          msg.subtype as string,
        );
      }
      throw new AgentError(
        "agent_execution",
        "claude session ended without a result message",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
