/**
 * The part of review requests a purchase needs: whether a store asks its
 * buyers for a review by email, how many days after buying, and putting a
 * paid order on the list to be asked.
 *
 * Kept apart from lib/review-requests.ts, which reads the list and sends the
 * email, so the store record and the purchase confirmation can use these
 * without importing the sender side, and the sender side can use the
 * confirmation without the two importing each other.
 *
 * Off for every store until its creator switches it on. Only orders paid
 * while it is on are put on the list, each once, whichever of the thanks
 * page and the five-minute job confirms the purchase first:
 *
 *   nl:rev:ask:due  -> sorted set of "<statsId>|<handle>|<reference>|<paidAt>",
 *                      scored by when the email is due, in seconds
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type ReviewElsewhere, parseReviewElsewhere } from "@/lib/review-elsewhere";

export type ReviewAsk = {
  /** Days after buying that the one email goes out; 0 is off. */
  days: number;
  /**
   * The creator's own page on a public review site, named in every request
   * after the store's own link (lib/review-elsewhere.ts); absent is none.
   */
  elsewhere?: ReviewElsewhere;
  /**
   * One reminder (636 [GL4](a)): this many days after the first email, only
   * to a buyer who has not reviewed yet; absent or 0 is none, as for every
   * store before it existed. Never a second one.
   */
  again?: number;
};

/** The shortest and longest wait between the email and its one reminder. */
export const MIN_AGAIN_DAYS = 3;
export const MAX_AGAIN_DAYS = 14;

/** When the one reminder for an order paid at `paidAt` is due. */
export function againDueAt(paidAt: number, days: number, again: number): number {
  return paidAt + (days + again) * 86_400;
}

/** A reminder setting as kept: 3 to 14 days, anything else none. */
export function readAgain(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_AGAIN_DAYS && raw <= MAX_AGAIN_DAYS ? raw : 0;
}

export const MIN_ASK_DAYS = 3;
export const MAX_ASK_DAYS = 30;
/** What a creator switching it on starts from. */
export const DEFAULT_ASK_DAYS = 7;
export const NO_ASK: ReviewAsk = { days: 0 };

export const ASK_DUE_KEY = "nl:rev:ask:due";

const REFERENCE = /^(cs_(test|live)_[A-Za-z0-9]{10,200}|pi_[A-Za-z0-9]{10,200})$/;
const STATS_ID = /^[0-9a-f]{32}$/;

/** Whatever came back from storage, made safe to use: off unless a whole number of days in range. */
export function parseReviewAsk(raw: unknown): ReviewAsk {
  if (!raw || typeof raw !== "object") return { ...NO_ASK };
  const days = (raw as { days?: unknown }).days;
  // Kept while the email is off too, so switching it back on does not lose it.
  const stored = (raw as { elsewhere?: unknown }).elsewhere;
  const elsewhere = parseReviewElsewhere(stored && typeof stored === "object" ? (stored as { url?: unknown }).url : stored);
  const on = typeof days === "number" && Number.isInteger(days) && days >= MIN_ASK_DAYS && days <= MAX_ASK_DAYS ? days : 0;
  const again = readAgain((raw as { again?: unknown }).again);
  return { days: on, ...(elsewhere ? { elsewhere } : {}), ...(again ? { again } : {}) };
}

/** One entry on the list, as it is kept. */
export type AskEntry = { statsId: string; handle: string; reference: string; paidAt: number };

export function askMember(entry: AskEntry): string {
  return `${entry.statsId}|${entry.handle}|${entry.reference}|${entry.paidAt}`;
}

export function readAskMember(member: string): AskEntry | null {
  const [statsId, handle, reference, paid] = member.split("|");
  const paidAt = Number(paid);
  if (!STATS_ID.test(statsId ?? "") || !handle || !REFERENCE.test(reference ?? "") || !Number.isInteger(paidAt) || paidAt <= 0) {
    return null;
  }
  return { statsId, handle, reference, paidAt };
}

/** When the email for an order paid at `paidAt` is due, with the store's current setting. */
export function dueAt(paidAt: number, days: number): number {
  return paidAt + days * 86_400;
}

/**
 * Puts a paid order on the list to be asked for a review, when the store asks.
 * Safe to call any number of times for the same order: the list holds each
 * once, at the time it was first given.
 */
export async function scheduleReviewAsk(
  store: { statsId: string | null; handle: string; reviewAsk: ReviewAsk },
  reference: string,
  paidAt: number,
): Promise<boolean> {
  if (!store.reviewAsk.days || !store.statsId || !isRedisConfigured()) return false;
  if (!REFERENCE.test(reference) || !Number.isInteger(paidAt) || paidAt <= 0) return false;
  const member = askMember({ statsId: store.statsId, handle: store.handle, reference, paidAt });
  const [added] = await redisPipeline([["ZADD", ASK_DUE_KEY, "NX", dueAt(paidAt, store.reviewAsk.days), member]]);
  return Number(added) === 1;
}
