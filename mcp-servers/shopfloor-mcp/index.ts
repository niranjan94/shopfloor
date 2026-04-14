#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export async function updateProgress(input: {
  body: string;
}): Promise<{ ok: true }> {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const commentId = process.env.SHOPFLOOR_COMMENT_ID;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!token) throw new Error("GITHUB_TOKEN required");
  if (!owner || !repo) throw new Error("REPO_OWNER and REPO_NAME required");
  if (!commentId) throw new Error("SHOPFLOOR_COMMENT_ID required");

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
