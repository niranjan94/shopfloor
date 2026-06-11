import * as core from "@actions/core";
import {
  type ApprovalMode,
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ensureCodexCli } from "../setup/ensure-codex-cli.js";
import type { AgentAdapter, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";
import { startToolBridge, type ToolBridge } from "./mcp-http-bridge.js";

// Resolved Codex configuration the adapter holds. Built once at startup by
// buildCodexOptions() in src/config/codex-options.ts (auth branch, temp
// CODEX_HOME write, sandbox defaults) — the adapter owns the contract, the
// config layer produces it, mirroring how ClaudeAgentAdapter takes an `env`.
export interface CodexAdapterOptions {
  // OpenAI API key path. Forwarded to the CLI as CODEX_API_KEY by the SDK.
  apiKey?: string;
  // Environment for the Codex CLI process. The SDK does NOT inherit
  // process.env when env is set, so this must carry PATH/HOME/etc. plus any
  // auth vars (e.g. CODEX_HOME for the ChatGPT auth.json path).
  env: Record<string, string>;
  // Additional `--config key=value` overrides flattened by the SDK (e.g.
  // cli_auth_credentials_store, sandbox tweaks).
  config: Record<string, unknown>;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  networkAccessEnabled: boolean;
  skipGitRepoCheck: boolean;
}

export type CodexCliResolver = () => Promise<string>;

export class CodexAgentAdapter implements AgentAdapter {
  // Latches the one-time "caps are ignored" warning so it fires once per
  // adapter instance instead of on every stage (budgetUsd always carries a
  // numeric default, so an unconditional warn would spam every run).
  private capsWarned = false;

  // resolveCli is invoked lazily on the first runStage call. Like the Claude
  // adapter, it locates (or installs) the native `codex` binary, which ships
  // as platform-specific artifacts that won't be present in the committed
  // dist/ bundle on a runner whose arch differs from the build host.
  constructor(
    private readonly opts: CodexAdapterOptions,
    private readonly resolveCli: CodexCliResolver = ensureCodexCli,
  ) {}

  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    // Credentials are validated here, on first use, rather than at construction
    // time. Constructing the adapter must not throw: entry.ts builds it
    // unconditionally, including for `mode: resolve` router jobs that never run
    // an agent. A split-runner setup may legitimately scope Codex creds to the
    // execute job only, so a construction-time throw would deadlock the router.
    // This mirrors the Claude path, whose env builder never throws either.
    if (
      this.opts.apiKey === undefined &&
      this.opts.env.CODEX_HOME === undefined
    ) {
      throw new AgentError(
        "agent_execution",
        "agent_provider=codex requires one of openai_api_key or codex_auth_json.",
      );
    }

    const controller = args.abortController ?? new AbortController();
    // Distinguish our own timeout from a caller-initiated abort so the catch
    // can map them to different AgentError kinds.
    let timedOut = false;
    const timer =
      args.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, args.timeoutMs)
        : null;

    if (
      !this.capsWarned &&
      (args.budgetUsd !== undefined || args.maxTurns !== undefined)
    ) {
      this.capsWarned = true;
      core.warning(
        "Codex does not enforce budgetUsd or maxTurns; these caps are ignored under agent_provider=codex.",
      );
    }

    let bridge: ToolBridge | null = null;

    try {
      const codexPathOverride = await this.resolveCli();

      const env = { ...this.opts.env };
      const config: Record<string, unknown> = { ...this.opts.config };

      if (args.tools.length > 0) {
        bridge = await startToolBridge(args.tools);
        env.SHOPFLOOR_MCP_TOKEN = bridge.token;
        config.mcp_servers = {
          ...(config.mcp_servers as Record<string, unknown> | undefined),
          shopfloor: {
            url: bridge.url,
            bearer_token_env_var: "SHOPFLOOR_MCP_TOKEN",
          },
        };
      }

      logAgentInput(args);

      const codex = new Codex({
        ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
        env,
        // The SDK flattens config to dotted `--config key=value` overrides and
        // serializes values as TOML literals. The nested objects we build here
        // (e.g. mcp_servers.shopfloor) are valid config values at runtime; the
        // cast bridges our neutral Record to the SDK's recursive config type.
        config: config as NonNullable<CodexOptions["config"]>,
        codexPathOverride,
      });

      // Codex has no separate system-prompt field; it concatenates text input.
      const input = `${args.systemPrompt}\n\n${args.userPrompt}`;

      const threadOptions: ThreadOptions = {
        model: args.model,
        sandboxMode: this.opts.sandboxMode,
        approvalPolicy: this.opts.approvalPolicy,
        networkAccessEnabled: this.opts.networkAccessEnabled,
        skipGitRepoCheck: this.opts.skipGitRepoCheck,
        workingDirectory: process.cwd(),
        ...(args.effort !== undefined
          ? { modelReasoningEffort: args.effort as ModelReasoningEffort }
          : {}),
      };

      const thread = codex.startThread(threadOptions);

      core.startGroup("Codex agent run");
      let turn: { finalResponse: string };
      try {
        turn = await thread.run(input, {
          outputSchema: zodToJsonSchema(args.decisionSchema as z.ZodTypeAny, {
            target: "openAi",
          }),
          signal: controller.signal,
        });
        logTurn(turn);
      } finally {
        core.endGroup();
      }

      const raw = turn.finalResponse;
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new AgentError(
          "agent_invalid_output",
          "codex turn returned an empty finalResponse",
          "empty_final_response",
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (err) {
        throw new AgentError(
          "agent_invalid_output",
          `codex finalResponse was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          "json_parse_error",
        );
      }

      try {
        return args.decisionSchema.parse(parsedJson);
      } catch (err) {
        throw new AgentError(
          "agent_invalid_output",
          `codex finalResponse failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
          "schema_validation_error",
        );
      }
    } catch (err) {
      if (err instanceof AgentError) throw err;
      if (timedOut) {
        throw new AgentError(
          "agent_timeout",
          `codex run exceeded ${args.timeoutMs}ms`,
        );
      }
      if (controller.signal.aborted) {
        throw new AgentError("agent_execution", "codex run was aborted");
      }
      throw new AgentError(
        "agent_execution",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (bridge) await bridge.close().catch(() => {});
    }
  }
}

function logAgentInput<T>(args: RunStageArgs<T>): void {
  core.startGroup(`Codex agent input (${args.model})`);
  try {
    core.info(`model: ${args.model}`);
    if (args.effort !== undefined) core.info(`effort: ${args.effort}`);
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

function logTurn(turn: { finalResponse: string }): void {
  const preview =
    turn.finalResponse.length > 600
      ? `${turn.finalResponse.slice(0, 600)}... [truncated, ${turn.finalResponse.length} chars]`
      : turn.finalResponse;
  core.info(`[final] ${preview}`);
}
