import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

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
        if (!p) return {};
        const fs = require("node:fs") as typeof import("node:fs");
        return JSON.parse(fs.readFileSync(p, "utf8"));
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

import { parseGithubOutput } from "./parse-output";

describe("parseGithubOutput", () => {
  test("parses single key/value", () => {
    const raw = "stage<<ghadelim_a\nplan\nghadelim_a\n";
    expect(parseGithubOutput(raw)).toEqual({ stage: "plan" });
  });
  test("parses multiple key/values", () => {
    const raw = "stage<<d1\nplan\nd1\n" + "issue_number<<d2\n42\nd2\n";
    expect(parseGithubOutput(raw)).toEqual({
      stage: "plan",
      issue_number: "42",
    });
  });
  test("parses multi-line value", () => {
    const raw = "rendered<<DELIM\nline 1\nline 2\nline 3\nDELIM\n";
    expect(parseGithubOutput(raw)).toEqual({
      rendered: "line 1\nline 2\nline 3",
    });
  });
  test("returns empty object for empty file", () => {
    expect(parseGithubOutput("")).toEqual({});
  });
});

import { snapshotEnv } from "./env";

describe("snapshotEnv", () => {
  beforeEach(() => {
    delete process.env.SHOPFLOOR_TEST_VAR;
  });
  afterEach(() => {
    delete process.env.SHOPFLOOR_TEST_VAR;
  });
  test("restores added variables to undefined", () => {
    const restore = snapshotEnv();
    process.env.SHOPFLOOR_TEST_VAR = "x";
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBeUndefined();
  });
  test("restores modified variables to original value", () => {
    process.env.SHOPFLOOR_TEST_VAR = "before";
    const restore = snapshotEnv();
    process.env.SHOPFLOOR_TEST_VAR = "after";
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBe("before");
  });
  test("restores deleted variables", () => {
    process.env.SHOPFLOOR_TEST_VAR = "before";
    const restore = snapshotEnv();
    delete process.env.SHOPFLOOR_TEST_VAR;
    restore();
    expect(process.env.SHOPFLOOR_TEST_VAR).toBe("before");
  });
});

import { resetCoreState } from "./env";

describe("resetCoreState", () => {
  test("clears process.exitCode", () => {
    process.exitCode = 1;
    resetCoreState();
    expect(process.exitCode).toBeUndefined();
  });
  test("throws if GITHUB_STATE is set as a tripwire", () => {
    process.env.GITHUB_STATE = "/tmp/x";
    try {
      expect(() => resetCoreState()).toThrow(/GITHUB_STATE/);
    } finally {
      delete process.env.GITHUB_STATE;
    }
  });
});

import { AgentStub } from "./agent-stub";

describe("AgentStub", () => {
  test("FIFO per non-review stage", () => {
    const stub = new AgentStub();
    stub.queue("triage", { decision_json: '{"a":1}' });
    stub.queue("triage", { decision_json: '{"a":2}' });
    expect(stub.consume("triage").decision_json).toBe('{"a":1}');
    expect(stub.consume("triage").decision_json).toBe('{"a":2}');
  });
  test("review bundle returns a per-role record", () => {
    const stub = new AgentStub();
    stub.queueReview({
      compliance: { output: "c" },
      bugs: { output: "b" },
      security: { output: "s" },
      smells: { output: "sm" },
    });
    const bundle = stub.consumeReview();
    expect(bundle.compliance).toEqual({ output: "c" });
    expect(bundle.bugs).toEqual({ output: "b" });
    expect(bundle.security).toEqual({ output: "s" });
    expect(bundle.smells).toEqual({ output: "sm" });
  });
  test("consume throws with a clear message when queue empty", () => {
    const stub = new AgentStub();
    expect(() => stub.consume("triage")).toThrow(
      /no queued agent response for stage 'triage'/,
    );
  });
  test("consumeReview throws naming missing roles", () => {
    const stub = new AgentStub();
    expect(() => stub.consumeReview()).toThrow(/no queued review bundle/);
  });
});

import { loadEvent } from "./fixtures";

describe("loadEvent", () => {
  test("loads issue-labeled-trigger and applies issueNumber override", () => {
    const ev = loadEvent("issue-labeled-trigger-label-added.json", {
      issueNumber: 99,
    });
    expect(ev.eventName).toBe("issues");
    expect((ev.payload as { issue: { number: number } }).issue.number).toBe(99);
  });
  test("attaches event name based on payload shape", () => {
    const ev = loadEvent("pr-review-approved.json");
    expect(ev.eventName).toBe("pull_request_review");
  });
});

import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "./scenario-harness";

describe("ScenarioHarness end-to-end smoke", () => {
  test("triage stage runs without throwing on a freshly seeded issue", async () => {
    const fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    const harness = new ScenarioHarness({ fake });
    try {
      await harness.bootstrap();
      fake.seedBranch("main", "sha-main-0");
      fake.seedIssue({
        number: 42,
        title: "Add foo",
        body: "Need foo",
        author: "alice",
        labels: ["shopfloor:enabled"],
      });
      await harness.deliverEvent(
        loadEvent("issue-labeled-trigger-label-added.json", {
          issueNumber: 42,
        }),
        { trigger_label: "shopfloor:enabled" },
      );
      harness.queueAgent("triage", {
        decision_json: JSON.stringify({
          status: "classified",
          complexity: "quick",
          rationale: "small",
          clarifying_questions: [],
        }),
      });
      await harness.runStage("triage");
      expect(fake.labelsOn(42)).toContain("shopfloor:quick");
      expect(fake.labelsOn(42)).toContain("shopfloor:needs-impl");
    } finally {
      await harness.dispose();
    }
  });
});
