import { describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

import { resolveAgentIsolation } from "../../src/setup/ensure-agent-isolation.js";

function runner(results: { bwrap: number[]; socat: number[] }) {
  const calls: string[] = [];
  const run = vi.fn(async (command: string, args: string[]) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "bwrap") return results.bwrap.shift() ?? 1;
    if (line.includes("command -v socat")) return results.socat.shift() ?? 1;
    return 0;
  });
  return { run, calls };
}

describe("resolveAgentIsolation", () => {
  it("returns no isolation when agent_sandbox is off", async () => {
    const { run } = runner({ bwrap: [0], socat: [0] });
    expect(
      await resolveAgentIsolation("off", { platform: "linux", run }),
    ).toEqual({
      sandbox: false,
      scrubSubprocessEnv: false,
      failIfUnavailable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("enables sandbox and scrubbing when bubblewrap and socat work", async () => {
    const { run } = runner({ bwrap: [0], socat: [0] });
    expect(
      await resolveAgentIsolation("auto", { platform: "linux", run, env: {} }),
    ).toEqual({
      sandbox: true,
      scrubSubprocessEnv: true,
      failIfUnavailable: false,
    });
  });

  it("keeps scrubbing but drops the sandbox when only socat is missing", async () => {
    const { run } = runner({ bwrap: [0], socat: [1] });
    expect(
      await resolveAgentIsolation("auto", { platform: "linux", run, env: {} }),
    ).toEqual({
      sandbox: false,
      scrubSubprocessEnv: true,
      failIfUnavailable: false,
    });
  });

  it("degrades to no isolation in auto mode when bubblewrap is unusable off GitHub-hosted runners", async () => {
    const { run, calls } = runner({ bwrap: [1], socat: [0] });
    const result = await resolveAgentIsolation("auto", {
      platform: "linux",
      run,
      env: { RUNNER_ENVIRONMENT: "self-hosted" },
    });
    expect(result.scrubSubprocessEnv).toBe(false);
    expect(result.sandbox).toBe(false);
    expect(calls.some((c) => c.includes("apt-get"))).toBe(false);
  });

  it("installs dependencies and lifts the AppArmor userns restriction on GitHub-hosted runners", async () => {
    const { run, calls } = runner({ bwrap: [1, 0], socat: [1, 0] });
    const result = await resolveAgentIsolation("auto", {
      platform: "linux",
      run,
      env: { RUNNER_ENVIRONMENT: "github-hosted" },
      readFile: () => "1\n",
    });
    expect(result).toEqual({
      sandbox: true,
      scrubSubprocessEnv: true,
      failIfUnavailable: false,
    });
    expect(calls.some((c) => c.includes("apt-get install"))).toBe(true);
    expect(
      calls.some((c) =>
        c.includes("sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"),
      ),
    ).toBe(true);
  });

  it("throws in required mode when isolation cannot be established", async () => {
    const { run } = runner({ bwrap: [1], socat: [1] });
    await expect(
      resolveAgentIsolation("required", { platform: "linux", run, env: {} }),
    ).rejects.toThrow(/agent_sandbox is required/);
  });

  it("requests a hard failure from the CLI in required mode", async () => {
    const { run } = runner({ bwrap: [0], socat: [0] });
    const result = await resolveAgentIsolation("required", {
      platform: "linux",
      run,
      env: {},
    });
    expect(result.failIfUnavailable).toBe(true);
  });
});
