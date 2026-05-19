import { describe, expect, it } from "vitest";
import { resolveEnv } from "../../scripts/smoke/lib/env.js";

describe("env.ts", () => {
  it("returns all three values when all are set", () => {
    const env = resolveEnv({
      SHOPFLOOR_SMOKE_GH_TOKEN: "ghp_xxx",
      SHOPFLOOR_PRIMARY_APP_LOGIN: "shopfloor[bot]",
      SHOPFLOOR_REVIEW_APP_LOGIN: "shopfloor-reviewer[bot]",
    });
    expect(env).toEqual({
      token: "ghp_xxx",
      appLogins: {
        primary: "shopfloor[bot]",
        review: "shopfloor-reviewer[bot]",
      },
    });
  });

  it("throws when SHOPFLOOR_SMOKE_GH_TOKEN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_SMOKE_GH_TOKEN/);
  });

  it("throws when SHOPFLOOR_PRIMARY_APP_LOGIN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "ghp",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_PRIMARY_APP_LOGIN/);
  });

  it("throws when SHOPFLOOR_REVIEW_APP_LOGIN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "ghp",
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
      }),
    ).toThrow(/SHOPFLOOR_REVIEW_APP_LOGIN/);
  });

  it("treats empty strings as missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "",
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_SMOKE_GH_TOKEN/);
  });
});
