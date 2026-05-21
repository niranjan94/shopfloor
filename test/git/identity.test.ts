import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGitIdentity,
  resolveBotIdentity,
} from "../../src/git/identity.js";
import type { AuthSpec } from "../../src/github/app-token.js";

async function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")}: ${stderr.trim()}`));
    });
  });
}

describe("resolveBotIdentity", () => {
  it("returns the github-actions[bot] identity for github_token auth", async () => {
    const auth: AuthSpec = {
      kind: "token",
      token: "ghs_x",
      source: "github_token",
    };
    const id = await resolveBotIdentity(auth);
    expect(id).toEqual({
      name: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
    });
  });

  it("returns a generic identity for preminted token auth", async () => {
    const auth: AuthSpec = {
      kind: "token",
      token: "ghs_x",
      source: "preminted",
    };
    const id = await resolveBotIdentity(auth);
    expect(id.name).toBe("shopfloor[bot]");
    expect(id.email).toContain("@users.noreply.github.com");
  });

  it("composes the App's bot identity from slug + user id", async () => {
    const auth: AuthSpec = {
      kind: "app",
      clientId: "Iv23test",
      privateKey: "k",
      installationId: 1,
    };
    const appAuth = vi.fn().mockResolvedValue({ token: "jwt-x" });
    const id = await resolveBotIdentity(auth, {
      appAuthFactory: () => appAuth as never,
      fetchAppSlug: vi.fn().mockResolvedValue("shopfloor-bot"),
      fetchBotUserId: vi.fn().mockResolvedValue(99887766),
    });
    expect(id).toEqual({
      name: "shopfloor-bot[bot]",
      email: "99887766+shopfloor-bot[bot]@users.noreply.github.com",
    });
    expect(appAuth).toHaveBeenCalledWith({ type: "app" });
  });

  it("falls back to a generic identity when slug discovery throws", async () => {
    const auth: AuthSpec = {
      kind: "app",
      clientId: "Iv23test",
      privateKey: "k",
      installationId: 1,
    };
    const id = await resolveBotIdentity(auth, {
      appAuthFactory: () => (async () => ({ token: "jwt-x" })) as never,
      fetchAppSlug: vi.fn().mockRejectedValue(new Error("404")),
      fetchBotUserId: vi.fn(),
    });
    expect(id.name).toBe("shopfloor[bot]");
  });
});

describe("applyGitIdentity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "shopfloor-identity-test-"));
    await runGit(dir, ["init", "-q"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes user.name and user.email to repo-local config", async () => {
    await applyGitIdentity({
      cwd: dir,
      identity: {
        name: "shopfloor[bot]",
        email: "1+shopfloor[bot]@users.noreply.github.com",
      },
    });
    expect(await runGit(dir, ["config", "--get", "user.name"])).toBe(
      "shopfloor[bot]",
    );
    expect(await runGit(dir, ["config", "--get", "user.email"])).toBe(
      "1+shopfloor[bot]@users.noreply.github.com",
    );
  });

  it("does not write --global config", async () => {
    await applyGitIdentity({
      cwd: dir,
      identity: { name: "x", email: "y@z" },
    });
    // The repo-local config file should contain the keys; the local file
    // path is .git/config relative to dir.
    const localConfig = readFileSync(join(dir, ".git", "config"), "utf8");
    expect(localConfig).toContain("[user]");
    expect(localConfig).toMatch(/name = x/);
    expect(localConfig).toMatch(/email = y@z/);
  });

  it("writes the ssh signing key and config when provided", async () => {
    await applyGitIdentity({
      cwd: dir,
      identity: { name: "x", email: "y@z" },
      sshSigningKey:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n-----END OPENSSH PRIVATE KEY-----",
    });
    const keyPath = await runGit(dir, ["config", "--get", "user.signingkey"]);
    expect(keyPath).toMatch(/shopfloor-ssh-[^/]+\/signing_key$/);
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await runGit(dir, ["config", "--get", "gpg.format"])).toBe("ssh");
    expect(await runGit(dir, ["config", "--get", "commit.gpgsign"])).toBe(
      "true",
    );
    expect(await runGit(dir, ["config", "--get", "tag.gpgsign"])).toBe("true");
  });

  it("does not touch signing config when ssh key is empty", async () => {
    await applyGitIdentity({
      cwd: dir,
      identity: { name: "x", email: "y@z" },
      sshSigningKey: "   ",
    });
    // Inspect repo-local config only; the host's global config may have
    // signingkey set, and `git config --get` would merge it in otherwise.
    await expect(
      runGit(dir, ["config", "--local", "--get", "user.signingkey"]),
    ).rejects.toBeTruthy();
    await expect(
      runGit(dir, ["config", "--local", "--get", "gpg.format"]),
    ).rejects.toBeTruthy();
  });
});
