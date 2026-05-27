import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeAgentAdapter } from "../../src/agents/claude.js";

const RUN_LIVE = process.env.ANTHROPIC_API_KEY != null;

describe.skipIf(!RUN_LIVE)("ClaudeAgentAdapter (live)", () => {
  it("returns a structured decision for a trivial prompt", async () => {
    const Decision = z.object({ greeting: z.string() });
    const agent = new ClaudeAgentAdapter();
    const result = await agent.runStage({
      systemPrompt: "Return a friendly greeting in JSON.",
      userPrompt: "say hi",
      tools: [],
      decisionSchema: Decision,
      model: "claude-haiku",
      budgetUsd: 0.5,
      timeoutMs: 60_000,
    });
    expect(typeof result.greeting).toBe("string");
  }, 90_000);
});
