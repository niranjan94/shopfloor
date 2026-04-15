import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import {
  __resetTokenCacheForTests,
  getAuthToken,
  signAppJwt,
  updateProgress,
} from "../index";

// One RSA key pair for the whole test module. ~50ms to generate; sharing it
// across tests keeps the suite fast while still exercising real signAppJwt.
const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function cleanTokenEnv(): void {
  delete process.env.GITHUB_TOKEN;
  delete process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID;
  delete process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY;
  delete process.env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID;
}

describe("updateProgress tool", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    cleanTokenEnv();
    __resetTokenCacheForTests();
    process.env.GITHUB_TOKEN = "test-token";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";
    process.env.SHOPFLOOR_COMMENT_ID = "777";
    process.env.GITHUB_API_URL = "https://api.github.com";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanTokenEnv();
    delete process.env.SHOPFLOOR_COMMENT_ID;
    __resetTokenCacheForTests();
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

describe("getAuthToken", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    cleanTokenEnv();
    __resetTokenCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanTokenEnv();
    __resetTokenCacheForTests();
  });

  test("falls back to GITHUB_TOKEN when no App credentials", async () => {
    process.env.GITHUB_TOKEN = "static-token";
    await expect(getAuthToken()).resolves.toBe("static-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws when neither App credentials nor GITHUB_TOKEN present", async () => {
    await expect(getAuthToken()).rejects.toThrow(/no GitHub credentials/);
  });

  test("mints an installation token via the App when credentials are present", async () => {
    process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID = "Iv23liTESTCLIENT";
    process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID = "555";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";
    process.env.GITHUB_API_URL = "https://api.github.com";

    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        token: "ghs_installationToken123",
        expires_at: futureExpiry,
      }),
    });

    const token = await getAuthToken();
    expect(token).toBe("ghs_installationToken123");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/app/installations/555/access_tokens",
    );
    expect(init).toMatchObject({ method: "POST" });
    const authHeader = (init.headers as Record<string, string>).Authorization;
    expect(authHeader).toMatch(/^Bearer eyJ/); // JWT prefix
  });

  test("caches the minted token for subsequent calls", async () => {
    process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID = "Iv23liTESTCLIENT";
    process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID = "555";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";

    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        token: "ghs_cachedToken",
        expires_at: futureExpiry,
      }),
    });

    const first = await getAuthToken();
    const second = await getAuthToken();
    const third = await getAuthToken();
    expect(first).toBe("ghs_cachedToken");
    expect(second).toBe("ghs_cachedToken");
    expect(third).toBe("ghs_cachedToken");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("refreshes the token when the cached one is within the refresh margin", async () => {
    process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID = "Iv23liTESTCLIENT";
    process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID = "555";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";

    // First mint returns a token that expires in 2 minutes — inside the
    // 5-minute refresh margin, so the next call must refresh.
    const soonExpiry = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const laterExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_soonExpires",
          expires_at: soonExpiry,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_refreshed",
          expires_at: laterExpiry,
        }),
      });

    expect(await getAuthToken()).toBe("ghs_soonExpires");
    expect(await getAuthToken()).toBe("ghs_refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("auto-discovers installation id when not provided", async () => {
    process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID = "Iv23liTESTCLIENT";
    process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";

    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 12345 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_discovered",
          expires_at: futureExpiry,
        }),
      });

    const token = await getAuthToken();
    expect(token).toBe("ghs_discovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/niranjan94/shopfloor/installation",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/app/installations/12345/access_tokens",
    );
  });

  test("updateProgress uses the minted installation token", async () => {
    process.env.SHOPFLOOR_GITHUB_APP_CLIENT_ID = "Iv23liTESTCLIENT";
    process.env.SHOPFLOOR_GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.SHOPFLOOR_GITHUB_APP_INSTALLATION_ID = "555";
    process.env.REPO_OWNER = "niranjan94";
    process.env.REPO_NAME = "shopfloor";
    process.env.SHOPFLOOR_COMMENT_ID = "777";
    process.env.GITHUB_API_URL = "https://api.github.com";

    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_mintedForUpdate",
          expires_at: futureExpiry,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

    await updateProgress({ body: "working" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const patchCall = fetchMock.mock.calls[1];
    expect(patchCall[0]).toBe(
      "https://api.github.com/repos/niranjan94/shopfloor/issues/comments/777",
    );
    expect((patchCall[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer ghs_mintedForUpdate",
    );

    delete process.env.SHOPFLOOR_COMMENT_ID;
  });
});

describe("signAppJwt", () => {
  test("produces a three-part JWT signed with RS256", () => {
    const jwt = signAppJwt("Iv23liClient", testPrivateKey);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString(),
    ) as Record<string, string>;
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString(),
    ) as Record<string, number | string>;
    expect(payload.iss).toBe("Iv23liClient");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(
      (payload.exp as number) - (payload.iat as number),
    ).toBeLessThanOrEqual(10 * 60);
  });
});
