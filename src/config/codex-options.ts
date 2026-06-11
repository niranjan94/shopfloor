import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAdapterOptions } from "../agents/codex.js";
import { collectPassthroughEnv } from "./agent-env.js";
import type { Config } from "./inputs.js";

// Resolves Codex auth + env + sandbox defaults once at startup, mirroring
// buildAgentEnvFromConfig for the Claude adapter. Auth resolution order
// (src/agents/codex.ts design section 6):
//   1. openai_api_key  -> apiKey (forwarded as CODEX_API_KEY by the SDK).
//   2. codex_auth_json -> verbatim contents written to a run-scoped temp
//      CODEX_HOME/auth.json (chmod 600), cli_auth_credentials_store="file".
//      Stateless: reseeded each run, any in-run refresh discarded.
//   3. neither         -> return options without auth; the adapter raises a
//      clear error on first runStage (construction must not throw — see below).
export function buildCodexOptions(config: Config): CodexAdapterOptions {
  const env = collectPassthroughEnv();
  const codexConfig: Record<string, unknown> = {};
  let apiKey: string | undefined;

  if (config.openaiApiKey) {
    apiKey = config.openaiApiKey;
  } else if (config.codexAuthJson) {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    const authPath = join(codexHome, "auth.json");
    // mkdtempSync makes a fresh dir, so authPath never pre-exists and the
    // create-time mode is honored atomically (no world-readable window). 0o600
    // survives any sane umask since umask only clears bits and 0o600 has none
    // to clear, so a follow-up chmod would be redundant.
    writeFileSync(authPath, config.codexAuthJson, { mode: 0o600 });
    env.CODEX_HOME = codexHome;
    codexConfig.cli_auth_credentials_store = "file";
  }
  // When neither credential is set, return options without auth. The missing-
  // credential failure is raised by the adapter on first runStage (see
  // CodexAgentAdapter), not here: construction must not throw because entry.ts
  // builds the adapter unconditionally, including for `mode: resolve` jobs that
  // never run an agent.

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
