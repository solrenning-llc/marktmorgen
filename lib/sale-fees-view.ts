/**
 * The words of the studio's fees page (282 [HG1], unit 3; app/studio/fees).
 * Plain US English: a loss is said in words, never only by a sign or a
 * color; what is not known is said, never shown as zero.
 *
 * Pure, so the page and the tests read one rule.
 */
import { formatMoney } from "@/lib/money";
import type { FeeMonthLine } from "@/lib/sale-fees-months";
import type { SaleRow, SaleFeesUnavailable } from "@/lib/sale-fees-rules";

/** How many sales the page lists; the download has every one. */
export const FEES_PAGE_SALES = 50;

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** An amount the creator kept or lost: a loss said in words. */
export function keptWords(amount: number | null, currency: string): string {
  if (amount === null) return "Not known";
  return amount < 0 ? `${formatMoney(-amount, currency)} loss` : formatMoney(amount, currency);
}

/** Money that left (fees, refunds, disputes): said as a plain amount, with money that came back said as such. */
export function outWords(taken: number, currency: string): string {
  if (taken === 0) return formatMoney(0, currency);
  return taken > 0 ? formatMoney(taken, currency) : `${formatMoney(-taken, currency)} back`;
}

/** "November 2026" for "2026-11". */
export function monthWords(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return MONTH.format(new Date(Date.UTC(y, m - 1, 1)));
}

export function dayWords(ms: number): string {
  return DAY.format(new Date(ms));
}

/** When the numbers were read, and whether they are the last ones kept. */
export function readWords(kept: { at: number; stale: boolean; failed?: boolean }): string {
  const when = `Read from your Stripe account on ${dayWords(kept.at)} at ${TIME.format(new Date(kept.at))} UTC.`;
  if (kept.failed) return `${when} The last try to read it again did not work, so this is the reading before it.`;
  if (kept.stale) return `${when} Today's readings are used, so this is the last one kept. They come back at 00:00 UTC.`;
  return when;
}

/** Said when one reading did not reach back to the year's first month. */
export function reachWords(since: number, firstMonthFloor: number): string | null {
  if (since <= firstMonthFloor) return null;
  return `One reading could not go back to the start of the year in your Stripe account (it has too many sales, or Stripe answered slowly), so only what happened since ${dayWords(since)} is shown. Months before it say "Not read", never zero.`;
}

/**
 * Why the download is refused when one reading did not reach the year's first month (`since` past `firstMonthFloor`):
 * a file that starts later would look like the whole year, and a creator would file taxes from it. Null when it did.
 */
export function exportReachRefusal(since: number, firstMonthFloor: number): string | null {
  if (since <= firstMonthFloor) return null;
  return `One reading could not go back to the start of the year in your Stripe account (it has too many sales, or Stripe answered slowly), so the file would start on ${dayWords(since)}, not at the start of the year. No file is made from a part: it would look like the whole year.`;
}

/**
 * Why the page offers no download for this reading, or null when it does (audit f89b): a reading short of the year
 * (exportReachRefusal), or one read now that was too large to keep, which the download would have to read again.
 */
export function downloadRefusal(kept: { since: number; stored?: boolean; tooLarge?: boolean }, firstMonthFloor: number): string | null {
  const short = exportReachRefusal(kept.since, firstMonthFloor);
  if (short !== null) return short;
  if (kept.stored === false) {
    // Said as it is: past the copy's size, or the copy could not be written (audit 2fb6).
    return kept.tooLarge
      ? "This reading was too large to keep, so no file is made from it. The figures on this page are the whole reading."
      : "This reading could not be kept, so no file is made from it now. The figures on this page are the whole reading. Try the download again later.";
  }
  return null;
}

/** Why the download sends no file when it would be larger than it is priced to send (SALE_FEES_FILE_MAX_BYTES; audit 2fb6). */
export const FILE_TOO_LARGE_WORDS = "This file would be larger than a download can send, so no file is made. The figures on the page are the whole reading. Nothing here is a zero.";

/** Why a report is not shown. */
export function unavailableWords(why: SaleFeesUnavailable | "zone" | "late"): string {
  if (why === "too_large") return "Your Stripe account has more lines than this page can add up at once, so no figures are shown. Nothing here is a zero.";
  return "Not every line of your Stripe account could be read in full, so no figures are shown: a part would look like the whole. Nothing here is a zero.";
}

/** What the page says when there is nothing to show, by state. */
export function stateWords(state: { kind: "none" | "not_configured" | "used" | "failed"; backAt?: number }): string {
  if (state.kind === "none") return "Connect your Stripe account to see the fees on each sale and what you keep.";
  if (state.kind === "not_configured") return "Selling is not set up yet, so your Stripe account cannot be read.";
  if (state.kind === "used") return "Today's readings of your Stripe account are used. They come back at 00:00 UTC.";
  return "Your Stripe account could not be read just now. Nothing here is a zero. Try again later.";
}

/** Every fee on a sale or in a month: Stripe's, tax on it, an application fee and any other. */
export const feesOf = (r: Pick<SaleRow | FeeMonthLine, "stripeFee" | "feeTax" | "applicationFee" | "otherFee">): number =>
  r.stripeFee + r.feeTax + r.applicationFee + r.otherFee;
