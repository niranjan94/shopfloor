import { vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// Global mock of @actions/github. Each scenario registers a FakeGitHub
// via ScenarioHarness; getOctokit reads from that registry. Tests that
// don't register a fake will hit the throw-on-unknown branch, surfacing
// any accidental access at the call site rather than letting it slip
// through with stub data.
vi.mock("@actions/github", async () => {
  const actual =
    await vi.importActual<typeof import("@actions/github")>("@actions/github");
  return {
    ...actual,
    getOctokit: vi.fn(),
    context: {
      get eventName() {
        return process.env.GITHUB_EVENT_NAME ?? "";
      },
      get payload() {
        const p = process.env.GITHUB_EVENT_PATH;
        return p ? JSON.parse(readFileSync(p, "utf8")) : {};
      },
      repo: {
        get owner() {
          return process.env.GITHUB_REPOSITORY?.split("/")[0] ?? "";
        },
        get repo() {
          return process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
        },
      },
    },
  };
});

// Tripwire: scenario files MUST NOT use test.concurrent. With shared
// process.env it would trample. Detect any leakage of INPUT_* env vars
// into test setup and throw loudly.
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_")) {
      throw new Error(
        `e2e setup: stale ${k} present at start of test. Did a previous test fail to dispose its harness, or are you running with test.concurrent (forbidden in e2e/scenarios)?`,
      );
    }
  }
});
