import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  query,
  createSdkMcpServer,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
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

// Permission patterns Shopfloor pre-approves on every stage. The agent SDK's
// pattern syntax is `Bash(<prefix>:*)` where the prefix can be a command alone
// (`ls`) or with subcommands (`git add`). Non-bash tool names are matched as
// literals. These defaults run in every project regardless of whether the
// project has its own .claude/settings.json. Project settings stack on top.
export const DEFAULT_AGENT_ALLOW: readonly string[] = [
  // Built-in file ops and search.
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  // Git subcommands the impl prompt authorises. Push and history-rewriting
  // commands are explicitly denied below; the router pushes commits on the
  // agent's behalf at the end of the run.
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git show:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git rev-parse:*)",
  // Standard read-only inspection.
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(wc:*)",
  "Bash(tree:*)",
  "Bash(file:*)",
  "Bash(stat:*)",
  "Bash(which:*)",
  "Bash(echo:*)",
  "Bash(printf:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(jq:*)",
  "Bash(yq:*)",
  "Bash(xargs:*)",
  "Bash(diff:*)",
  "Bash(true:*)",
  "Bash(false:*)",
  // File mutation. Claude Code's sandbox already restricts writes to the
  // session's cwd, so these can't escape the checkout.
  "Bash(mkdir:*)",
  "Bash(mv:*)",
  "Bash(cp:*)",
  "Bash(touch:*)",
  "Bash(sed:*)",
  "Bash(awk:*)",
  "Bash(rm:*)",
  "Bash(ln:*)",
  // JavaScript / TypeScript toolchains.
  "Bash(pnpm:*)",
  "Bash(pnpx:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(yarn:*)",
  "Bash(bun:*)",
  "Bash(bunx:*)",
  "Bash(node:*)",
  "Bash(deno:*)",
  "Bash(tsc:*)",
  "Bash(tsx:*)",
  "Bash(eslint:*)",
  "Bash(prettier:*)",
  "Bash(vitest:*)",
  "Bash(jest:*)",
  // Python toolchains.
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(pip:*)",
  "Bash(pip3:*)",
  "Bash(poetry:*)",
  "Bash(uv:*)",
  "Bash(uvx:*)",
  "Bash(ruff:*)",
  "Bash(black:*)",
  "Bash(mypy:*)",
  "Bash(pytest:*)",
  // Other compiled languages.
  "Bash(go:*)",
  "Bash(cargo:*)",
  "Bash(rustc:*)",
  "Bash(rustup:*)",
  // Generic build runners.
  "Bash(make:*)",
  "Bash(just:*)",
];

// Hard-deny clear footguns. The classifier still gates anything not in the
// allow list, but these get a fast no rather than a model round-trip.
export const DEFAULT_AGENT_DENY: readonly string[] = [
  // Privilege escalation.
  "Bash(sudo:*)",
  "Bash(su:*)",
  "Bash(doas:*)",
  // Outbound SSH and copy-over-network. The agent has zero legitimate reason
  // to reach an external host from the CI runner.
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(sftp:*)",
  "Bash(rsync:*)",
  // Accidental package publishing. A bug in an impl stage must not be able to
  // ship to a registry.
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "Bash(yarn publish:*)",
  "Bash(bun publish:*)",
  "Bash(cargo publish:*)",
  "Bash(gem push:*)",
  "Bash(twine upload:*)",
  "Bash(uv publish:*)",
  "Bash(poetry publish:*)",
  // Container-registry pushes and credential grabs.
  "Bash(docker push:*)",
  "Bash(docker login:*)",
  "Bash(podman push:*)",
  "Bash(podman login:*)",
  // Git mutations the agent must not perform. The router owns the network
  // path (push) and the agent has no business rewriting history, blowing away
  // the working tree, or deleting branches.
  "Bash(git push:*)",
  "Bash(git reset --hard:*)",
  "Bash(git checkout --:*)",
  "Bash(git clean -f:*)",
  "Bash(git branch -D:*)",
  "Bash(git worktree add:*)",
  "Bash(git worktree remove:*)",
  "Bash(git rebase:*)",
];

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
          settings: {
            // Suppress the SDK's default "Co-Authored-By: Claude" trailer on
            // commits and the "Generated with Claude Code" footer on PR bodies.
            // Shopfloor stages produce committed artifacts that should read as
            // neutral, project-appropriate prose; attribution belongs in the
            // PR description, not the artifact itself.
            attribution: {
              commit: "",
              pr: "",
            },
            permissions: {
              allow: [...DEFAULT_AGENT_ALLOW],
              deny: [...DEFAULT_AGENT_DENY],
            },
          },
          mcpServers: { shopfloor: mcpServer },
          allowedTools: args.tools.map((t) => `mcp__shopfloor__${t.name}`),
          permissionMode: "auto",
          outputFormat: {
            type: "json_schema",
            schema: zodToJsonSchema(args.decisionSchema as z.ZodTypeAny),
          },
          ...(args.budgetUsd !== undefined
            ? { maxBudgetUsd: args.budgetUsd }
            : {}),
          ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          ...(this.env ? { env: this.env } : {}),
          abortController: controller,
        },
      });

      core.startGroup("Claude agent events");
      try {
        for await (const msg of stream) {
          logSdkEvent(msg);
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
        core.endGroup();
      }
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
    if (args.budgetUsd !== undefined) core.info(`budgetUsd: ${args.budgetUsd}`);
    if (args.maxTurns !== undefined) core.info(`maxTurns: ${args.maxTurns}`);
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

function logSdkEvent(msg: SDKMessage): void {
  if (msg.type === "system" && msg.subtype === "init") {
    const mcp = msg.mcp_servers.map((s) => `${s.name}:${s.status}`).join(",");
    core.info(
      `[init] model=${msg.model} cwd=${msg.cwd} tools=${msg.tools.length} mcp=${mcp || "(none)"}`,
    );
    return;
  }
  if (msg.type === "assistant") {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as unknown as {
        type?: string;
        [k: string]: unknown;
      };
      if (b.type === "thinking" && typeof b.thinking === "string") {
        core.info(`[thinking] ${truncate(b.thinking, 500)}`);
      } else if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "(unknown)";
        const input = truncate(safeStringify(b.input), 300);
        core.info(`[tool_use] ${name} input=${input}`);
      }
    }
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as unknown as {
        type?: string;
        [k: string]: unknown;
      };
      if (b.type !== "tool_result") continue;
      const status = b.is_error ? "error" : "ok";
      core.info(
        `[tool_result:${status}] ${truncate(extractToolResultText(b.content), 500)}`,
      );
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}... [truncated, ${s.length} chars]`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "(unserializable)";
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeStringify(content);
  return content
    .map((b) => {
      if (b && typeof b === "object") {
        const block = b as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
      return safeStringify(b);
    })
    .join(" ");
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
