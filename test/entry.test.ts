import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", async (orig) => {
  const real = (await orig()) as typeof import("@actions/core");
  return {
    ...real,
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
});

// Stub the git-identity module so runEntry's setup phase doesn't write to the
// host repo's .git/config or contact the GitHub API during unit tests.
vi.mock("../src/git/identity.js", () => ({
  resolveBotIdentity: vi
    .fn()
    .mockResolvedValue({ name: "test-bot", email: "test@bot" }),
  applyGitIdentity: vi.fn().mockResolvedValue(undefined),
}));

import * as core from "@actions/core";
import type { AuditEvent } from "../src/audit/events.js";
import { runEntry } from "../src/entry.js";

describe("runEntry", () => {
  let tmpEventPath: string;

  beforeEach(() => {
    tmpEventPath = path.join(os.tmpdir(), `shopfloor-event-${Date.now()}.json`);
    process.env.GITHUB_EVENT_PATH = tmpEventPath;
    process.env.GITHUB_EVENT_NAME = "issues";
    process.env.GITHUB_REPOSITORY = "octo/demo";
    process.env.GITHUB_RUN_ID = "9001";
    delete process.env.GITHUB_STEP_SUMMARY;
    vi.mocked(core.getInput).mockReset();
    vi.mocked(core.setOutput).mockReset();
    vi.mocked(core.setFailed).mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpEventPath, { force: true });
  });

  it("parses inputs, dispatches the orchestrator, and exits cleanly for a no-route event", async () => {
    fs.writeFileSync(
      tmpEventPath,
      JSON.stringify({
        action: "edited",
        issue: {
          number: 7,
          title: "x",
          body: "y",
          labels: [],
          state: "open",
        },
        repository: { owner: { login: "octo" }, name: "demo" },
      }),
    );

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        anthropic_api_key: "sk-test",
        github_app_client_id: "Iv23x",
        github_app_private_key:
          "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
        github_app_token: "ghs_preminted",
      };
      return inputs[name] ?? "";
    });

    const audit: AuditEvent[] = [];
    await runEntry({
      octokitFactory: (_auth) =>
        ({
          rest: {
            issues: {},
            pulls: {},
            repos: {},
            git: {},
          },
          graphql: () => Promise.resolve({}),
        }) as never,
      auditSink: (e) => audit.push(e),
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(audit.some((e) => e.type === "stage_resolved")).toBe(true);
  });

  it("emits stage and executed action outputs after the orchestrator returns", async () => {
    fs.writeFileSync(
      tmpEventPath,
      JSON.stringify({
        action: "edited",
        issue: {
          number: 7,
          title: "x",
          body: "y",
          labels: [],
          state: "open",
        },
        repository: { owner: { login: "octo" }, name: "demo" },
      }),
    );

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        anthropic_api_key: "sk-test",
        github_app_client_id: "Iv23x",
        github_app_private_key:
          "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
        github_app_token: "ghs_preminted",
      };
      return inputs[name] ?? "";
    });

    await runEntry({
      octokitFactory: (_auth) =>
        ({
          rest: { issues: {}, pulls: {}, repos: {}, git: {} },
          graphql: () => Promise.resolve({}),
        }) as never,
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("stage", "none");
    expect(core.setOutput).toHaveBeenCalledWith("executed", "false");
  });

  it("calls setFailed on missing GITHUB_REPOSITORY", async () => {
    delete process.env.GITHUB_REPOSITORY;
    fs.writeFileSync(tmpEventPath, JSON.stringify({}));
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        anthropic_api_key: "sk-test",
        github_app_client_id: "Iv23x",
        github_app_private_key: "key",
        github_app_token: "ghs_x",
      };
      return inputs[name] ?? "";
    });
    await runEntry({ octokitFactory: () => ({}) as never });
    expect(core.setFailed).toHaveBeenCalled();
  });
});
