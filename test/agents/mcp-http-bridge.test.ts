import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  startToolBridge,
  type ToolBridge,
} from "../../src/agents/mcp-http-bridge.js";
import type { SdkTool } from "../../src/tools/types.js";

let bridge: ToolBridge | null = null;

afterEach(async () => {
  if (bridge) await bridge.close();
  bridge = null;
});

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

async function rpc(
  url: string,
  token: string | null,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function initialize(url: string, token: string): Promise<Response> {
  return rpc(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
}

describe("startToolBridge", () => {
  it("invokes the tool handler over MCP and returns its result", async () => {
    const handler = vi.fn(async (input: unknown) => {
      const { body } = input as { body: string };
      return { content: [{ type: "text" as const, text: `got:${body}` }] };
    });
    const tool: SdkTool = {
      name: "update_progress",
      description: "test tool",
      inputSchema: { body: z.string().min(1) },
      handler,
    };

    bridge = await startToolBridge([tool]);
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const initRes = await initialize(bridge.url, bridge.token);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const callRes = await rpc(
      bridge.url,
      bridge.token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "update_progress", arguments: { body: "hello" } },
      },
      sessionId ?? undefined,
    );
    expect(callRes.status).toBe(200);
    const payload = (await callRes.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ body: "hello" });
    expect(payload.result?.content?.[0]?.text).toBe("got:hello");
  });

  it("rejects requests without the bearer token", async () => {
    const handler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const tool: SdkTool = {
      name: "update_progress",
      description: "test tool",
      inputSchema: { body: z.string() },
      handler,
    };
    bridge = await startToolBridge([tool]);

    const noToken = await initialize(bridge.url, "");
    expect(noToken.status).toBe(401);

    const wrongToken = await rpc(bridge.url, "not-the-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect(wrongToken.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
