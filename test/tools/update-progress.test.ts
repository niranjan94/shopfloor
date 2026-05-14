import { describe, expect, it, vi } from "vitest";
import { updateProgressTool } from "../../src/tools/update-progress.js";

describe("updateProgressTool", () => {
  it("PATCHes the configured comment with the supplied body", async () => {
    const github = {
      updateIssueComment: vi.fn().mockResolvedValue(undefined),
    };
    const tool = updateProgressTool({
      github,
      commentId: 12345,
      issueNumber: 7,
    });
    const result = await tool.handler({
      body: "## Progress\n- [x] step one\n- [ ] step two\n",
    });
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      12345,
      "## Progress\n- [x] step one\n- [ ] step two\n",
    );
    expect(result.isError).not.toBe(true);
  });

  it("returns isError true when the API call fails", async () => {
    const github = {
      updateIssueComment: vi.fn().mockRejectedValue(new Error("403")),
    };
    const tool = updateProgressTool({ github, commentId: 1, issueNumber: 2 });
    const result = await tool.handler({ body: "x" });
    expect(result.isError).toBe(true);
  });
});
