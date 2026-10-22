# Codex Agent Adapter — Design

Date: 2026-06-11
Status: Approved, pending implementation plan

## Summary

Add a second `AgentAdapter` implementation that runs Shopfloor stages through OpenAI's Codex agent (`@openai/codex-sdk`) instead of Claude. Selection is global: a new `agent_provider: claude | codex` action input picks which adapter `entry.ts` constructs. Everything downstream of the adapter interface (orchestrator, `StageContext`, every stage runner, the state machine) is untouched, because they depend only on the `AgentAdapter` contract and the `AgentError` taxonomy.

The one genuinely new piece is a tool bridge: Shopfloor's single MCP tool (`update_progress`, implement stage only) is exposed to the Codex CLI subprocess through an in-process Streamable HTTP MCP server, reusing the existing handler closures (and the live in-memory Octokit) rather than spawning a separate credentialed process.

## Goals

- A `CodexAgentAdapter` that satisfies `AgentAdapter.runStage<T>()` with the same structured-output and error semantics as `ClaudeAgentAdapter`.
- Global provider selection via `agent_provider`, defaulting to `claude` (no behavior change for existing consumers).
- Tool parity for the implement stage via a real MCP server (Streamable HTTP, in-process).
- Two auth modes: OpenAI API key, or a ChatGPT-managed `auth.json` supplied verbatim from a secret.

## Non-goals

- Per-stage provider mixing (e.g. Claude for implement, Codex for review). Selection is global for now.
- `auth.json` refresh, rotation, or persistence. The contents are seeded from a secret on every run; any in-run refresh is discarded. Re-seeding a stale token is a manual/ops concern, explicitly out of scope.
- Changes to `ecs-arc` or any runner infrastructure. The adapter reads `CODEX_HOME` / an API key and runs; where the secret comes from is the consumer workflow's problem.
- `budgetUsd` / `maxTurns` enforcement. The Codex SDK does not surface cost or turn caps, so these args are accepted and dropped with a warning.
- Dedicated `base_url` / Azure-style inputs. Reachable today via the Codex `config` passthrough (`openai_base_url`); a first-class action input is deferred until a consumer needs it.

## Background: the current adapter system

`src/agents/adapter.ts` defines the contract:

```ts
export interface AgentAdapter {
  runStage<T>(args: RunStageArgs<T>): Promise<T>;
}
```

`RunStageArgs<T>` carries `systemPrompt`, `userPrompt`, `tools: SdkTool[]`, `decisionSchema: z.ZodType<T, ..., unknown>`, `model`, and optional `effort`, `budgetUsd`, `maxTurns`, `timeoutMs`, `abortController`. Failures are normalized to `AgentError` with a `kind` of `agent_timeout | agent_budget | agent_max_turns | agent_invalid_output | agent_execution`.

`ClaudeAgentAdapter` (`src/agents/claude.ts`) wraps `@anthropic-ai/claude-agent-sdk`: it resolves the native Claude CLI, wraps `args.tools` in an in-process MCP server via `createSdkMcpServer`, converts `decisionSchema` to JSON Schema for the CLI's structured-output mode, streams events, and parses the final `structured_output` back through the Zod schema.

`MockAgentAdapter` (`src/agents/mock.ts`) returns canned responses keyed by prompt substring; used by every stage and e2e test.

Adapters are constructed exactly once, in `entry.ts:172-174`, and passed to `runOrchestrator` as `AgentAdapter`. Stage runners receive it via `StageContext.agent` and call `ctx.agent.runStage(...)`.

Tools today: `triageTools`, `specTools`, `planTools`, and all four review-lens `*Tools` functions return `[]`. Only `implementTools` (`src/stages/implement/tools.ts`) returns a non-empty array — a single `update_progress` tool (`src/tools/update-progress.ts`) whose handler calls `github.updateIssueComment(commentId, body)` over the live in-memory Octokit.

## Background: the Codex TypeScript SDK

`@openai/codex-sdk` spawns the `codex` CLI (from `@openai/codex`) and exchanges JSONL over stdio — structurally identical to how the Claude adapter spawns the Claude CLI.

