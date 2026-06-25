import { describe, expect, it, vi } from "vitest";
import {
  formatInstallerError,
  retryWithBackoff,
} from "../../src/setup/installer-support.js";

describe("retryWithBackoff", () => {
  it("returns the result on the first successful attempt without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => "ok");

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      baseDelayMs: 10,
      sleep,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries after a transient failure and returns the eventual success", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "recovered";
    });

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      baseDelayMs: 10,
      sleep,
    });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses linear backoff between attempts", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });

    await expect(
      retryWithBackoff(fn, { attempts: 3, baseDelayMs: 100, sleep }),
    ).rejects.toThrow("always fails");

    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("throws the last error after exhausting all attempts", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    });

    await expect(
      retryWithBackoff(fn, { attempts: 3, baseDelayMs: 1, sleep }),
    ).rejects.toThrow("fail 3");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("invokes onRetry with the attempt number and error before sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error("boom");
      return "done";
    });

    await retryWithBackoff(fn, {
      attempts: 3,
      baseDelayMs: 5,
      sleep,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

describe("formatInstallerError", () => {
  it("prefixes the supplied installer label and includes the exit code", () => {
    const msg = formatInstallerError("Codex CLI installer", 1, "");
    expect(msg).toContain("Codex CLI installer exited with code 1");
  });

  it("appends the tail of installer output", () => {
    const msg = formatInstallerError(
      "Claude CLI installer",
      1,
      "Installing Claude Code native build 2.1.141...\n✘ Installation failed\ngetaddrinfo ESERVFAIL downloads.claude.ai\n",
    );

    expect(msg).toContain("Claude CLI installer exited with code 1");
    expect(msg).toContain("getaddrinfo ESERVFAIL downloads.claude.ai");
  });

  it("reports the exit code cleanly when there is no output", () => {
    const msg = formatInstallerError("Codex CLI installer", 127, "   \n  ");

    expect(msg).toContain("exited with code 127");
    expect(msg).not.toContain("undefined");
  });
});
