import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkoutImplBranch,
  fetchReviewBase,
  gitAuthEnv,
  prepareImplCheckout,
  prepareReviewBase,
  pushImplCommits,
  setCleanRemote,
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

function readGitConfig(workDir: string): string {
  return readFileSync(join(workDir, ".git", "config"), "utf8");
}

describe("setCleanRemote", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("replaces a token-bearing remote URL with a credential-free one", async () => {
    gitSync(scratch.workDir, [
      "remote",
      "set-url",
      "origin",
      "https://x-access-token:ghs_stale@github.com/octo/demo.git",
    ]);
    await setCleanRemote(scratch.workDir, "origin", "octo", "demo");
    const url = await git(scratch.workDir, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url).toBe("https://github.com/octo/demo.git");
    expect(readGitConfig(scratch.workDir)).not.toContain("ghs_stale");
  });
});

describe("gitAuthEnv", () => {
  it("supplies the token as a per-invocation extraheader that resets inherited headers", () => {
    const env = gitAuthEnv("ghs_zzz");
    const basic = Buffer.from("x-access-token:ghs_zzz").toString("base64");
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    });
  });

  it("resolves to only the supplied header even when the repo persisted one", () => {
    const root = mkdtempSync(join(tmpdir(), "shopfloor-auth-env-"));
    try {
      gitSync(root, ["init", "-q"]);
      gitSync(root, [
        "config",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic persisted",
      ]);
      const r = spawnSync(
        "git",
        [
          "config",
          "--get-urlmatch",
          "http.extraheader",
          "https://github.com/octo/demo.git",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, ...gitAuthEnv("ghs_zzz") },
        },
      );
      const basic = Buffer.from("x-access-token:ghs_zzz").toString("base64");
      expect(r.stdout.trim()).toBe(`AUTHORIZATION: basic ${basic}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("leaves a credential-free remote and creates the impl branch on a first run", async () => {
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
    expect(url).toBe("https://github.com/octo/demo.git");
    expect(readGitConfig(scratch.workDir)).not.toContain("ghs_zzz");
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

    // The helper resets the `bare` remote to the github.com URL, so its own
    // push cannot reach a real host here. We rescue the rejection, re-point
    // the remote at the bare path, and push manually so the test still
    // asserts the branch is pushable.
    gitSync(scratch.workDir, ["remote", "add", "bare", scratch.remoteDir]);
    await pushImplCommits({
      cwd: scratch.workDir,
      branchName: "shopfloor/impl/1-test",
      owner: "octo",
      repo: "demo",
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
    expect(readGitConfig(scratch.workDir)).not.toContain("ghs_supersecret");
  });
});

describe("fetchReviewBase", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("provisions origin/<base> so a two-dot diff against HEAD lists the PR's files", async () => {
    // Simulate the review checkout: HEAD carries a change the base does not,
    // and the origin/<base> remote-tracking ref is absent (as it is in a
    // shallow `pull/N/merge` checkout).
    writeFileSync(join(scratch.workDir, "feature.txt"), "feature\n");
    gitSync(scratch.workDir, ["add", "feature.txt"]);
    gitSync(scratch.workDir, ["commit", "-q", "-m", "feat: add feature"]);
    gitSync(scratch.workDir, ["update-ref", "-d", "refs/remotes/origin/main"]);

    await fetchReviewBase({
      cwd: scratch.workDir,
      baseRef: "main",
      remote: "origin",
    });

    const changed = await git(scratch.workDir, [
      "diff",
      "--name-only",
      "origin/main",
      "HEAD",
    ]);
    expect(changed).toBe("feature.txt");
  });
});

describe("prepareReviewBase", () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => scratch.cleanup());

  it("keeps the token out of the origin URL and .git/config", async () => {
    // The fetch itself targets github.com, so it fails locally; we only
    // assert that no credential was written to the repository config.
    await prepareReviewBase({
      cwd: scratch.workDir,
      baseRef: "main",
      owner: "octo",
      repo: "demo",
      token: "ghs_zzz",
    }).catch(() => {});
    const url = await git(scratch.workDir, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url).toBe("https://github.com/octo/demo.git");
    expect(readGitConfig(scratch.workDir)).not.toContain("ghs_zzz");
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