- `new Codex(opts)` — `opts`: `apiKey`, `baseUrl`, `env`, `config` (object flattened to dotted-path `--config key=value` TOML overrides), `codexPathOverride`.
- `codex.startThread(threadOptions)` — `threadOptions`: `model`, `modelReasoningEffort` (`minimal | low | medium | high | xhigh`), `sandboxMode` (`read-only | workspace-write | danger-full-access`), `approvalPolicy` (`never | on-request | on-failure | untrusted`), `networkAccessEnabled`, `skipGitRepoCheck`, `workingDirectory`, `additionalDirectories`, ...
- `thread.run(input, turnOptions)` returns `{ items, finalResponse, usage }`. `turnOptions`: `outputSchema` (a JSON Schema object) and `signal` (an `AbortSignal`). On a `turn.failed` event the SDK throws `new Error(turnFailure.message)`.
- Structured output: set `turnOptions.outputSchema = zodToJsonSchema(schema, { target: "openAi" })`; the conforming JSON arrives as the `finalResponse` string.
- MCP: Codex supports both stdio and **Streamable HTTP** MCP servers, configured under `[mcp_servers.<name>]`. HTTP servers take `url` and optional `bearer_token_env_var` / `http_headers` / `env_http_headers`.

## Design

### 1. `CodexAgentAdapter` (`src/agents/codex.ts`)

Implements `AgentAdapter`. Constructor takes resolved Codex options (auth + env + optional sandbox overrides) and an injectable CLI resolver, mirroring `ClaudeAgentAdapter`'s `resolveCli`:

```ts
export class CodexAgentAdapter implements AgentAdapter {
  constructor(
    private readonly opts: CodexAdapterOptions,
    private readonly resolveCli: CodexCliResolver = ensureCodexCli,
  ) {}
  async runStage<T>(args: RunStageArgs<T>): Promise<T> { ... }
}
```

`runStage` flow:

1. Build a timeout `AbortController` from `args.timeoutMs` / `args.abortController` (same pattern as `claude.ts`).
2. If `args.budgetUsd` or `args.maxTurns` is set, emit a one-time `core.warning` that Codex does not enforce them.
3. Resolve the `codex` binary via `this.resolveCli()` and pass it as `codexPathOverride`.
4. If `args.tools.length > 0`, start the in-process MCP bridge (section 2) and add an `mcp_servers.shopfloor` entry to the Codex `config`, injecting the bearer token via `env`.
5. `new Codex({ apiKey?, env, config, codexPathOverride })`; `startThread(threadOptions)`; `await thread.run(input, { outputSchema, signal })`.
   - `input`: `systemPrompt` prepended to `userPrompt` as a single text block (Codex has no separate system-prompt field; it concatenates text inputs).
   - `threadOptions.model = args.model`; `threadOptions.modelReasoningEffort = args.effort` (1:1; Codex's extra `minimal` is unused); sandbox/approval/network from `opts` defaults (section 4).
   - `outputSchema = zodToJsonSchema(args.decisionSchema, { target: "openAi" })`.
   - `signal = controller.signal`.
6. Parse: `args.decisionSchema.parse(JSON.parse(turn.finalResponse))`. Return the typed `T`.
7. `finally`: clear the timer and `close()` the MCP bridge.

### 2. In-process Streamable HTTP MCP bridge (`src/agents/mcp-http-bridge.ts`)

```ts
export async function startToolBridge(tools: SdkTool[]): Promise<{
  url: string;       // http://127.0.0.1:<port>/mcp
  token: string;     // random per-run bearer token
  close(): Promise<void>;
}>;
```

- Builds an `McpServer` (`@modelcontextprotocol/sdk/server/mcp`), registering each `SdkTool` via `server.registerTool(name, { description, inputSchema: tool.inputSchema }, tool.handler)` — `registerTool` accepts a Zod raw shape as `inputSchema`, which is exactly what section 3 makes available. Handler closures are reused verbatim. (`@modelcontextprotocol/sdk@1.29.0` is already present as a transitive dependency of the Claude SDK; section 9 promotes it to a direct dependency. `StreamableHTTPServerTransport` and `registerTool` are both confirmed present in that version.)
- Serves it over `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/streamableHttp`) bound to `127.0.0.1` on an ephemeral port, guarded by a random bearer token (requests without `Authorization: Bearer <token>` are rejected).
- The Codex adapter passes Codex:

  ```toml
  [mcp_servers.shopfloor]
  url = "http://127.0.0.1:<port>/mcp"
  bearer_token_env_var = "SHOPFLOOR_MCP_TOKEN"
  ```

  with `SHOPFLOOR_MCP_TOKEN` set in the Codex `env`.
