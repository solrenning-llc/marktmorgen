/**
 * A course's "Next step" (560 [AS1], points 1 and 2; unit 2, the rules only,
 * pure and browser-safe; added 10 November 2026). In the studio the creator
 * may pick, for each course, one product of their own store as the course's
 * next step, with a short line of their own. A student sees a "Next step"
 * card on the course's page and when they mark its last lesson done, with
 * the product's title, its published price, the creator's line and a button
 * to the product's page. The field in the studio, the card on the course and
 * its counts in the studio are the next units.
 *
 *   - The creator's choice, never anyone else's: without one, nothing is
 *     shown, and no AI picks for them in this item.
 *   - Only a product of the store, never the course itself.
 *   - No pressure (point 2): the card shows the product, its published price
 *     and the creator's line, and nothing else. The line is refused, with the
 *     reason, when it holds a deal or a word that rushes the buyer (the
 *     Store assistant's own lists, lib/store-assistant-rules.ts DEAL_WORDS
 *     and lib/assistant-reminder-rules.ts PRESSURE, so the store never says
 *     in one place what it refuses in another), a number (a count of buyers,
 *     a countdown, a figure), a quotation (a testimonial), a link or an
 *     exclamation. Refused, never cut or rewritten: the words are the
 *     creator's own.
 *   - Never offered to a student who already has the product, read from the
 *     creator's Stripe account and the purchases brought over; when that
 *     could not be read, it is not shown (unknown is never "does not have
 *     it"). Never when the product is a draft, sold out, no longer on sale or
 *     gone, nor once the student said "No thanks", which is kept; a "No
 *     thanks" that could not be read is taken as said.
 *
 * Costs nothing by itself: no read, no write, no call. What reads the
 * product, the student's purchases and the "No thanks" is the next unit, and
 * takes its own units before it reads.
 */
import { DEAL_WORDS } from "@/lib/store-assistant-rules";
import { PRESSURE } from "@/lib/assistant-reminder-rules";

/** The most characters the creator's line may have: one short sentence or two. */
export const MAX_NEXT_STEP_LINE = 160;

/** What the creator picked for one course: a product of the store, and their line (which may be empty). */
export type NextStep = { productId: string; line: string };

export type NextStepProblem = "product" | "self" | "long" | "link" | "deal" | "pressure" | "number" | "quote" | "exclaim";

/** What the studio says for each problem, in plain words. */
export const NEXT_STEP_PROBLEMS: Record<NextStepProblem, string> = {
  product: "Pick a product from your store.",
  self: "Pick another product. A course cannot be its own next step.",
  long: `Keep the line to ${MAX_NEXT_STEP_LINE} characters or fewer.`,
  link: "Leave out links and addresses. The button already opens the product's page.",
  deal: "Leave out discounts, codes and deals. The card shows the price your store shows.",
  pressure: "Leave out words that rush the student, like \"now\", \"today\", \"last\" or \"limited\".",
  number: "Leave out numbers. The card shows the price itself, and never counts of people or time left.",
  quote: "Leave out quotes. Reviews belong on the product's page, where buyers can check them.",
  exclaim: "Leave out exclamation marks. Say it calmly, in your own words.",
};

/** The line as kept: one line of plain words, spaces joined, nothing that draws nothing. */
function plain(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The creator's choice for one course, as the studio would save it: the
 * product must be one of `products` (the store's own ids) and not the course's
 * own product; the line, cleaned, must hold none of the problems above. An
 * empty product id is no next step at all (null), which is how the creator
 * takes one away.
 */
export function readNextStep(
  raw: unknown,
  context: { courseProductId: string; products: ReadonlySet<string> },
): { ok: true; step: NextStep | null } | { ok: false; why: NextStepProblem } {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const productId = typeof value.productId === "string" ? value.productId.trim() : "";
  if (!productId) return { ok: true, step: null };
  if (productId === context.courseProductId) return { ok: false, why: "self" };
  if (!context.products.has(productId)) return { ok: false, why: "product" };
  const line = typeof value.line === "string" ? plain(value.line) : "";
  const why = lineProblem(line);
  return why ? { ok: false, why } : { ok: true, step: { productId, line } };
}

/** What is wrong with the creator's line, or null when it may be shown. Counted as a reader counts: one emoji is one. */
export function lineProblem(line: string): NextStepProblem | null {
  if ([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(line)].length > MAX_NEXT_STEP_LINE) return "long";
  if (/https?:|www\.|@|\b[a-z0-9-]+\.(com|net|org|io|co|app|shop|store|link|me)\b/i.test(line)) return "link";
  if (DEAL_WORDS.test(line)) return "deal";
  if (PRESSURE.test(line)) return "pressure";
  if (/\p{N}/u.test(line)) return "number";
  if (/["“”«»„‟]/.test(line)) return "quote";
  if (/[!¡]/.test(line)) return "exclaim";
  return null;
}

/** What the card needs to know about the product picked, read by the next unit; "unknown" for what could not be read. */
export type NextStepProduct = {
  id: string;
  /** Whether the store sells it today (lib/store-checkout.ts canSellProduct: published, priced, something to hand over, the store selling). */
  onSale: boolean;
  /** How many are left of a limited one, null for no limit. */
  left: number | null | "unknown";
};

export type NextStepHidden = "none" | "gone" | "self" | "not_on_sale" | "sold_out" | "stock_unknown" | "owned" | "owned_unknown" | "dismissed";

/**
 * Whether one student sees the course's next step, and why not when they do
 * not. Every doubt keeps the card away: a product that could not be read, a
 * purchase or a "No thanks" that could not be read (point 1: "desconhecido =
 * não aparece").
 */
export function nextStepShown(input: {
  step: NextStep | null;
  courseProductId: string;
  /** The product picked, null when the store no longer has it, "unknown" when it could not be read. */
  product: NextStepProduct | null | "unknown";
  /** Whether the student already has it. */
  owned: boolean | "unknown";
  /** Whether the student said "No thanks" to this course's next step. */
  dismissed: boolean | "unknown";
}): { shown: true } | { shown: false; why: NextStepHidden } {
  const { step, product } = input;
  if (!step) return { shown: false, why: "none" };
  if (step.productId === input.courseProductId) return { shown: false, why: "self" };
  if (product === null || product === "unknown" || product.id !== step.productId) return { shown: false, why: "gone" };
  if (!product.onSale) return { shown: false, why: "not_on_sale" };
  if (product.left === "unknown") return { shown: false, why: "stock_unknown" };
  if (product.left !== null && !(product.left > 0)) return { shown: false, why: "sold_out" };
  if (input.owned === "unknown") return { shown: false, why: "owned_unknown" };
  if (input.owned) return { shown: false, why: "owned" };
  if (input.dismissed !== false) return { shown: false, why: "dismissed" };
  return { shown: true };
}

/**
 * When the card is shown on the course's page: always, while the rules above
 * let it, on the course's home and right after the student marks its last
 * lesson done (point 1), never in the middle of the lessons, so it does not
 * break the course up.
 */
export function nextStepPlace(where: { page: "course" | "lesson"; finishedNow: boolean }): boolean {
  return where.page === "course" || where.finishedNow;
}
