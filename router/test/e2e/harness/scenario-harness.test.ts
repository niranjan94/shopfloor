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
