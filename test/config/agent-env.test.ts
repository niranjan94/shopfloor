import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "../../src/config/agent-env.js";

describe("buildAgentEnv", () => {
  it("forwards only allowlisted host env vars", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "sk-test",
      claudeCodeOAuthToken: "",
      hostEnv: {
        PATH: "/usr/bin",
        HOME: "/root",
        GITHUB_TOKEN: "ghs_should_not_leak",
        INPUT_ANTHROPIC_API_KEY: "sk-should_not_leak",
        ACTIONS_RUNTIME_TOKEN: "should_not_leak",
        ANTHROPIC_API_KEY: "stale_host_value_should_be_overwritten",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("uses ANTHROPIC_API_KEY when only the API key is set", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "sk-test",
      claudeCodeOAuthToken: "",
      hostEnv: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("uses CLAUDE_CODE_OAUTH_TOKEN when only the OAuth token is set", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "",
      claudeCodeOAuthToken: "oauth-tok",
      hostEnv: {},
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("prefers OAuth token when both credentials are set", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "sk-test",
      claudeCodeOAuthToken: "oauth-tok",
      hostEnv: {},
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("skips host env vars that are empty strings", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "sk-test",
      claudeCodeOAuthToken: "",
      hostEnv: { PATH: "", HOME: "/root" },
    });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBe("/root");
  });

  it("returns no credential when neither is set", () => {
    const env = buildAgentEnv({
      anthropicApiKey: "",
      claudeCodeOAuthToken: "",
      hostEnv: { PATH: "/usr/bin" },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
