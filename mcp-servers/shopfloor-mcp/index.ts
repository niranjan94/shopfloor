#!/usr/bin/env bun
import { createPrivateKey, createSign } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface TokenCache {
  token: string;
  expiresAt: number;
}

// Module-level token cache. The MCP server is a long-lived stdio subprocess
// of claude-code-action, so caching here persists for the full impl run and
// survives many update_progress invocations without re-minting. Five-minute
// refresh margin keeps us clear of the 1-hour App installation token ceiling.
let cachedInstallationToken: TokenCache | null = null;
let cachedInstallationId: number | null = null;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export function signAppJwt(clientId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // GitHub caps App JWTs at 10 minutes. 9-minute exp plus 1-minute iat
  // backdate keeps us safely inside that window even under clock skew.
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: clientId,
  };
  const signingInput =
    base64UrlEncode(JSON.stringify(header)) +
    "." +
    base64UrlEncode(JSON.stringify(payload));
  const keyObject = createPrivateKey(privateKeyPem);
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(keyObject);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function discoverInstallationId(
  apiUrl: string,
  owner: string,
  repo: string,
  jwt: string,
): Promise<number> {
  const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/installation`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = typeof res.text === "function" ? await res.text() : "";
    throw new Error(
      `installation discovery failed (${res.status})${text ? ": " + text : ""}`,
    );
  }
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== "number") {
    throw new Error("installation discovery returned no id");
  }
  return data.id;
}

async function mintInstallationToken(params: {
  clientId: string;
  privateKey: string;
  apiUrl: string;
  owner: string;
  repo: string;
  explicitInstallationId?: number;
}): Promise<TokenCache> {
  const jwt = signAppJwt(params.clientId, params.privateKey);
  let installationId = params.explicitInstallationId ?? cachedInstallationId;
  if (installationId == null) {
    installationId = await discoverInstallationId(
      params.apiUrl,
      params.owner,
      params.repo,
      jwt,
    );
    cachedInstallationId = installationId;
  }
  const res = await fetch(
    `${params.apiUrl}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    const text = typeof res.text === "function" ? await res.text() : "";
    throw new Error(
      `installation token mint failed (${res.status})${text ? ": " + text : ""}`,
    );
  }
  const data = (await res.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (!data.token || !data.expires_at) {
    throw new Error("installation token mint response missing fields");
  }
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

export async function getAuthToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const clientId = env.SHOPFLOOR_GITHUB_APP_CLIENT_ID;
  const privateKey = env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY;

  // No App credentials: fall back to the static GITHUB_TOKEN the workflow
  // injected. Local dev, tests, and pipelines without the App installed
  // continue to work transparently via this path.
  if (!clientId || !privateKey) {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "no GitHub credentials: set SHOPFLOOR_GITHUB_APP_CLIENT_ID + SHOPFLOOR_GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN",
      );
    }
    return token;
  }

  if (
    cachedInstallationToken &&
    cachedInstallationToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedInstallationToken.token;
  }

  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  if (!owner || !repo) {
    throw new Error(
      "REPO_OWNER and REPO_NAME required for App-based token minting",
    );
  }
  const explicitIdRaw = env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID;
  const explicitInstallationId =
    explicitIdRaw !== undefined && explicitIdRaw !== ""
      ? Number(explicitIdRaw)
      : undefined;

  cachedInstallationToken = await mintInstallationToken({
    clientId,
    privateKey,
    apiUrl,
    owner,
    repo,
    explicitInstallationId,
  });
  return cachedInstallationToken.token;
}

export function __resetTokenCacheForTests(): void {
  cachedInstallationToken = null;
  cachedInstallationId = null;
}

export async function updateProgress(input: {
  body: string;
}): Promise<{ ok: true }> {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const commentId = process.env.SHOPFLOOR_COMMENT_ID;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!owner || !repo) throw new Error("REPO_OWNER and REPO_NAME required");
  if (!commentId) throw new Error("SHOPFLOOR_COMMENT_ID required");

  const token = await getAuthToken();

  const res = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: input.body }),
    },
  );

  if (!res.ok) {
    const text = typeof res.text === "function" ? await res.text() : "";
    throw new Error(`GitHub API returned ${res.status}: ${text}`);
  }
  return { ok: true };
}

async function runServer(): Promise<void> {
  const server = new McpServer({ name: "shopfloor", version: "1.0.0-rc.0" });
  server.registerTool(
    "update_progress",
    {
      description:
        "Replace the body of the Shopfloor implementation progress comment with new content (typically a markdown checklist of tasks with completion state).",
      inputSchema: {
        body: z.string().describe("New comment body as markdown"),
      },
    },
    async ({ body }) => {
      try {
        await updateProgress({ body });
        return {
          content: [{ type: "text", text: "Progress comment updated." }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `update_progress failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((err) => {
    console.error("shopfloor-mcp fatal:", err);
    process.exit(1);
  });
}
