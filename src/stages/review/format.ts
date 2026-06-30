import type { Category, LensName } from "./decision.js";

// HTML comment kept as the first line of every review body. check-review-skip
// matches on this prefix to recognize Shopfloor's own reviews, so it must stay
// first and unchanged.
export const SHOPFLOOR_REVIEW_MARKER = "<!-- shopfloor-review -->";

// Human-facing label for each review category, used in the summary table and
// the inline-comment header.
export const CATEGORY_LABEL: Record<Category, string> = {
  compliance: "Compliance",
  bug: "Bug",
  security: "Security",
  smell: "Code smell",
};

export const CATEGORY_EMOJI: Record<Category, string> = {
  compliance: "📋",
  bug: "🐛",
  security: "🔒",
  smell: "🧹",
};

// Human-facing label for each lens (the lens name and its category label differ
// for smells -> "code smells").
export const LENS_LABEL: Record<LensName, string> = {
  compliance: "compliance",
  bugs: "bugs",
  security: "security",
  smells: "code smells",
};

// Map a numeric confidence (0-100) to a plain word so readers don't have to
// interpret the raw score.
export function confidenceWord(confidence: number): string {
  if (confidence >= 90) return "very high";
  if (confidence >= 75) return "high";
  if (confidence >= 50) return "medium";
  return "low";
}

// Header line prepended to every inline review comment, e.g.
// "🐛 **Bug** · high confidence (85/100)".
export function inlineCommentHeader(
  category: Category,
  confidence: number,
): string {
  return `${CATEGORY_EMOJI[category]} **${CATEGORY_LABEL[category]}** · ${confidenceWord(
    confidence,
  )} confidence (${confidence}/100)`;
}
