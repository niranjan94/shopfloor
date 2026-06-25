import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { retryWithBackoff, runCapturing } from "./installer-support.js";

// Pinned to match @anthropic-ai/claude-agent-sdk@0.2.141 in package.json.
// Bump in lockstep with the SDK dependency.
const CLI_VERSION = "2.1.141";

// The install runs `curl | bash` against claude.ai/install.sh, which itself
// pulls the native build from downloads.claude.ai. Both legs are network calls
// on a CI runner and fail transiently (DNS SERVFAIL, connection resets). Retry
// a few times with linear backoff before giving up.
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_BASE_DELAY_MS = 2000;

let cached: Promise<string> | null = null;

export function ensureClaudeCli(): Promise<string> {
  if (!cached) cached = resolveClaudeCli();
  return cached;
}

export function resetClaudeCliCache(): void {
  cached = null;
}

async function resolveClaudeCli(): Promise<string> {
  const override = process.env.SHOPFLOOR_CLAUDE_CLI_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`SHOPFLOOR_CLAUDE_CLI_PATH=${override} does not exist`);
    }
    core.info(`Using Claude CLI from SHOPFLOOR_CLAUDE_CLI_PATH: ${override}`);
    return override;
  }

  const onPath = whichClaude();
  if (onPath) {
    core.info(`Using Claude CLI on PATH: ${onPath}`);
    return onPath;
  }

  return installClaudeCli();
}

function whichClaude(): string | null {
  const result = spawnSync("sh", ["-c", "command -v claude"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const path = result.stdout.split(/\r?\n/)[0]?.trim();
  return path && existsSync(path) ? path : null;
}

// Run under bash with `set -o pipefail` so a curl failure (e.g. DNS SERVFAIL
// before install.sh is even fetched) propagates as the pipeline's exit code
// instead of being masked by bash exiting 0 on empty stdin. The command already
// pipes into bash, so requiring bash here adds no new dependency. Without
// pipefail the captured diagnostic tail would be discarded and the failure
// would surface as a misleading "no binary found".
function runInstallScript(): Promise<void> {
  return runCapturing(
    "bash",
    [
      "-c",
      `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLI_VERSION}`,
    ],
    "Claude CLI installer",
  );
}

async function installClaudeCli(): Promise<string> {
  core.info(
    `Claude CLI not found on PATH. Installing v${CLI_VERSION} via claude.ai/install.sh`,
  );
  // install.sh defaults to ~/.local/bin/claude.
  const defaultPath = join(homedir(), ".local", "bin", "claude");

  return retryWithBackoff(
    async () => {
      await runInstallScript();
      if (existsSync(defaultPath)) {
        core.info(`Installed Claude CLI at ${defaultPath}`);
        return defaultPath;
      }
      const onPath = whichClaude();
      if (onPath) {
        core.info(`Installed Claude CLI resolved via PATH: ${onPath}`);
        return onPath;
      }
      throw new Error(
        `Claude CLI installer succeeded but no binary found at ${defaultPath} or on PATH`,
      );
    },
    {
      attempts: INSTALL_ATTEMPTS,
      baseDelayMs: INSTALL_RETRY_BASE_DELAY_MS,
      onRetry: (attempt, error) =>
        core.warning(
          `Claude CLI install attempt ${attempt}/${INSTALL_ATTEMPTS} failed: ${error.message}. Retrying...`,
        ),
    },
  );
}
