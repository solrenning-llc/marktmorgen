/**
 * Video watched past what a plan covers. Since 31 October 2026 (232 [CA1]
 * unit 3) nothing is put on an invoice for it: the meter owes nothing, as
 * visits and orders have since 17 October 2026, and what is left is the
 * record that the creator was written to.
 *
 * lib/watch-rules.ts says what is covered and what an hour past it costs;
 * lib/watch.ts keeps how long each store's video was watched. How a month
 * is settled, and why never twice, is in lib/usage-billing.ts, which this
 * shares with the other thing charged by use (lib/traffic-billing.ts). What
 * is here is video's own part: what it is measured in, what it comes to,
 * and what its line on the invoice says.
 *
 * Until this existed the Terms said a charge would be made that nothing
 * made, and the one cost here with no ceiling had nothing set against it.
 *
 *   nl:watch:billed:<folder>:<month>    cents of that month already on an invoice
 *   nl:watch:adding:<folder>:<month>    a line being added, until it is known to be there
 *   nl:watch:told:<folder>:<month>      the creator was written to about that month
 *   nl:watch:monthly:<subscription>     a yearly plan was set to bill added lines monthly
 */
import { type Meter, type Settled as Used, firstWordOf, settleAllUsage, settleUsage, storeOf } from "@/lib/usage-billing";
import { watchedFolders, watchedIn } from "@/lib/watch";
import { VIDEO_HOURS_INCLUDED, VIDEO_SECONDS_INCLUDED, hoursWords, monthWords } from "@/lib/watch-rules";

const VIDEO: Meter = {
  name: "watch",
  measured: watchedIn,
  // Nothing is owed after use (232 [CA1] unit 3, 31 October 2026): the
  // owner's rule is that the customer pays first and receives after, and
  // the Terms publish no charge past the hours (playback pauses at each
  // plan's hours instead, lib/video-admission-rules.ts). Visits and orders
  // have owed nothing since 17 October 2026; video now joins them, so no
  // meter can put used service on an invoice.
  owed: () => 0,
  // Every plan covers the same hours.
  byPlan: false,
  covered: VIDEO_SECONDS_INCLUDED,
  describe: (month, seconds) => `Video watched past your plan's ${VIDEO_HOURS_INCLUDED} hours in ${monthWords(month)} (${hoursWords(seconds)} watched so far)`,
  folders: watchedFolders,
};

/** A store's month of video, settled: what lib/usage-billing.ts answers, with the time watched in seconds. */
export type Settled = Used & { seconds: number };

const inSeconds = (row: Used): Settled => ({ ...row, seconds: row.amount });

export { storeOf };

/** Settles one store's month. `final` when the month is over: whatever is left is billed, however small. */
export async function settle(folder: string, month: string, final: boolean, now = Date.now()): Promise<Settled> {
  return inSeconds(await settleUsage(VIDEO, folder, month, final, now));
}

/** The daily run: this month for every store whose video was watched, and the month before while it is still being closed. */
export async function settleAll(now = Date.now()): Promise<Settled[]> {
  return (await settleAllUsage(VIDEO, now)).map(inSeconds);
}

/** Whether the creator still has to be written to about this month: true the first time it is asked, and never again. */
export async function firstWord(folder: string, month: string): Promise<boolean> {
  return firstWordOf(VIDEO, folder, month);
}