- `close()` shuts the listener down; called in the adapter's `finally`.

This keeps the `update_progress` handler in-process against the live Octokit — no second GitHub credential, no separate subprocess entry mode.

### 3. Retype the neutral tool's Zod shape (`src/tools/types.ts`)

`SdkTool.inputSchema` is currently typed `unknown`, but the runtime object already carries the raw Zod shape: the Claude SDK's `tool()` returns `SdkMcpToolDefinition<Schema>` with `inputSchema: Schema` where `Schema extends AnyZodRawShape` (verified in `@anthropic-ai/claude-agent-sdk/sdk.d.ts:3099-3102, 5632-5636`). `update-progress.ts` only needs the `as unknown as SdkTool` cast *because* the placeholder type under-describes that field. So no new field is needed — **retype the existing one**:

```ts
import type { z } from "zod";
export type SdkTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape; // was: unknown
  handler: (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};
```

This lets the cast in `update-progress.ts` relax (the `tool()` return already structurally matches), the Claude adapter's `createSdkMcpServer(args.tools)` path is unchanged at runtime, and the HTTP bridge (section 2) reads `tool.inputSchema` directly as the Zod raw shape it passes to `registerTool`. Avoids the name collision a separate `inputShape` field would introduce.

### 4. Sandbox / permission policy

The Claude adapter applies one global allow/deny list regardless of stage; the Codex adapter mirrors that with a single global policy (the adapter receives no stage identity in `RunStageArgs`):

- `approvalPolicy: "never"`
- `sandboxMode: "workspace-write"`
- `networkAccessEnabled: true`
- `skipGitRepoCheck: true`

These are defaults on `CodexAdapterOptions`, overridable through the Codex `config` passthrough if a consumer needs to tighten or loosen them.

### 5. Error mapping

- Abort due to our timeout (`AbortError`) → `AgentError("agent_timeout", ...)`.
- `JSON.parse` failure, Zod `parse` failure, or empty/missing `finalResponse` → `AgentError("agent_invalid_output", ...)`.
- Any other thrown error, including Codex `turn.failed` → `AgentError("agent_execution", ...)`.
- `agent_budget` / `agent_max_turns` are never produced (Codex does not surface these; the args are warned-and-dropped instead).

### 6. Auth (`src/agents/codex.ts` resolution)

Resolved once when the adapter is constructed in `entry.ts`, in order:

1. `openai_api_key` present → `new Codex({ apiKey })` (Codex forwards it as `CODEX_API_KEY`). Recommended for CI.
2. `codex_auth_json` present → write the verbatim contents to a **run-scoped temp `CODEX_HOME`** (`<tmpdir>/codex-home/auth.json`, `chmod 600`), set Codex `config.cli_auth_credentials_store = "file"`, and pass `CODEX_HOME=<tmpdir>/codex-home` via `env`. Stateless: reseeded each run, in-run refresh discarded.
3. Neither (when `agent_provider == codex`) → throw a clear error at construction time.

Both inputs are secrets; neither is logged. Using a temp `CODEX_HOME` (not `~/.codex`) keeps the run isolated and avoids clobbering any host config.

Resolution lives in a new helper `buildCodexOptions(config)` in **`src/config/codex-options.ts`** (sibling to `buildAgentEnvFromConfig` in `src/config/agent-env.ts`), invoked from `entry.ts` to construct the adapter. It performs the auth branch above — including writing `auth.json` into the temp `CODEX_HOME` for the ChatGPT path — and returns a plain options object the adapter holds:

