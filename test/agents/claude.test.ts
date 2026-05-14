import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { AgentError } from "../../src/agents/adapter.js";

vi.mock("../../src/setup/ensure-claude-cli.js", () => ({
  ensureClaudeCli: vi.fn(async () => "/fake/claude"),
  resetClaudeCliCache: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const calls: any[] = [];
  return {
    __calls: calls,
    query: vi.fn((opts: any) => {
      calls.push(opts);
      const stream = opts.__nextStream as Array<{
        type: string;
        [k: string]: unknown;
      }>;
      return (async function* () {
        for (const m of stream ?? []) yield m;
      })();
    }),
    createSdkMcpServer: vi.fn((opts: any) => ({ __server: opts })),
    tool: vi.fn(
      (
        name: string,
        description: string,
        inputSchema: unknown,
        handler: unknown,
      ) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
    ),
  };
});

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentAdapter } from "../../src/agents/claude.js";

describe("ClaudeAgentAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  const Decision = z.object({ verdict: z.string() });

  it("resolves with parsed structured_output on success", async () => {
    (sdk as any).query.mockImplementation((_opts: any) => {
      const stream = [
        { type: "system" },
        {
          type: "result",
          subtype: "success",
          structured_output: { verdict: "ok" },
        },
      ];
      return (async function* () {
        for (const m of stream) yield m;
      })();
    });
    const agent = new ClaudeAgentAdapter();
    const result = await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [],
      decisionSchema: Decision,
      model: "claude-haiku",
    });
    expect(result).toEqual({ verdict: "ok" });
  });

  it("maps error_max_budget_usd to AgentError(agent_budget)", async () => {
    (sdk as any).query.mockImplementation(() =>
      (async function* () {
        yield { type: "result", subtype: "error_max_budget_usd" };
      })(),
    );
    const agent = new ClaudeAgentAdapter();
    await expect(
      agent.runStage({
        systemPrompt: "S",
        userPrompt: "U",
        tools: [],
        decisionSchema: Decision,
        model: "claude-haiku",
        budgetUsd: 1,
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("maps error_max_turns to AgentError(agent_max_turns)", async () => {
    (sdk as any).query.mockImplementation(() =>
      (async function* () {
        yield { type: "result", subtype: "error_max_turns" };
      })(),
    );
    const agent = new ClaudeAgentAdapter();
    const err = await agent
      .runStage({
        systemPrompt: "S",
        userPrompt: "U",
        tools: [],
        decisionSchema: Decision,
        model: "claude-haiku",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("agent_max_turns");
  });

  it("maps error_max_structured_output_retries to AgentError(agent_invalid_output)", async () => {
    (sdk as any).query.mockImplementation(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_max_structured_output_retries",
        };
      })(),
    );
    const agent = new ClaudeAgentAdapter();
    const err = await agent
      .runStage({
        systemPrompt: "S",
        userPrompt: "U",
        tools: [],
        decisionSchema: Decision,
        model: "claude-haiku",
      })
      .catch((e) => e);
    expect(err.kind).toBe("agent_invalid_output");
  });

  it("throws agent_execution when no result message arrives", async () => {
    (sdk as any).query.mockImplementation(() =>
      (async function* () {
        yield { type: "system" };
      })(),
    );
    const agent = new ClaudeAgentAdapter();
    const err = await agent
      .runStage({
        systemPrompt: "S",
        userPrompt: "U",
        tools: [],
        decisionSchema: Decision,
        model: "claude-haiku",
      })
      .catch((e) => e);
    expect(err.kind).toBe("agent_execution");
  });

  it("passes systemPrompt, model, outputFormat, mcpServers, allowedTools, maxBudgetUsd, abortController to query()", async () => {
    const ctrl = new AbortController();
    (sdk as any).query.mockImplementation((opts: any) => {
      (sdk as any).__lastOpts = opts;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { verdict: "ok" },
        };
      })();
    });
    const Tool = {
      name: "demo",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const agent = new ClaudeAgentAdapter();
    await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [Tool as any],
      decisionSchema: Decision,
      model: "claude-haiku",
      budgetUsd: 1.5,
      abortController: ctrl,
    });
    const opts = (sdk as any).__lastOpts;
    expect(opts.prompt).toBe("U");
    expect(opts.options.model).toBe("claude-haiku");
    expect(opts.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "S",
      excludeDynamicSections: true,
    });
    expect(opts.options.maxBudgetUsd).toBe(1.5);
    expect(opts.options.abortController).toBe(ctrl);
    expect(opts.options.outputFormat?.type).toBe("json_schema");
    expect(opts.options.outputFormat?.schema).toBeDefined();
    expect(opts.options.mcpServers).toBeDefined();
    expect(opts.options.allowedTools).toContain("mcp__shopfloor__demo");
    expect(opts.options.pathToClaudeCodeExecutable).toBe("/fake/claude");
  });

  it("threads an injected CLI resolver through to query()", async () => {
    (sdk as any).query.mockImplementation((opts: any) => {
      (sdk as any).__lastOpts = opts;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { verdict: "ok" },
        };
      })();
    });
    const resolver = vi.fn(async () => "/custom/claude");
    const agent = new ClaudeAgentAdapter(undefined, resolver);
    await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [],
      decisionSchema: Decision,
      model: "claude-haiku",
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect((sdk as any).__lastOpts.options.pathToClaudeCodeExecutable).toBe(
      "/custom/claude",
    );
  });
});
