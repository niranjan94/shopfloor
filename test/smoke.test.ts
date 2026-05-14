import { describe, expect, it } from "vitest";
import { SHOPFLOOR_V2_VERSION } from "../src/index.js";

describe("smoke", () => {
  it("exports a version", () => {
    expect(SHOPFLOOR_V2_VERSION).toMatch(/^2\./);
  });
});
