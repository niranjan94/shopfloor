import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { parseGithubOutput } from "./parse-output";

describe("parseGithubOutput", () => {
  test("parses single key/value", () => {
    const raw = "stage<<ghadelim_a\nplan\nghadelim_a\n";
    expect(parseGithubOutput(raw)).toEqual({ stage: "plan" });
  });
  test("parses multiple key/values", () => {
    const raw =
      "stage<<d1\nplan\nd1\n" +
      "issue_number<<d2\n42\nd2\n";
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
    const ev = loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 99 });
    expect(ev.eventName).toBe("issues");
    expect((ev.payload as { issue: { number: number } }).issue.number).toBe(99);
  });
  test("attaches event name based on payload shape", () => {
    const ev = loadEvent("pr-review-approved.json");
    expect(ev.eventName).toBe("pull_request_review");
  });
});
