import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { updateProgress } from "../index";

describe("updateProgress tool", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.GITHUB_TOKEN = "test-token";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";
    process.env.SHOPFLOOR_COMMENT_ID = "777";
    process.env.GITHUB_API_URL = "https://api.github.com";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    delete process.env.SHOPFLOOR_COMMENT_ID;
  });

  test("patches the correct comment endpoint with the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    await updateProgress({ body: "# Todo\n- [x] step 1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/niranjan94/shopfloor/issues/comments/777",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
        body: JSON.stringify({ body: "# Todo\n- [x] step 1" }),
      }),
    );
  });

  test("throws when SHOPFLOOR_COMMENT_ID is missing", async () => {
    delete process.env.SHOPFLOOR_COMMENT_ID;
    await expect(updateProgress({ body: "x" })).rejects.toThrow(
      /SHOPFLOOR_COMMENT_ID/,
    );
  });

  test("throws when GitHub API returns non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    });
    await expect(updateProgress({ body: "x" })).rejects.toThrow(/403/);
  });
});
