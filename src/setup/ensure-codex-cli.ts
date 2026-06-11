import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as core from "@actions/core";

// Pinned to match @openai/codex-sdk / @openai/codex in package.json.
// Bump in lockstep with those dependencies.
const CLI_VERSION = "0.139.0";

let cached: Promise<string> | null = null;

export function ensureCodexCli(): Promise<string> {
  if (!cached) cached = resolveCodexCli();
  return cached;
}

export function resetCodexCliCache(): void {
  cached = null;
}

async function resolveCodexCli(): Promise<string> {
  const override = process.env.SHOPFLOOR_CODEX_CLI_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`SHOPFLOOR_CODEX_CLI_PATH=${override} does not exist`);
    }
    core.info(`Using Codex CLI from SHOPFLOOR_CODEX_CLI_PATH: ${override}`);
    return override;
  }

  const onPath = whichCodex();
  if (onPath) {
    core.info(`Using Codex CLI on PATH: ${onPath}`);
    return onPath;
  }

  return installCodexCli();
}

function whichCodex(): string | null {
  const result = spawnSync("sh", ["-c", "command -v codex"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const path = result.stdout.split(/\r?\n/)[0]?.trim();
  return path && existsSync(path) ? path : null;
}

async function installCodexCli(): Promise<string> {
  core.info(
    `Codex CLI not found on PATH. Installing @openai/codex@${CLI_VERSION} globally via npm.`,
  );
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "npm",
      ["install", "-g", `@openai/codex@${CLI_VERSION}`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex CLI installer exited with code ${code}`));
    });
  });

  const onPath = whichCodex();
  if (onPath) {
    core.info(`Installed Codex CLI resolved via PATH: ${onPath}`);
    return onPath;
  }

  throw new Error(
    "Codex CLI installer succeeded but no `codex` binary was found on PATH",
  );
}
