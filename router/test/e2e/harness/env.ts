/**
 * Snapshots process.env at call time and returns a restore function that
 * reverts adds, modifies, and deletes. Used by the harness to make every
 * helper invocation env-clean: INPUT_*, GITHUB_*, RUNNER_TEMP all evaporate
 * when the helper finishes regardless of which path through main() ran.
 */
export function snapshotEnv(): () => void {
  const before = new Map<string, string | undefined>();
  for (const k of Object.keys(process.env)) before.set(k, process.env[k]);
  return () => {
    // 1. Remove anything new
    for (const k of Object.keys(process.env)) {
      if (!before.has(k)) delete process.env[k];
    }
    // 2. Restore everything that existed before
    for (const [k, v] of before.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Resets all @actions/core internal state that can leak between
 * back-to-back helper invocations in the same process. Validated
 * empirically against @actions/core's source (router/node_modules/
 * @actions/core/lib/core.js):
 *
 * 1. process.exitCode -- setFailed sets this. If a previous helper called
 *    setFailed and the next helper does not, the test would still see a
 *    non-zero exit code.
 * 2. GITHUB_OUTPUT file -- `core.setOutput` appends to whatever path is in
 *    GITHUB_OUTPUT. The harness creates a fresh file per invocation, so
 *    there is nothing to reset here, but we assert the file exists and is
 *    truncated, as a tripwire.
 * 3. GITHUB_STATE / GITHUB_ENV -- `saveState` / `exportVariable` write
 *    here. No router helper currently uses them, so we throw if they are
 *    set at invocation time, as a tripwire for future helpers.
 */
export function resetCoreState(): void {
  process.exitCode = undefined;
  if (process.env.GITHUB_STATE !== undefined) {
    throw new Error(
      "resetCoreState: GITHUB_STATE is unexpectedly set. Update env.ts to handle the new helper that uses core.saveState.",
    );
  }
  if (process.env.GITHUB_ENV !== undefined) {
    throw new Error(
      "resetCoreState: GITHUB_ENV is unexpectedly set. Update env.ts to handle the new helper that uses core.exportVariable.",
    );
  }
}
