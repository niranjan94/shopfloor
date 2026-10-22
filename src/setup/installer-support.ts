import { spawn } from "node:child_process";

// Shared helpers for the native-CLI installers (Claude and Codex). Both pull a
// binary over the network on a CI runner, so both need transient-failure retry
// and diagnostics that surface the real cause instead of a bare exit code.

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: Error) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < opts.attempts) {
        opts.onRetry?.(attempt, lastError);
        await sleep(opts.baseDelayMs * attempt);
      }
    }
  }
  throw lastError ?? new Error("retryWithBackoff: no attempts were made");
}

// Installers stream their own progress, but a thrown Error that carries only
// the exit code surfaces as the opaque "exited with code 1". Append the tail of
// the captured output (e.g. "getaddrinfo ESERVFAIL downloads.claude.ai") so the
// real cause is visible wherever the error is reported, including the review
// lens failure summary.
export function formatInstallerError(
  label: string,
  code: number | null,
  output: string,
): string {
  const base = `${label} exited with code ${code}`;
  const tail = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join(" | ");
  return tail ? `${base}: ${tail}` : base;
}

// Spawn a command, capturing stdout/stderr for diagnostics while still
// streaming it to the action log, and reject with a formatted error (carrying
// the captured tail) on a non-zero exit.
export function runCapturing(
  command: string,
  args: string[],
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(formatInstallerError(label, code, output)));
    });
  });
}
