import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentError } from "../../src/agents/adapter.js";
import type { SdkTool } from "../../src/tools/types.js";

vi.mock("../../src/setup/ensure-codex-cli.js", () => ({
  ensureCodexCli: vi.fn(async () => "/fake/codex"),
  resetCodexCliCache: vi.fn(),
}));

// Fake Codex SDK: capture constructor + thread options, drive run() per-test.
const runImpl = { fn: vi.fn() };
vi.mock("@openai/codex-sdk", () => {
  class Codex {
    static lastConstructorOpts: unknown;
    static lastThreadOptions: unknown;
    constructor(opts: unknown) {
      Codex.lastConstructorOpts = opts;
    }
    startThread(opts: unknown) {
      Codex.lastThreadOptions = opts;
      return { run: (...a: unknown[]) => runImpl.fn(...a) };
    }
  }
  return { Codex };
});

// Fake MCP bridge so tool wiring can be asserted without a live server.
const bridgeClose = vi.fn(async () => {});
vi.mock("../../src/agents/mcp-http-bridge.js", () => ({
  startToolBridge: vi.fn(async () => ({
    url: "http://127.0.0.1:5555/mcp",
    token: "test-token",
    close: bridgeClose,
  })),
}));

import { Codex } from "@openai/codex-sdk";
import {
  CodexAgentAdapter,
  type CodexAdapterOptions,
} from "../../src/agents/codex.js";
import { startToolBridge } from "../../src/agents/mcp-http-bridge.js";

const Decision = z.object({ verdict: z.string() });

function baseOpts(
  overrides: Partial<CodexAdapterOptions> = {},
): CodexAdapterOptions {
  return {
    apiKey: "sk-test",
    env: { PATH: "/usr/bin" },
    config: {},
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    skipGitRepoCheck: true,
    ...overrides,
  };
}

describe("CodexAgentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runImpl.fn = vi.fn();
  });

  it("maps model/effort/outputSchema/sandbox and parses structured output", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: JSON.stringify({ verdict: "ok" }),
      items: [],
      usage: null,
    }));
    const agent = new CodexAgentAdapter(baseOpts());
    const result = await agent.runStage({
      systemPrompt: "SYS",
      userPrompt: "USER",
      tools: [],
      decisionSchema: Decision,
      model: "gpt-5-codex",
      effort: "high",
    });

    expect(result).toEqual({ verdict: "ok" });

    const ctor = (Codex as unknown as { lastConstructorOpts: any })
      .lastConstructorOpts;
    expect(ctor.apiKey).toBe("sk-test");
    expect(ctor.codexPathOverride).toBe("/fake/codex");

    const thread = (Codex as unknown as { lastThreadOptions: any })
      .lastThreadOptions;
    expect(thread.model).toBe("gpt-5-codex");
    expect(thread.modelReasoningEffort).toBe("high");
    expect(thread.sandboxMode).toBe("workspace-write");
    expect(thread.approvalPolicy).toBe("never");
    expect(thread.networkAccessEnabled).toBe(true);
    expect(thread.skipGitRepoCheck).toBe(true);

    const [input, turnOptions] = runImpl.fn.mock.calls[0] as [string, any];
    expect(input).toBe("SYS\n\nUSER");
    expect(turnOptions.outputSchema).toBeTypeOf("object");
    expect(turnOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("starts the MCP bridge and wires it into config + env when tools are present", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: JSON.stringify({ verdict: "ok" }),
      items: [],
      usage: null,
    }));
    const tool: SdkTool = {
      name: "update_progress",
      description: "d",
      inputSchema: { body: z.string() },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const agent = new CodexAgentAdapter(baseOpts());
    await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [tool],
      decisionSchema: Decision,
      model: "gpt-5-codex",
    });

    expect(startToolBridge).toHaveBeenCalledOnce();
    const ctor = (Codex as unknown as { lastConstructorOpts: any })
      .lastConstructorOpts;
    expect(ctor.env.SHOPFLOOR_MCP_TOKEN).toBe("test-token");
    expect(ctor.config.mcp_servers.shopfloor).toEqual({
      url: "http://127.0.0.1:5555/mcp",
      bearer_token_env_var: "SHOPFLOOR_MCP_TOKEN",
    });
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("omits apiKey from the Codex constructor when not provided", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: JSON.stringify({ verdict: "ok" }),
      items: [],
      usage: null,
    }));
    const { apiKey: _omit, ...noKeyOpts } = baseOpts();
    void _omit;
    const agent = new CodexAgentAdapter(noKeyOpts);
    await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [],
      decisionSchema: Decision,
      model: "m",
    });
    const ctor = (Codex as unknown as { lastConstructorOpts: any })
      .lastConstructorOpts;
    expect("apiKey" in ctor).toBe(false);
  });

  it("maps empty finalResponse to agent_invalid_output", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: "   ",
      items: [],
      usage: null,
    }));
    const err = await runAndCatch();
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("agent_invalid_output");
    expect(err.subtype).toBe("empty_final_response");
  });

  it("maps non-JSON finalResponse to agent_invalid_output", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: "not json",
      items: [],
      usage: null,
    }));
    const err = await runAndCatch();
    expect(err.kind).toBe("agent_invalid_output");
    expect(err.subtype).toBe("json_parse_error");
  });

  it("maps schema-mismatch finalResponse to agent_invalid_output", async () => {
    runImpl.fn = vi.fn(async () => ({
      finalResponse: JSON.stringify({ wrong: 1 }),
      items: [],
      usage: null,
    }));
    const err = await runAndCatch();
    expect(err.kind).toBe("agent_invalid_output");
    expect(err.subtype).toBe("schema_validation_error");
  });

  it("maps a thrown turn failure to agent_execution", async () => {
    runImpl.fn = vi.fn(async () => {
      throw new Error("turn failed: model exploded");
    });
    const err = await runAndCatch();
    expect(err.kind).toBe("agent_execution");
    expect(err.message).toMatch(/model exploded/);
  });

  it("maps an abort (timeout) to agent_timeout", async () => {
    runImpl.fn = vi.fn(
      (_input: string, turnOptions: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          turnOptions.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const agent = new CodexAgentAdapter(baseOpts());
    const err = await agent
      .runStage({
        systemPrompt: "S",
        userPrompt: "U",
        tools: [],
        decisionSchema: Decision,
        model: "m",
        timeoutMs: 10,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("agent_timeout");
  });

  it("warns and proceeds when budgetUsd or maxTurns is set", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    runImpl.fn = vi.fn(async () => ({
      finalResponse: JSON.stringify({ verdict: "ok" }),
      items: [],
      usage: null,
    }));
    const agent = new CodexAgentAdapter(baseOpts());
    await agent.runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [],
      decisionSchema: Decision,
      model: "m",
      budgetUsd: 2.5,
      maxTurns: 10,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/does not enforce/);
  });
});

async function runAndCatch(): Promise<AgentError> {
  const agent = new CodexAgentAdapter(baseOpts());
  return agent
    .runStage({
      systemPrompt: "S",
      userPrompt: "U",
      tools: [],
      decisionSchema: Decision,
      model: "m",
    })
    .catch((e) => e as AgentError) as Promise<AgentError>;
}
