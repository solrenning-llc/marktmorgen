/**
 * The numbers a "By the numbers" block may show (lib/sales-page.ts, FactsBlock),
 * worked out from the store itself, never typed.
 *
 * Each is there only when it is true and worth saying: a course with no lesson
 * yet has no lessons fact, a product bought fewer than ten times — or on a
 * store whose look hides how many times things were bought — has no buyers
 * fact, a product with no review that counts has no rating (showsRating:
 * hidden reviews count, so hiding every review never takes a rating away). The page and the
 * studio's preview ask this same function, so the preview never promises a
 * number the page would not show.
 *
 * Browser-safe: it reads only what it is given.
 */
import type { FactKey } from "@/lib/sales-page";
import { blockWords } from "@/lib/buyer-words/blocks";

export type FactValue = { key: FactKey; value: string; label: string };
export type PageFacts = Partial<Record<FactKey, FactValue>>;

export type FactInputs = {
  language: unknown;
  locale: string;
  product: {
    course?: { lessons: number } | null;
    podcast?: { episodes: number } | null;
    call?: { kind: "weekly" | "live"; minutes: number } | null;
  };
  /** How many products a bundle holds now, or null for anything else. */
  bundleItems: number | null;
  /** How many times it was bought, already held to the store's own rule for saying so; null when not said. */
  sold: number | null;
  /** Its reviews: how many count toward the average, their stars, and how many are visible. */
  reviews: { count: number; stars: number; visible: number } | null;
};

export function pageFacts(input: FactInputs): PageFacts {
  const w = blockWords(input.language);
  const number = (n: number) => new Intl.NumberFormat(input.locale).format(n);
  const out: PageFacts = {};
  const lessons = input.product.course?.lessons ?? 0;
  if (lessons > 0) out.lessons = { key: "lessons", value: number(lessons), label: w.lessons(lessons) };
  const episodes = input.product.podcast?.episodes ?? 0;
  if (episodes > 0) out.episodes = { key: "episodes", value: number(episodes), label: w.episodes(episodes) };
  if (input.bundleItems !== null && input.bundleItems > 0) {
    out.products = { key: "products", value: number(input.bundleItems), label: w.products(input.bundleItems) };
  }
  // A dated session has its own length each; only one length for every booking is a fact.
  const call = input.product.call;
  if (call && call.kind === "weekly" && call.minutes > 0) out.length = { key: "length", value: number(call.minutes), label: w.minutes(call.minutes) };
  if (input.sold !== null && input.sold > 0) out.buyers = { key: "buyers", value: number(input.sold), label: w.bought(input.sold) };
  const reviews = input.reviews;
  if (reviews && reviews.count >= 1) {
    const average = Math.round((reviews.stars / reviews.count) * 10) / 10;
    const value = new Intl.NumberFormat(input.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(average);
    out.rating = { key: "rating", value, label: w.rating(reviews.count) };
  }
  return out;
}
