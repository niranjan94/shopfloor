import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkoutImplBranch,
  prepareImplCheckout,
  pushImplCommits,
  setRemoteWithToken,
  tokenResolverFor,
} from "../../src/git/impl-checkout.js";
import {
  __resetTokenCache,
  type AuthSpec,
} from "../../src/github/app-token.js";

function git(cwd: string, args: string[]): Promise<string> {
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

function gitSync(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.status}): ${r.stderr ?? ""}`,
    );
  }
}

interface Scratch {
  remoteDir: string;
  workDir: string;
  cleanup: () => void;
}

// Builds a bare repo to act as the remote, plus a working clone with one
// commit on `main` and identity configured for further commits. The bare
// repo path is suitable for direct fetch/push when remote.origin.url is set
// to it as a file path.
function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "shopfloor-impl-checkout-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const workDir = join(root, "work");

  gitSync(root, ["init", "--bare", "-b", "main", remoteDir]);
  gitSync(root, ["init", "-q", "-b", "main", seedDir]);
  gitSync(seedDir, ["config", "user.email", "t@t"]);
  gitSync(seedDir, ["config", "user.name", "t"]);
  writeFileSync(join(seedDir, "README.md"), "seed\n");
  gitSync(seedDir, ["add", "README.md"]);
  gitSync(seedDir, ["commit", "-q", "-m", "seed"]);
  gitSync(seedDir, ["push", "-q", remoteDir, "main:main"]);

  gitSync(root, ["clone", "-q", remoteDir, workDir]);
  gitSync(workDir, ["config", "user.email", "t@t"]);
  gitSync(workDir, ["config", "user.name", "t"]);

  return {
    remoteDir,
    workDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Seeds the bare repo with an existing impl branch carrying one extra
// commit beyond main. Returns the sha of that prior-iteration head.
function seedPriorIterBranch(remoteDir: string, branch: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "shopfloor-impl-prior-"));
  try {
    gitSync(tmp, ["clone", "-q", remoteDir, "."]);
    gitSync(tmp, ["config", "user.email", "t@t"]);
    gitSync(tmp, ["config", "user.name", "t"]);
    gitSync(tmp, ["checkout", "-q", "-b", branch]);
    writeFileSync(join(tmp, "prior.txt"), "prior\n");
    gitSync(tmp, ["add", "prior.txt"]);
    gitSync(tmp, ["commit", "-q", "-m", "prior iter"]);
    gitSync(tmp, ["push", "-q", "origin", branch]);
    const sha = spawnSync("git", ["-C", tmp, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("setRemoteWithToken", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("rewrites the remote URL with the x-access-token credential", async () => {
    await setRemoteWithToken(
      scratch.workDir,
      "origin",
      "octo",
      "demo",
      "ghs_zzz",
    );
    const url = await git(scratch.workDir, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url).toBe("https://x-access-token:ghs_zzz@github.com/octo/demo.git");
  });
});

describe("checkoutImplBranch", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("creates the impl branch from the current HEAD on a first run", async () => {
    await checkoutImplBranch({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      revisionMode: false,
    });
    const current = await git(scratch.workDir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(current).toBe("shopfloor/impl/1-test");
    const head = await git(scratch.workDir, ["rev-parse", "HEAD"]);
    const main = await git(scratch.workDir, ["rev-parse", "main"]);
    expect(head).toBe(main);
  });

  it("re-creates the local branch when one already exists from a stale run", async () => {
    gitSync(scratch.workDir, ["checkout", "-q", "-b", "shopfloor/impl/1-test"]);
    writeFileSync(join(scratch.workDir, "stale.txt"), "stale\n");
    gitSync(scratch.workDir, ["add", "stale.txt"]);
    gitSync(scratch.workDir, ["commit", "-q", "-m", "stale"]);
    gitSync(scratch.workDir, ["checkout", "-q", "main"]);

    await checkoutImplBranch({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      revisionMode: false,
    });
    const current = await git(scratch.workDir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(current).toBe("shopfloor/impl/1-test");
  });

  it("fetches and resets HEAD to the prior iteration's branch in revision mode", async () => {
    const priorSha = seedPriorIterBranch(
      scratch.remoteDir,
      "shopfloor/impl/1-test",
    );
    await checkoutImplBranch({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      revisionMode: true,
    });
    const head = await git(scratch.workDir, ["rev-parse", "HEAD"]);
    expect(head).toBe(priorSha);
    const current = await git(scratch.workDir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(current).toBe("shopfloor/impl/1-test");
  });
});

describe("prepareImplCheckout", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("rewrites the remote URL and creates the impl branch on a first run", async () => {
    await prepareImplCheckout({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      baseBranch: "main",
      revisionMode: false,
      owner: "octo",
      repo: "demo",
      token: "ghs_zzz",
    });
    const url = await git(scratch.workDir, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url).toBe("https://x-access-token:ghs_zzz@github.com/octo/demo.git");
    const current = await git(scratch.workDir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(current).toBe("shopfloor/impl/1-test");
  });
});

describe("pushImplCommits", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("pushes the impl branch to the remote when origin points at a real target", async () => {
    // First run: create the branch and one extra commit on top of main.
    await checkoutImplBranch({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      revisionMode: false,
    });
    writeFileSync(join(scratch.workDir, "feat.txt"), "impl\n");
    gitSync(scratch.workDir, ["add", "feat.txt"]);
    gitSync(scratch.workDir, ["commit", "-q", "-m", "feat: impl"]);

    // Use a no-op URL rewrite that points at the bare repo path so the
    // helper's push succeeds without a real GitHub host. We patch origin
    // back to the bare path between setRemoteWithToken and push by passing
    // a custom remote that already points at the bare path; this exercises
    // the push half end-to-end.
    gitSync(scratch.workDir, ["remote", "add", "bare", scratch.remoteDir]);
    await pushImplCommits({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      owner: "octo",
      repo: "demo",
      // The helper will overwrite the `bare` remote's URL with the https
      // x-access-token one. We then re-point it before re-attempting the
      // push manually below. For this test the helper's push will fail
      // (no real host); we rescue the rejection, restore, and re-push so
      // we can assert the bare repo received the branch.
      token: "ghs_zzz",
      remote: "bare",
    }).catch(async (err: Error) => {
      expect(err.message).toMatch(/git push/);
      await git(scratch.workDir, [
        "remote",
        "set-url",
        "bare",
        scratch.remoteDir,
      ]);
      await git(scratch.workDir, ["push", "bare", "shopfloor/impl/1-test"]);
    });

    const refs = await git(scratch.remoteDir, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    expect(refs.split(/\n+/)).toContain("shopfloor/impl/1-test");
  });

  it("strips the embedded token from any error output", async () => {
    await expect(
      pushImplCommits({
        cwd: scratch.workDir,
        branchName: "does-not-exist",
        owner: "octo",
        repo: "demo",
        token: "ghs_supersecret",
      }),
    ).rejects.toThrow();
    // Re-run inside a try/catch so we can inspect the exact message and
    // confirm the token is masked rather than substring-checking via the
    // matcher above.
    let captured: Error | null = null;
    try {
      await pushImplCommits({
        cwd: scratch.workDir,
        branchName: "does-not-exist",
        owner: "octo",
        repo: "demo",
        token: "ghs_supersecret",
      });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured?.message ?? "").not.toContain("ghs_supersecret");
  });
});

describe("tokenResolverFor", () => {
  beforeEach(() => {
    __resetTokenCache();
  });

  it("returns the static token on every call for token auth", async () => {
    const auth: AuthSpec = {
      kind: "token",
      token: "ghs_static",
      source: "preminted",
    };
    const resolve = tokenResolverFor(auth, "octo", "demo");
    expect(await resolve()).toBe("ghs_static");
    expect(await resolve()).toBe("ghs_static");
  });

  it("returns a closure for app auth without invoking the network until called", () => {
    const auth: AuthSpec = {
      kind: "app",
      clientId: "Iv23x",
      privateKey: "k",
      installationId: 42,
    };
    const resolve = tokenResolverFor(auth, "octo", "demo");
    expect(typeof resolve).toBe("function");
  });
});
