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

/** id: the number the model is handed; review: the review's own id, kept with the summary to check it on every read. */
export type SummaryInput = { id: number; text: string; review: string };
export type SummaryTheme = { title: string; reviews: number };

/** A review's words as they may be sent: one line, short, with addresses, handles, phone numbers and links taken out. */
export function cleanReviewText(value: string): string {
  const one = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    // An address written out to dodge a filter ("jane at gmail dot com").
    .replace(/\b[\p{L}\p{N}._-]+\s+(?:at|\(at\)|\[at\])\s+[\p{L}\p{N}-]+\s+(?:dot|\(dot\)|\[dot\])\s+[a-z]{2,}\b/giu, "[email]")
    .replace(/(?<![\p{L}\p{N}])@[A-Za-z0-9_.]{2,}/gu, "[handle]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    // A web address without http or www ("more at janesmith.dev/shop") is a link too.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?\b/gi, "[link]")
    // A phone number in any digits (Arabic-Indic, fullwidth), seven digits or more.
    .replace(/\+?\p{Nd}(?:[\p{Nd}\s().-]*\p{Nd}){6,}/gu, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  // Cut at whole characters, never inside an emoji.
  return Array.from(one).slice(0, MAX_TEXT).join("");
}

/** Words a theme's name may use without the reviews saying them: the small words of English. */
const SMALL_WORDS = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "at", "by", "from", "is", "are", "be", "it", "its", "as", "or", "but", "not", "no", "very", "too", "so", "that", "this", "these", "those", "their", "they", "you", "your", "easy", "hard", "good", "great", "well"]);
/** Numbers written in words and star ratings: a theme's name never says one. */
const RATING_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|stars?|rated|rating|out of)\b/i;
/** A theme's name as the page may show it: plain Latin letters, digits never, simple punctuation. */
const TITLE_SHAPE = /^[A-Za-z][A-Za-z ,'’&/-]*$/;
/** A word reduced to its first five letters, so "lessons" and "lesson", "clearly" and "clear" meet. */
const stem = (word: string) => word.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);

/**
 * Whether a theme's name is held to the reviews it names: every word of it
 * other than English's small words is found in at least one of those reviews.
 */
function heldToReviews(title: string, texts: readonly string[]): boolean {
  const said = new Set(texts.join(" ").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem));
  return title.split(/[^A-Za-z]+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase())).every((w) => said.has(stem(w)));
}

/** The words sent for one product, newest first, numbered from 1: shown on its page, not refunded, with words; never chosen by stars. */
export function summaryInputs(reviews: readonly Review[], productId: string): SummaryInput[] {
  return reviews
    .filter((r) => r.productId === productId && !r.hidden && !r.refunded && r.text.trim())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SUMMARY_REVIEWS)
    .map((r) => ({ review: r.id, text: cleanReviewText(r.text) }))
    .filter(({ text }) => text.replace(/\[(email|link|number)\]/g, "").trim().length >= 2)
    .map(({ review, text }, i) => ({ id: i + 1, text, review }));
}

/**
 * Whether every review's words a summary was made from are still shown, as
 * they were sent: a review deleted, hidden, refunded or rewritten since is
 * not, so the summary would count it and is not kept; a review written
 * since is only not counted yet, and does not undo the summary.
 */
export function inputsStillShown(inputs: readonly Pick<SummaryInput, "text">[], reviews: readonly Review[], productId: string): boolean {
  const shown = new Map<string, number>();
  for (const r of reviews) {
    if (r.productId !== productId || r.hidden || r.refunded || !r.text.trim()) continue;
    const text = cleanReviewText(r.text);
    shown.set(text, (shown.get(text) ?? 0) + 1);
  }
  for (const input of inputs) {
    const left = shown.get(input.text) ?? 0;
    if (left < 1) return false;
    shown.set(input.text, left - 1);
  }
  return true;
}

/** Whether a summary may be made now: enough reviews, and none made in the last week. */
export function maySummarise(inputs: readonly unknown[], lastAt: number, nowSeconds: number): boolean {
  return inputs.length >= MIN_SUMMARY_REVIEWS && (lastAt <= 0 || nowSeconds - lastAt >= SUMMARY_REFRESH_SECONDS);
}

/**
 * The themes kept from the model's answer `{ themes: [{ title, reviews: [n…] }] }`:
 * each name short, in plain English words the reviews it names use, with no
 * figure, rating, address or handle, each said by two different reviews
 * sent or more, the most said first, at most MAX_SUMMARY_THEMES, a name once.
 */
export function readThemes(answer: unknown, inputs: readonly Pick<SummaryInput, "id" | "text">[]): SummaryTheme[] {
  const ids = new Set(inputs.map((i) => i.id));
  const raw = answer && typeof answer === "object" && Array.isArray((answer as { themes?: unknown }).themes) ? ((answer as { themes: unknown[] }).themes) : [];
  const out: SummaryTheme[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { title?: unknown; reviews?: unknown };
    const title = typeof value.title === "string" ? value.title.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : "";
    // Plain English words only, nothing a review did not say, no figure, no rating, no address or handle.
    if (!title || title.length > MAX_THEME_TITLE || !TITLE_SHAPE.test(title) || RATING_WORDS.test(title) || !heldToFacts(title, "") || cleanReviewText(title) !== title) continue;
    if (out.some((t) => t.title.toLowerCase() === title.toLowerCase())) continue;
    const said = new Set((Array.isArray(value.reviews) ? value.reviews : []).filter((n): n is number => typeof n === "number" && ids.has(n)));
    if (said.size < 2 || !heldToReviews(title, inputs.filter((i) => said.has(i.id)).map((i) => i.text))) continue;
    out.push({ title, reviews: said.size });
  }
  return out.sort((a, b) => b.reviews - a.reviews).slice(0, MAX_SUMMARY_THEMES);
}

/** The summary as a page says it, under a label the page draws: each theme with how many of the reviews read say it. */
export function summaryLine(themes: readonly SummaryTheme[], read: number): string {
  if (!themes.length) return "";
  return `Reviewers often mention: ${themes.map((t) => `${t.title.charAt(0).toLowerCase()}${t.title.slice(1)} (${t.reviews} of ${read})`).join("; ")}.`;
}
