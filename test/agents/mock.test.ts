import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockAgentAdapter } from "../../src/agents/mock.js";

describe("MockAgentAdapter", () => {
  const Schema = z.object({ verdict: z.enum(["ok", "bad"]) });

  it("returns the canned decision matching a prompt prefix", async () => {
    const agent = new MockAgentAdapter([
      { matchUserPromptIncludes: "issue-42", decision: { verdict: "ok" } },
    ]);
    const result = await agent.runStage({
      systemPrompt: "you are triage",
      userPrompt: "please triage issue-42",
      tools: [],
      decisionSchema: Schema,
      model: "claude-haiku",
    });
    expect(result).toEqual({ verdict: "ok" });
  });

  it("throws when no canned decision matches", async () => {
    const agent = new MockAgentAdapter([]);
    await expect(
      agent.runStage({
        systemPrompt: "",
        userPrompt: "unmatched",
        tools: [],
        decisionSchema: Schema,
        model: "claude-haiku",
      }),
    ).rejects.toThrow(/no canned decision/i);
  });

  it("supports throwing a canned error", async () => {
    const agent = new MockAgentAdapter([
      {
        matchUserPromptIncludes: "boom",
        error: { kind: "agent_budget", message: "over" },
      },
    ]);
    await expect(
      agent.runStage({
        systemPrompt: "",
        userPrompt: "boom",
        tools: [],
        decisionSchema: Schema,
        model: "claude-haiku",
      }),
    ).rejects.toMatchObject({ kind: "agent_budget" });
  });
});
