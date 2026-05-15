import type { Config } from "./inputs.js";

// Allowlist of host env vars to forward to the Claude Agent SDK. The SDK uses
// this env when shelling out to tools (git, bash) during the implement stage;
// other stages run their tools in-process via the shopfloor MCP server and
// touch the host env minimally. Spreading the full GitHub Actions environment
// would leak INPUT_* secrets, ACTIONS_RUNTIME_TOKEN, and GITHUB_TOKEN into
// every subprocess the SDK spawns — keep this list tight and grow it on
// demand when a stage actually needs something.
const PASSTHROUGH_KEYS = [
  "PATH",
  "HOME",
  "BASH",
  "TMPDIR",
  "USER",
  "TERM",
  "EDITOR",
  "LANG",
  "PAGER",
  "LESS",
  "MANPATH",
] as const;

export interface BuildAgentEnvOptions {
  anthropicApiKey: string;
  claudeCodeOAuthToken: string;
  hostEnv?: NodeJS.ProcessEnv;
}

export function buildAgentEnv(
  opts: BuildAgentEnvOptions,
): Record<string, string> {
  const host = opts.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_KEYS) {
    const v = host[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  // OAuth token wins when both are set. Setting both confuses the SDK's auth
  // resolution; the Zod refinement upstream only enforces "at least one."
  if (opts.claudeCodeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = opts.claudeCodeOAuthToken;
  } else if (opts.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
  }
  return env;
}

export function buildAgentEnvFromConfig(
  config: Config,
): Record<string, string> {
  return buildAgentEnv({
    anthropicApiKey: config.anthropicApiKey,
    claudeCodeOAuthToken: config.claudeCodeOAuthToken,
  });
}
