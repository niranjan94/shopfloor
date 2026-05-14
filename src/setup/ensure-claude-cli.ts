import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";

// Pinned to match @anthropic-ai/claude-agent-sdk@0.2.141 in package.json.
// Bump in lockstep with the SDK dependency.
const CLI_VERSION = "2.1.141";

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
      throw new Error(
        `SHOPFLOOR_CLAUDE_CLI_PATH=${override} does not exist`,
      );
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

async function installClaudeCli(): Promise<string> {
  core.info(
    `Claude CLI not found on PATH. Installing v${CLI_VERSION} via claude.ai/install.sh`,
  );
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "sh",
      [
        "-c",
        `curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLI_VERSION}`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Claude CLI installer exited with code ${code}`));
    });
  });

  // install.sh defaults to ~/.local/bin/claude.
  const defaultPath = join(homedir(), ".local", "bin", "claude");
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
}
