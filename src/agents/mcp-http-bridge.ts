import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SdkTool } from "../tools/types.js";

export interface ToolBridge {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:<port>/mcp */
  url: string;
  /** Random per-run bearer token guarding the endpoint. */
  token: string;
  /** Shut the listener and MCP transport down. */
  close(): Promise<void>;
}

const ENDPOINT_PATH = "/mcp";

// Exposes Shopfloor's neutral SdkTool[] to the Codex CLI subprocess as a real
// MCP server over Streamable HTTP, bound to loopback on an ephemeral port and
// guarded by a random bearer token. The tool handlers run in-process against
// the same live Octokit the rest of the action uses — no second GitHub
// credential and no separate subprocess entry mode.
//
// A single long-lived server+transport pair in stateful mode: the transport
// issues an Mcp-Session-Id on the initialize response and the client echoes it
// on every subsequent request, so the initialize handshake persists across the
// implement-stage Codex run. (Stateless mode is not an option here — the
// transport refuses more than one request per instance, expecting a fresh
// transport per call, which would lose the handshake a persistent client
// relies on.) enableJsonResponse keeps each tool call a plain request/response
// rather than an SSE stream.
export async function startToolBridge(tools: SdkTool[]): Promise<ToolBridge> {
  const token = randomBytes(32).toString("hex");

  const mcpServer = new McpServer({ name: "shopfloor", version: "2.0.0" });
  for (const t of tools) {
    mcpServer.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      // registerTool passes validated args (matching inputSchema) plus an
      // `extra` arg we ignore. The neutral handler returns the same
      // { content, isError } shape MCP expects for a tool result.
      (async (args: unknown) => t.handler(args)) as never,
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  // The SDK's transport class types `onclose` as non-optional while the
  // Transport interface marks it optional; under exactOptionalPropertyTypes
  // that read as incompatible. The instance is a valid Transport at runtime.
  await mcpServer.connect(
    transport as unknown as Parameters<typeof mcpServer.connect>[0],
  );

  const httpServer: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void handle(req, res, transport, token);
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${ENDPOINT_PATH}`;

  return {
    url,
    token,
    async close() {
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  token: string,
): Promise<void> {
  if (!hasValidBearer(req, token)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      }),
    );
    return;
  }

  try {
    const body = await readJsonBody(req);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err) },
          id: null,
        }),
      );
    }
  }
}

function hasValidBearer(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === token;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}
