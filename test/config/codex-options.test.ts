import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCodexOptions } from "../../src/config/codex-options.js";
import { baseConfig } from "../_harness/config.js";

describe("buildCodexOptions", () => {
  it("uses openai_api_key as apiKey without a CODEX_HOME", () => {
    const opts = buildCodexOptions({ ...baseConfig, openaiApiKey: "sk-1" });
    expect(opts.apiKey).toBe("sk-1");
    expect(opts.env.CODEX_HOME).toBeUndefined();
    expect(opts.config.cli_auth_credentials_store).toBeUndefined();
    expect(opts.sandboxMode).toBe("workspace-write");
    expect(opts.approvalPolicy).toBe("never");
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.skipGitRepoCheck).toBe(true);
  });

  it("seeds codex_auth_json into a 0600 temp CODEX_HOME/auth.json", () => {
    const opts = buildCodexOptions({
      ...baseConfig,
      openaiApiKey: "",
      codexAuthJson: '{"tokens":{"access":"x"}}',
    });
    expect(opts.apiKey).toBeUndefined();
    const home = opts.env.CODEX_HOME;
    expect(home).toBeTruthy();
    expect(opts.config.cli_auth_credentials_store).toBe("file");
    const authPath = `${home}/auth.json`;
    expect(readFileSync(authPath, "utf8")).toBe('{"tokens":{"access":"x"}}');
    // Low 9 permission bits must be owner-only read/write.
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("throws when neither openai_api_key nor codex_auth_json is set", () => {
    expect(() =>
      buildCodexOptions({ ...baseConfig, openaiApiKey: "", codexAuthJson: "" }),
    ).toThrow(/requires one of openai_api_key/);
  });
});
