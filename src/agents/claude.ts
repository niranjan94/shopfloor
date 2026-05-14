import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as core from "@actions/core";
import type { AgentAdapter, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";
import { ensureClaudeCli } from "../setup/ensure-claude-cli.js";

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

export type ClaudeCliResolver = () => Promise<string>;

export class ClaudeAgentAdapter implements AgentAdapter {
  // The env (when set) is forwarded to the SDK's `query()` so it scopes the
  // Anthropic credential and any allowlisted host vars to SDK subprocesses
  // instead of relying on `process.env`. See src/config/agent-env.ts.
  //
  // resolveCli is invoked lazily on the first runStage call. It locates (or
  // installs) the native Claude CLI binary because the SDK ships the binary
  // as platform-specific optional npm packages — those won't be present in
  // the committed dist/ bundle on a GitHub runner whose arch differs from
  // the build host.
  constructor(
    private readonly env?: Record<string, string>,
    private readonly resolveCli: ClaudeCliResolver = ensureClaudeCli,
  ) {}

  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    const controller = args.abortController ?? new AbortController();
    const timer =
      args.timeoutMs != null
        ? setTimeout(() => controller.abort(), args.timeoutMs)
        : null;

    try {
      const pathToClaudeCodeExecutable = await this.resolveCli();

      const mcpServer = createSdkMcpServer({
        name: "shopfloor",
        version: "2.0.0",
        tools: args.tools as any,
      });

      logAgentInput(args);

      const stream = query({
        prompt: args.userPrompt,
        options: {
          model: args.model,
          pathToClaudeCodeExecutable,
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
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          ...(this.env ? { env: this.env } : {}),
          abortController: controller,
        },
      });

      for await (const msg of stream) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success") {
          if (msg.structured_output === undefined) {
            // The CLI reported a clean run but ignored --json-schema and
            // emitted plain text. The SDK's `error_max_structured_output_retries`
            // doesn't fire in this path; we surface our own diagnostic so the
            // failing run prints what the model actually said.
            throw new AgentError(
              "agent_invalid_output",
              formatMissingStructuredOutput(msg),
              "success_without_structured_output",
            );
          }
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

function logAgentInput<T>(args: RunStageArgs<T>): void {
  core.startGroup(`Claude agent input (${args.model})`);
  try {
    core.info(`model: ${args.model}`);
    if (args.effort !== undefined) core.info(`effort: ${args.effort}`);
    if (args.budgetUsd !== undefined)
      core.info(`budgetUsd: ${args.budgetUsd}`);
    if (args.timeoutMs !== undefined) core.info(`timeoutMs: ${args.timeoutMs}`);
    const toolList = args.tools.length
      ? args.tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")
      : "(none)";
    core.info(`tools:\n${toolList}`);
    core.info(`systemPrompt:\n${args.systemPrompt}`);
    core.info(`userPrompt:\n${args.userPrompt}`);
  } finally {
    core.endGroup();
  }
}

function formatMissingStructuredOutput(msg: {
  result?: unknown;
  num_turns?: unknown;
  total_cost_usd?: unknown;
  stop_reason?: unknown;
}): string {
  const RESULT_PREVIEW_CHARS = 600;
  const resultRaw = typeof msg.result === "string" ? msg.result : "";
  const preview =
    resultRaw.length > RESULT_PREVIEW_CHARS
      ? `${resultRaw.slice(0, RESULT_PREVIEW_CHARS)}... [truncated, ${resultRaw.length} chars]`
      : resultRaw;
  const numTurns = typeof msg.num_turns === "number" ? msg.num_turns : "?";
  const cost =
    typeof msg.total_cost_usd === "number"
      ? msg.total_cost_usd.toFixed(4)
      : "?";
  const stopReason =
    typeof msg.stop_reason === "string" ? msg.stop_reason : "?";
  return (
    `claude session ended with subtype=success but no structured_output. ` +
    `The CLI accepted --json-schema but the model returned plain text instead of structured data. ` +
    `num_turns=${numTurns} cost_usd=${cost} stop_reason=${stopReason}. ` +
    `result preview: ${preview || "(empty)"}`
  );
}