```ts
export interface CodexAdapterOptions {
  apiKey?: string;                 // path 1
  env: Record<string, string>;    // includes CODEX_HOME when path 2 is used
  config: Record<string, unknown>; // Codex --config overrides (e.g. cli_auth_credentials_store, sandbox)
  sandboxMode: SandboxMode;        // default "workspace-write"
  approvalPolicy: ApprovalMode;    // default "never"
  networkAccessEnabled: boolean;   // default true
  skipGitRepoCheck: boolean;       // default true
}
export function buildCodexOptions(config: Config): CodexAdapterOptions;
```

The temp-dir write happens once in `buildCodexOptions` (construction time), consistent with the "resolved once" model. A ChatGPT `auth.json` that expires mid-run (e.g. during a long implement stage, `impl_timeout_ms` default 60min) will surface as a Codex auth failure → `agent_execution`; the example workflow documents using `openai_api_key` for long runs to avoid this.

### 7. CLI resolution (`ensureCodexCli`) and working directory

Mirror the Claude adapter's injectable `resolveCli`, whose concrete resolver lives in `src/setup/ensure-claude-cli.ts`. `ensureCodexCli` (new, same module style) locates (or installs) the `codex` binary from `@openai/codex` and returns its path for `codexPathOverride`. The same native-binary-in-bundle concern that applies to the Claude SDK (per `CLAUDE.md`'s esbuild notes) applies here and must be verified in the bundled `dist/index.cjs` on a runner.

**Working directory / checkout.** Like the Claude agent, Codex operates on the already-checked-out repo in `process.cwd()`; the adapter sets `threadOptions.workingDirectory = process.cwd()`. Shopfloor's checkout and push flow is provider-agnostic and unchanged: `entry.ts` builds `gitOps` (`prepareImplCheckout` / `pushImplCommits` / `prepareReviewBase`, from `src/git/impl-checkout.ts`) and the implement runner calls them *around* the agent invocation, not inside it. The agent (Claude or Codex) only edits files in `cwd`. `skipGitRepoCheck: true` is safe because Shopfloor guarantees a checked-out git repo before any stage runs; it just suppresses Codex's own redundant precheck.

### 8. Provider selection and wiring (`entry.ts`, `src/config/inputs.ts`, `action.yml`)

- New action inputs: `agent_provider` (`claude` default), `openai_api_key`, `codex_auth_json`, and optional sandbox overrides. Add them to `action.yml` and to `INPUT_KEYS` in `entry.ts`. In `src/config/inputs.ts`, add Zod fields to the `RawInputs` schema (with `agent_provider` defaulting to `claude`) **and** surface them on the object `parseConfig` returns (`config.agentProvider`, `config.openaiApiKey`, `config.codexAuthJson`), alongside existing fields like `githubApp` / `reviewGithubApp`. (Note: a few secrets such as `github_app_review_token` are read straight from `rawInputs` in `entry.ts` rather than via `Config`; the Codex inputs go through `Config` because `buildCodexOptions(config)` consumes them.) The existing per-stage `*_model` / `*_effort` inputs are provider-neutral strings already passed through `args.model` / `args.effort`, so they work for Codex unchanged.
- Loosen `RunEntryDeps.agentFactory` from `() => InstanceType<typeof ClaudeAgentAdapter>` to `() => AgentAdapter` (so tests can inject either adapter).
- Branch the construction at `entry.ts:172-174`:

  ```ts
  const agent = deps.agentFactory
    ? deps.agentFactory()
    : config.agentProvider === "codex"
      ? new CodexAgentAdapter(buildCodexOptions(config))
      : new ClaudeAgentAdapter(buildAgentEnvFromConfig(config));
  ```

  `buildCodexOptions(config)` (new helper, alongside `buildAgentEnvFromConfig`) resolves auth + env + sandbox defaults.

### 9. Dependencies (`package.json`)

