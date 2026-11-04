/**
 * The AI summary of a product's reviews, 636 [GL4](d), unit 1: the rules,
 * pure; no model is asked and nothing is drawn yet (the product page is
 * reserved by other open work, so drawing it is a later unit).
 *
 * What the model may do is sort, never write what buyers said: it is handed
 * the reviews' words by number and returns a few short theme names, each
 * with the numbers of the reviews that say it. The counts are worked out
 * here from those numbers, and a theme is kept only when two different
 * reviews or more say it. A theme name with a number, a link, or a word of a
 * deal or of pressure is refused (heldToFacts, with no facts: none may pass).
 *
 * Every rating counts the same, one star as five (16 CFR Part 465): reviews
 * are never chosen by their stars. Only words a page already shows are read:
 * not a hidden review, nor one whose order was refunded. Made at most once a
 * week for a product, and only from enough reviews to sort.
 */
import { heldToFacts } from "@/lib/store-assistant-rules";
import type { Review } from "@/lib/review-summary";

export const MIN_SUMMARY_REVIEWS = 5;
/** The newest reviews sent, so one summary stays a small job. */
export const MAX_SUMMARY_REVIEWS = 60;
export const MAX_SUMMARY_THEMES = 4;
export const MAX_THEME_TITLE = 40;
const MAX_TEXT = 300;
export const SUMMARY_REFRESH_SECONDS = 7 * 86_400;

export type SummaryInput = { id: number; text: string };
export type SummaryTheme = { title: string; reviews: number };

/** A review's words as they may be sent: one line, short, with addresses, phone numbers and links taken out. */
export function cleanReviewText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

/** The words sent for one product, newest first, numbered from 1: shown on its page, not refunded, with words; never chosen by stars. */
export function summaryInputs(reviews: readonly Review[], productId: string): SummaryInput[] {
  return reviews
    .filter((r) => r.productId === productId && !r.hidden && !r.refunded && r.text.trim())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SUMMARY_REVIEWS)
    .map((r) => cleanReviewText(r.text))
    .filter((text) => text.replace(/\[(email|link|number)\]/g, "").trim().length >= 2)
    .map((text, i) => ({ id: i + 1, text }));
}

/** Whether a summary may be made now: enough reviews, and none made in the last week. */
export function maySummarise(inputs: readonly SummaryInput[], lastAt: number, nowSeconds: number): boolean {
  return inputs.length >= MIN_SUMMARY_REVIEWS && (lastAt <= 0 || nowSeconds - lastAt >= SUMMARY_REFRESH_SECONDS);
}

/**
 * The themes kept from the model's answer `{ themes: [{ title, reviews: [n…] }] }`:
 * each name short and held to no facts, each said by two different reviews
 * sent or more, the most said first, at most MAX_SUMMARY_THEMES, a name once.
 */
export function readThemes(answer: unknown, inputs: readonly SummaryInput[]): SummaryTheme[] {
  const ids = new Set(inputs.map((i) => i.id));
  const raw = answer && typeof answer === "object" && Array.isArray((answer as { themes?: unknown }).themes) ? ((answer as { themes: unknown[] }).themes) : [];
  const out: SummaryTheme[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { title?: unknown; reviews?: unknown };
    const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > MAX_THEME_TITLE || !heldToFacts(title, "")) continue;
    if (out.some((t) => t.title.toLowerCase() === title.toLowerCase())) continue;
    const said = new Set((Array.isArray(value.reviews) ? value.reviews : []).filter((n): n is number => typeof n === "number" && ids.has(n)));
    if (said.size >= 2) out.push({ title, reviews: said.size });
  }
  return out.sort((a, b) => b.reviews - a.reviews).slice(0, MAX_SUMMARY_THEMES);
}

/** The summary as a page says it, under a label the page draws: each theme with how many of the reviews read say it. */
export function summaryLine(themes: readonly SummaryTheme[], read: number): string {
  if (!themes.length) return "";
  return `Reviewers often mention: ${themes.map((t) => `${t.title.charAt(0).toLowerCase()}${t.title.slice(1)} (${t.reviews} of ${read})`).join("; ")}.`;
}
