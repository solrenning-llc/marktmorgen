/**
 * The parts of reviews a page draws, and nothing that talks to storage, so
 * the studio's preview in the browser can use them too (lib/reviews.ts has
 * the rules in full and the records).
 */

export const MAX_REVIEW_TEXT = 1_000;
export const MAX_REVIEW_NAME = 40;
export const MAX_REPLY_TEXT = 1_000;
/** The most reviews one product keeps; a product past it takes no new ones. */
export const MAX_REVIEWS_PER_PRODUCT = 2_000;
/** Shown on a product's own page; the rest are on its reviews page. */
export const REVIEWS_ON_PAGE = 10;
export const REVIEWS_PER_PAGE = 30;

/** The rule for hidden reviews, in the words the studio and the pages use. */
export const HIDDEN_RULE =
  "Hiding takes a review's words off your page, never its stars out of the average: the average and the count include hidden reviews, and your page says how many are hidden. A review is hidden only for one of the review rules, the same for every rating.";

/**
 * Why a creator may hide a review (567 [GD1] (e)): what the review says, never
 * how many stars it gives. The same rules for every rating, so hiding can never
 * be used to keep only the good reviews on a page. A low star rating or
 * criticism of the product is not a reason.
 */
export const HIDE_REASONS = [
  { id: "private", label: "Shares private information", hint: "It shows someone's private details, such as a home address, a phone number or an email address." },
  { id: "abusive", label: "Abusive or hateful", hint: "It harasses or threatens someone, or is obscene, sexually explicit or hateful about a group of people." },
  { id: "unrelated", label: "Not about this product", hint: "It is about something else entirely, not this product or buying it." },
  { id: "false", label: "Clearly false", hint: "It states a fact about the product that is plainly untrue, such as saying it has, or lacks, something it plainly does or does not have." },
  { id: "unlawful", label: "Breaks the law", hint: "It breaks the law or someone else's rights, such as copied work or a link to something illegal." },
] as const;

export type HideReason = (typeof HIDE_REASONS)[number]["id"];

export function isHideReason(value: unknown): value is HideReason {
  return typeof value === "string" && HIDE_REASONS.some((reason) => reason.id === value);
}

/** The words the studio shows for a reason, or null. */
export function hideReasonLabel(value: unknown): string | null {
  return HIDE_REASONS.find((reason) => reason.id === value)?.label ?? null;
}

export const REVIEW_ID_PATTERN = /^[0-9a-f]{24}$/;

export type Review = {
  id: string;
  productId: string;
  /** The order it came from: a checkout (cs_…) or an offer taken after paying (pi_…). */
  reference: string;
  /** The payment behind that order, read when the review was written, for refunds. */
  pi: string;
  rating: number;
  text: string;
  /** What the buyer chose to be called; empty shows "Verified buyer". */
  name: string;
  createdAt: number;
  /** When the buyer last changed it; 0 when never. */
  editedAt: number;
  hidden: boolean;
  /** Which review rule the creator hid it for; null when it is not hidden, or was hidden before reasons were kept. */
  hiddenReason: HideReason | null;
  refunded: boolean;
  reply: { text: string; at: number } | null;
  /**
   * A photo the buyer added (added 10 October 2026): what they made with it,
   * how they use it. In the store's own picture folder, shown with the
   * review's words and hidden with them; the creator may take it off.
   */
  photo: ReviewPhoto | null;
  /**
   * When its order was paid, in seconds (606 [WP5]): kept when the review is
   * first written, so the page can say how long after purchase it was
   * written. Absent from reviews written before it was kept.
   */
  paidAt?: number;
};

export type ReviewPhoto = { path: string; width: number; height: number };

/** The most a review's photo may weigh: the buyer's browser shrinks it to fit. */
export const MAX_REVIEW_PHOTO_BYTES = 400_000;
/** And its long side, in pixels. */
export const REVIEW_PHOTO_SIDE = 1200;

/** The numbers a product's page and its card show, kept up to date on every change. */
export type Summary = {
  /** Reviews whose stars count: every one not refunded, hidden or not. */
  count: number;
  /** The sum of those stars. */
  stars: number;
  /** Reviews on the page (refunded ones included, marked). */
  visible: number;
  /** Reviews the creator hid. */
  hidden: number;
  /** Reviews whose purchase was refunded in full. */
  refunded: number;
  /** How many counted reviews gave 1, 2, 3, 4 and 5 stars. */
  dist: [number, number, number, number, number];
};

export const EMPTY_SUMMARY: Summary = { count: 0, stars: 0, visible: 0, hidden: 0, refunded: 0, dist: [0, 0, 0, 0, 0] };

/** The numbers, counted afresh from every review of a product. */
export function summarise(reviews: Review[]): Summary {
  const summary: Summary = { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  for (const review of reviews) {
    if (review.hidden) summary.hidden += 1;
    else summary.visible += 1;
    if (review.refunded) {
      summary.refunded += 1;
      continue;
    }
    summary.count += 1;
    summary.stars += review.rating;
    summary.dist[review.rating - 1] += 1;
  }
  return summary;
}

/**
 * Whether a page shows stars at all: at least one review whose stars count.
 * Hidden reviews count (567 [GD1] (e)): hiding every review takes their words
 * off the page, never the stars, so it cannot take a low rating away either.
 */
export function showsRating(summary: Summary): boolean {
  return summary.count >= 1;
}

/** The average, to one decimal, as the page prints it and the search data states it. */
export function average(summary: Summary): number {
  return summary.count ? Math.round((summary.stars / summary.count) * 10) / 10 : 0;
}

/**
 * The store's own numbers: every listed product's reviews added together, for
 * the stars under the store's name. Only products a visitor can see count.
 */
export function storeSummary(each: Map<string, Summary>, listed: Iterable<string>): Summary {
  const total: Summary = { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  for (const id of listed) {
    const one = each.get(id);
    if (!one) continue;
    total.count += one.count;
    total.stars += one.stars;
    total.visible += one.visible;
    total.hidden += one.hidden;
    total.refunded += one.refunded;
    one.dist.forEach((n, i) => (total.dist[i] += n));
  }
  return total;
}

/** "4.8", "5.0". */
export function averageText(summary: Summary): string {
  return average(summary).toFixed(1);
}

/** "1 review hidden by the creator", "3 reviews hidden by the creator", or "". */
export function hiddenLine(summary: Summary): string {
  if (!summary.hidden) return "";
  return `${summary.hidden} ${summary.hidden === 1 ? "review" : "reviews"} hidden by the creator`;
}

