import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/stages/_shared/prompts.js";

describe("renderTemplate", () => {
  it("substitutes {{ name }} placeholders from the context map", () => {
    const out = renderTemplate("Hello {{ who }}, you are #{{ num }}", {
      who: "world",
      num: 7,
    });
    expect(out).toBe("Hello world, you are #7");
  });

  it("throws when a referenced key is missing", () => {
    expect(() => renderTemplate("Hi {{ missing }}", {})).toThrow(/missing/);
  });

  it("preserves multiline strings verbatim", () => {
    const out = renderTemplate("Issue body:\n{{ body }}", {
      body: "line1\nline2",
    });
    expect(out).toContain("line1\nline2");
  });

  it("serializes non-string values via JSON.stringify", () => {
    const out = renderTemplate("Labels: {{ labels }}", {
      labels: ["a", "b"],
    });
    expect(out).toBe('Labels: ["a","b"]');
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderTemplate("plain text", { extra: "ignored" })).toBe(
      "plain text",
    );
  });
});
