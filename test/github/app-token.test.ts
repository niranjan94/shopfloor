import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  mintInstallationToken,
  __resetTokenCache,
} from "../../src/github/app-token.js";

describe("mintInstallationToken", () => {
  beforeEach(() => __resetTokenCache());

  it("returns a token from the mock auth function", async () => {
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_test",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const tok = await mintInstallationToken({
      clientId: "Iv23test",
      privateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----\n",
      owner: "octo",
      repo: "demo",
      authFactory: () => auth,
    });
    expect(tok).toBe("ghs_test");
    expect(auth).toHaveBeenCalledOnce();
  });

  it("caches the token for the configured margin", async () => {
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_test",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const args = {
      clientId: "Iv23test",
      privateKey: "k",
      owner: "octo",
      repo: "demo",
      authFactory: () => auth,
    };
    await mintInstallationToken(args);
    await mintInstallationToken(args);
    expect(auth).toHaveBeenCalledOnce();
  });

  it("refreshes when token is within the expiry margin", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 3600_000).toISOString();
    const auth = vi
      .fn()
      .mockResolvedValueOnce({ token: "first", expiresAt: soon })
      .mockResolvedValueOnce({ token: "second", expiresAt: later });
    const args = {
      clientId: "Iv23test",
      privateKey: "k",
      owner: "octo",
      repo: "demo",
      authFactory: () => auth,
      expiryMarginMs: 5 * 60_000,
    };
    expect(await mintInstallationToken(args)).toBe("first");
    expect(await mintInstallationToken(args)).toBe("second");
    expect(auth).toHaveBeenCalledTimes(2);
  });
});
