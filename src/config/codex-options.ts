import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAdapterOptions } from "../agents/codex.js";
import type { Config } from "./inputs.js";

// Host env vars forwarded to the Codex CLI process. The SDK does NOT inherit
// process.env when an `env` is provided, so the CLI needs PATH/HOME/etc. to
// find git and write to the workspace. Kept tight for the same reason as the
// Claude adapter's passthrough: avoid leaking INPUT_* secrets and tokens into
// the subprocess. Grow on demand.
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

function passthroughEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_KEYS) {
    const v = hostEnv[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  return env;
}

// Resolves Codex auth + env + sandbox defaults once at startup, mirroring
// buildAgentEnvFromConfig for the Claude adapter. Auth resolution order
// (src/agents/codex.ts design section 6):
//   1. openai_api_key  -> apiKey (forwarded as CODEX_API_KEY by the SDK).
//   2. codex_auth_json -> verbatim contents written to a run-scoped temp
//      CODEX_HOME/auth.json (chmod 600), cli_auth_credentials_store="file".
//      Stateless: reseeded each run, any in-run refresh discarded.
//   3. neither         -> throw a clear error at construction time.
export function buildCodexOptions(config: Config): CodexAdapterOptions {
  const env = passthroughEnv();
  const codexConfig: Record<string, unknown> = {};
  let apiKey: string | undefined;

  if (config.openaiApiKey) {
    apiKey = config.openaiApiKey;
  } else if (config.codexAuthJson) {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    const authPath = join(codexHome, "auth.json");
    writeFileSync(authPath, config.codexAuthJson, { mode: 0o600 });
    chmodSync(authPath, 0o600);
    env.CODEX_HOME = codexHome;
    codexConfig.cli_auth_credentials_store = "file";
  } else {
    throw new Error(
      "agent_provider=codex requires one of openai_api_key (recommended) or codex_auth_json.",
    );
  }

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    env,
    config: codexConfig,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
    networkAccessEnabled: config.codexNetworkAccess,
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
  };
}
