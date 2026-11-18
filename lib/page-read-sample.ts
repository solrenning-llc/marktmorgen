/**
 * How many visitors a page's reading is measured on (lib/page-read.ts): one
 * in READ_SAMPLE. Apart from that file because a browser needs it and that
 * file signs with a key the browser must never be handed.
 */
export const READ_SAMPLE = 8;

/** The fewest measured visitors before a share is shown: below it, chance says more than the page. */
export const READ_MIN_VISITORS = 30;

/**
 * How long after its page was drawn a reading's token is good for: a visitor
 * who leaves later is not counted, so the page stops measuring before then
 * and sends nothing that could never count (components/page-depth.tsx).
 */
export const READ_TOKEN_SECONDS = 2 * 3600;

/**
 * What the studio says when a window's readings went past its ceiling
 * (lib/page-read.ts, readingsPartial): that the month is only partly counted,
 * how many were, and when counting starts again. No figure is made up for
 * the visits not counted.
 */
/** What the studio says when whether this month is counted in full cannot be read (readingsPartial gave "unknown"). */
export function readingsUnknownWords(): string {
  return "Whether this month is counted in full can't be checked right now, so the time on page and how far people read may be missing some visits. Reload the page to try again.";
}

export function readingsPartialWords(counted: number, opens: number, resumed = false): string {
  const day = new Date(opens).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  if (resumed) return `Only part of this month is counted. Your earlier plan counted up to ${counted.toLocaleString("en-US")} measured visits a month for time on page and how far people read, and that number was reached. Visits measured after that and before your plan changed are not counted. Counting went on after the change.`;
  return `Only part of this month is counted. Your plan counts up to ${counted.toLocaleString("en-US")} measured visits a month for time on page and how far people read, and that number was reached. Visits measured after that are not counted until ${day} (UTC).`;
}
