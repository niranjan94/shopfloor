import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/inputs.js";

const baseInputs: Record<string, string> = {
  anthropic_api_key: "sk-test",
  shopfloor_github_app_client_id: "Iv23test",
  shopfloor_github_app_private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
  trigger_label: "shopfloor",
  max_review_iterations: "3",
  triage_model: "claude-haiku",
  spec_model: "claude-opus",
  plan_model: "claude-opus",
  impl_model: "claude-opus",
  review_compliance_model: "claude-opus",
  review_bugs_model: "claude-opus",
  review_security_model: "claude-opus",
  review_smells_model: "claude-opus",
  triage_max_budget_usd: "0.25",
  impl_max_budget_usd: "2.50",
  triage_timeout_ms: "120000",
};

describe("parseConfig", () => {
  it("parses valid inputs", () => {
    const cfg = parseConfig(baseInputs);
    expect(cfg.triageModel).toBe("claude-haiku");
    expect(cfg.maxReviewIterations).toBe(3);
    expect(cfg.implMaxBudgetUsd).toBe(2.5);
  });

  it("rejects missing required inputs", () => {
    const { anthropic_api_key: _omitted, ...rest } = baseInputs;
    expect(() =>
      parseConfig({ ...rest, claude_code_oauth_token: "" }),
    ).toThrow();
  });

  it("accepts claude_code_oauth_token as an alternative to anthropic_api_key", () => {
    const { anthropic_api_key: _omitted, ...rest } = baseInputs;
    expect(() =>
      parseConfig({ ...rest, claude_code_oauth_token: "oauth-tok" }),
    ).not.toThrow();
  });

  it("rejects non-numeric budget values", () => {
    expect(() =>
      parseConfig({ ...baseInputs, impl_max_budget_usd: "lots" }),
    ).toThrow();
  });
});