Add `@openai/codex-sdk` and `@openai/codex` (new). Promote `@modelcontextprotocol/sdk` from transitive (already resolved at `1.29.0` via the Claude SDK) to a **direct** dependency so the HTTP bridge can import it stably. `zod` and `zod-to-json-schema` are already present (installed `zod-to-json-schema@3.25.2`); confirm that version supports `{ target: "openAi" }` (see open risks).

### 10. Example consumer workflow (`examples/shopfloor-codex.yml`)

Mirror `examples/shopfloor.yml`, setting `agent_provider: codex` and feeding `openai_api_key: ${{ secrets.OPENAI_API_KEY }}` (recommended) or `codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}`. Document the stale-token caveat for the ChatGPT path in a comment.

## File impact

| File | Change |
| --- | --- |
| `src/agents/codex.ts` | **new** — `CodexAgentAdapter`, `buildCodexOptions`-consumed options, `ensureCodexCli` |
| `src/agents/mcp-http-bridge.ts` | **new** — `SdkTool[]` → in-process Streamable HTTP MCP server |
| `src/config/codex-options.ts` | **new** — `buildCodexOptions(config)` + `CodexAdapterOptions` (auth branch, temp `CODEX_HOME` write, sandbox defaults) |
| `src/tools/types.ts` | retype `SdkTool.inputSchema` from `unknown` → `z.ZodRawShape` |
| `src/tools/update-progress.ts` | relax the `as unknown as SdkTool` cast |
| `src/agents/claude.ts` | no change (runtime `createSdkMcpServer(args.tools)` path already matches) |
| `src/config/inputs.ts` | parse `agent_provider`, `openai_api_key`, `codex_auth_json`, sandbox overrides |
| `action.yml` | declare the new inputs |
| `src/entry.ts` | add inputs to `INPUT_KEYS`; loosen `agentFactory` type; provider branch |
| `package.json` | add Codex SDK, Codex CLI, MCP SDK deps |
| `examples/shopfloor-codex.yml` | **new** consumer workflow |
| `CLAUDE.md`, `README` | document the adapter, provider input, and Codex auth |
| `test/agents/codex.test.ts`, bridge test | **new** unit tests |
| `dist/index.cjs` | rebuilt (committed) |

## Testing

- `CodexAgentAdapter` unit tests against a faked Codex SDK (inject `Codex`/thread): assert option mapping (`model`, `modelReasoningEffort`, `outputSchema`, sandbox), structured-output parse, each error → correct `AgentError.kind`, abort → `agent_timeout`, and the `budgetUsd`/`maxTurns` warning.
- MCP bridge test: start it, call `update_progress` over MCP, assert the handler closure fired and that requests without the bearer token are rejected.
- Existing stage and e2e tests stay on `MockAgentAdapter`, unchanged.
- Verify the bundled `dist/index.cjs` resolves the `codex` binary at runtime (the `import.meta.url` / native-binary class of bug called out in `CLAUDE.md`).

## Commit breakdown (Conventional Commits)

1. `refactor(tools): type SdkTool.inputSchema as a zod raw shape`
2. `feat(agents): add in-process Streamable HTTP MCP bridge`
3. `feat(agents): add Codex adapter wrapping @openai/codex-sdk`
4. `feat(config): add agent_provider + Codex auth inputs and entry wiring`
5. `docs: add Codex consumer workflow example and update CLAUDE.md/README`
6. `test(agents): cover Codex adapter and MCP bridge`
7. `chore(build): rebuild dist bundle`

## Open risks

- **Native CLI in the bundle.** The `codex` binary is a platform-specific artifact shipped via `@openai/codex` optional packages; resolution from the committed `dist/index.cjs` on a CI runner must be verified (same failure mode as the Claude CLI).
- **`zod-to-json-schema` target.** Codex requires `{ target: "openAi" }`; the Claude path does not pass a target. Confirm the installed version supports the `openAi` target.
- **System-prompt folding.** Prepending `systemPrompt` to the input is a behavioral difference from the Claude preset-append model; stage prompts may need minor wording review when run under Codex, but no structural change.
- **Stale ChatGPT token.** Out of scope by decision; documented as a manual re-seed.
