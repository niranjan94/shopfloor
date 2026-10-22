import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as core from "@actions/core";
import type { AgentSandboxMode } from "../config/inputs.js";

// Claude Code isolates the agent's Bash subprocesses with bubblewrap on Linux.
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB strips Anthropic credentials from those
// subprocesses and runs them in a separate PID namespace, so they cannot read
// the action's own environment (which holds the App private keys as INPUT_*
// variables) through /proc. The sandbox additionally restricts filesystem
// writes and routes network access through a filtering proxy, which needs
// socat. The CLI refuses to start with the scrub enabled when bubblewrap is
// missing, so both are only switched on after a successful probe.

export interface AgentIsolation {
  sandbox: boolean;
  scrubSubprocessEnv: boolean;
  failIfUnavailable: boolean;
}

export const NO_ISOLATION: AgentIsolation = {
  sandbox: false,
  scrubSubprocessEnv: false,
  failIfUnavailable: false,
};

export interface IsolationDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => Promise<number>;
  readFile?: (path: string) => string | null;
}

const APPARMOR_USERNS_SYSCTL =
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

const SETUP_HINT =
  "Install bubblewrap and socat on the runner (sudo apt-get install -y bubblewrap socat) and, on Ubuntu 24.04 or later, run sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 before Shopfloor.";

let cached: Promise<AgentIsolation> | null = null;

export function ensureAgentIsolation(
  mode: AgentSandboxMode,
): Promise<AgentIsolation> {
  if (!cached) cached = resolveAgentIsolation(mode);
  return cached;
}

export function resetAgentIsolationCache(): void {
  cached = null;
}

export async function resolveAgentIsolation(
  mode: AgentSandboxMode,
  deps: IsolationDeps = {},
): Promise<AgentIsolation> {
  if (mode === "off") {
    core.warning(
      "agent_sandbox is off: agent shell commands run without a sandbox and can read the action's environment, including credentials passed as inputs.",
    );
    return NO_ISOLATION;
  }
  const failIfUnavailable = mode === "required";
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") {
    return { sandbox: true, scrubSubprocessEnv: true, failIfUnavailable };
  }

  const run = deps.run ?? runQuiet;
  const env = deps.env ?? process.env;
  let probe = await probeLinux(run);
  if (
    (!probe.bwrap || !probe.socat) &&
    env.RUNNER_ENVIRONMENT === "github-hosted"
  ) {
    await installOnGithubHostedRunner(run, deps.readFile ?? readFileOrNull);
    probe = await probeLinux(run);
  }

  if (probe.bwrap && probe.socat) {
    return { sandbox: true, scrubSubprocessEnv: true, failIfUnavailable };
  }
  const missing = probe.bwrap
    ? "socat is not available"
    : "bubblewrap is not available or cannot create namespaces";
  if (failIfUnavailable) {
    throw new Error(`agent_sandbox is required but ${missing}. ${SETUP_HINT}`);
  }
  if (probe.bwrap) {
    core.warning(
      `Agent sandbox disabled because ${missing}; subprocess credential scrubbing is still enabled. ${SETUP_HINT}`,
    );
    return { sandbox: false, scrubSubprocessEnv: true, failIfUnavailable };
  }
  core.warning(
    `Agent sandbox and subprocess credential scrubbing are disabled because ${missing}. Agent shell commands can read the action's environment, including credentials passed as inputs. ${SETUP_HINT} Set agent_sandbox: required to fail instead.`,
  );
  return NO_ISOLATION;
}

async function probeLinux(
  run: (command: string, args: string[]) => Promise<number>,
): Promise<{ bwrap: boolean; socat: boolean }> {
  const bwrap =
    (await run("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-user",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "true",
    ])) === 0;
  const socat = (await run("sh", ["-c", "command -v socat"])) === 0;
  return { bwrap, socat };
}

async function installOnGithubHostedRunner(
  run: (command: string, args: string[]) => Promise<number>,
  readFile: (path: string) => string | null,
): Promise<void> {
  core.info("Installing bubblewrap and socat for agent isolation");
  const installed = await run("sh", [
    "-c",
    "sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends bubblewrap socat",
  ]);
  if (installed !== 0) {
    core.warning(`Installing bubblewrap and socat failed (exit ${installed}).`);
  }
  if (readFile(APPARMOR_USERNS_SYSCTL)?.trim() === "1") {
    await run("sudo", [
      "-n",
      "sysctl",
      "-w",
      "kernel.apparmor_restrict_unprivileged_userns=0",
    ]);
  }
}

function readFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function runQuiet(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
