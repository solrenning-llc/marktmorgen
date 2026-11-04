/**
 * Whether an ad's words may be sent to an ad platform: 632 [AA2] (c), unit 2
 * (owner, 2 November 2026, 02h17 Fortaleza). The owner's rule for ads made
 * here: "com os filtros de honestidade existentes (nada de promessa de ganho,
 * escassez ou depoimento inventado)".
 *
 * The same honesty rules the store already holds its own words to
 * (lib/terms-check-rules.ts, checkCreatorTerms), applied to every line of an
 * ad (headline, main text, description, button words), and stricter, because
 * an ad reaches people who never chose to read the creator:
 *
 *   - a promise of fast or easy money, or of earnings, income or results, is
 *     refused, not only warned;
 *   - urgency or scarcity is refused unless the store really has the deadline
 *     (a sale with an end) or the stock limit behind it;
 *   - a price in the ad that is not the product's price is refused;
 *   - a quoted testimonial ("…" — Name) is refused unless its words are, word
 *     for word, one of the store's own verified reviews passed in;
 *   - another company's name or address is a warning: ads naming other
 *     brands are often refused by the platforms, and the creator decides.
 *
 * Not checked here, on purpose: each platform's own published ad policies
 * (before-and-after, health, finance, AI-content labels) and their length
 * limits: only what the official check confirmed may become a rule
 * (docs/ad-platforms-official-check-2026-11-02.md), and Meta's texts were not
 * readable there, so they are listed in `notChecked`, never assumed. Pure;
 * nothing is sent.
 */
import { type TermsWarningKind, checkCreatorTerms } from "@/lib/terms-check-rules";

export type AdText = { headline: string; text: string; description: string; button: string };

export type AdContext = {
  /** The product's price in the smallest unit; null when free or several prices. */
  priceCents: number | null;
  currency: string;
  /** The creator's own hosts, without "www.". */
  ownHosts: readonly string[];
  /** Whether a sale with a real end date is running for this product. */
  realDeadline: boolean;
  /** Whether the product has a real limited quantity. */
  realStockLimit: boolean;
  /** The exact words of the store's own verified reviews of this product. */
  verifiedReviews: readonly string[];
};

export type AdRule = TermsWarningKind | "testimonial_unverified" | "empty" | "too_long";
export type AdFinding = { field: keyof AdText; rule: AdRule; excerpt: string; why: string; fix: string };
export type AdCheck = { sendable: boolean; refusals: AdFinding[]; warnings: AdFinding[]; notChecked: readonly string[] };

/** Every line of an ad together, at most this many characters: far past any platform's own limit. */
export const AD_TEXT_MAX = 5_000;

export const AD_NOT_CHECKED: readonly string[] = [
  "Each ad platform's own policies beyond these words: Meta's were not readable in the official check; Google's unreliable-claims and TikTok's misleading-content rules are covered here only where they match the store's own (earnings, results); TikTok's AI-content label and before-and-after pictures are not read here (docs/ad-platforms-official-check-2026-11-02.md)",
  "Each platform's length limits for headlines and text",
  "Pictures and videos: only the words are read here",
];

const REFUSED: ReadonlySet<TermsWarningKind> = new Set<TermsWarningKind>(["fast_money", "earnings_claim", "false_urgency", "price_mismatch"]);

// Quoted words followed by who said them ("…" — Ana; "…", said Ben): bounded, with no nested repetition.
const QUOTE = /["“]([^"”]{8,400})["”],? ?(?:[-–—] ?|said |says )[A-Z]/gu;
const normal = (words: string) => words.toLowerCase().replace(/[\s ]+/g, " ").replace(/[.!?,;:]+$/, "").trim();

/** Checks an ad's words; `sendable` only when nothing is refused. */
export function checkAdText(ad: AdText, context: AdContext): AdCheck {
  const refusals: AdFinding[] = [];
  const warnings: AdFinding[] = [];
  const fields = Object.keys(ad) as (keyof AdText)[];
  const total = fields.reduce((n, f) => n + (ad[f] ?? "").length, 0);
  if (total > AD_TEXT_MAX) {
    refusals.push({ field: "text", rule: "too_long", excerpt: "", why: `An ad's words are kept under ${AD_TEXT_MAX} characters.`, fix: "Shorten it." });
    return { sendable: false, refusals, warnings, notChecked: AD_NOT_CHECKED };
  }
  if (!(ad.headline ?? "").trim() && !(ad.text ?? "").trim()) {
    refusals.push({ field: "headline", rule: "empty", excerpt: "", why: "An ad needs a headline or a main text.", fix: "Write what the product is and who it is for." });
  }
  const reviews = new Set(context.verifiedReviews.map(normal));
  for (const field of fields) {
    const text = ad[field] ?? "";
    if (!text.trim()) continue;
    const found = checkCreatorTerms({
      text,
      ownHosts: context.ownHosts,
      priceCents: context.priceCents,
      currency: context.currency,
      // Refund wording and resale rights belong to terms, not ads: never flagged here.
      immediateAccessConsent: true,
      realDeadline: context.realDeadline,
      realStockLimit: context.realStockLimit,
      resaleLicense: true,
    });
    for (const w of found) {
      const finding = { field, rule: w.kind, excerpt: w.excerpt, why: w.why, fix: w.fix };
      if (REFUSED.has(w.kind)) refusals.push(finding);
      else if (w.kind === "other_company") warnings.push(finding);
    }
    for (const m of text.matchAll(QUOTE)) {
      if (reviews.has(normal(m[1]))) continue;
      refusals.push({
        field,
        rule: "testimonial_unverified",
        excerpt: m[0].slice(0, 120),
        why: "An ad may quote a buyer only with the words of one of your verified reviews, exactly as written.",
        fix: "Use a verified review from your store, word for word, or remove the quote.",
      });
    }
  }
  return { sendable: refusals.length === 0, refusals, warnings, notChecked: AD_NOT_CHECKED };
}
