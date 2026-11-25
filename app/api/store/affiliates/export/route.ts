import type { NextRequest } from "next/server";
import { creatorFrom, holdStudio } from "@/lib/studio-route";
import { BookRecordUnreadable, bookCsv, bookSizes, listAffiliates, readBook } from "@/lib/affiliates";
import { bookExportSettled } from "@/lib/affiliate-book-export";
import { shortWords } from "@/lib/list-download";
import { ENDED_BOOK_EXPORTS } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { windowCount, windowCountOf } from "@/lib/window-count";
import { PLANS_ON_SALE } from "@/lib/opening";
import { BOOK_BUSY_SECONDS, BOOK_BUSY_WORDS, BOOK_FAILED_TRIES, bookFailedUsedWords, bookFailedWords, bookPassingWords } from "@/lib/affiliate-book-export-rules";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { allowanceWindow, resetWords, windowKeySeconds } from "@/lib/allowance-window";
import { refreshPeriod } from "@/lib/billing-sync";

/** How long the count of spreadsheets since a plan ended is kept: past its closing day and the week a late last notice adds, as the whole export's. */
const ENDED_BOOK_SECONDS = 60 * 86_400;
/** Said when what the spreadsheet takes could not be counted: nothing of the book was read. */
const UNCOUNTED = "This can't be counted right now. Try again in a minute.";

const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * The affiliate programme as a spreadsheet, for the creator's own records:
 * every credited sale with what it earns after refunds, and every payout the
 * creator wrote down. Only for the owner of the store, and an Admin: it
 * carries every affiliate's address (lib/team-roles.ts, "export").
 *
 * It reads the whole book, so it is paid for at the programme's size before
 * anything is read (lib/affiliate-book-export.ts; #5010 row 150): while a plan
 * runs, from the store's studio figure: what its reading takes held first
 * (bookExportSettled with no file, counted by bookSizes), the file's own size
 * counted once it is made; once the plan has ended, from the owner's
 * ENDED_BOOK_EXPORTS of their own, never from a figure, given back when the
 * file could not be made. A count that does not read refuses with nothing read.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const ended = standingOf(store) === "ended";
  // After the plan ends: the owner's own downloads; as the whole store's file (#4081), a teammate with "export" is
  // refused before anything is counted.
  if (ended && creator.role !== "owner") return plain(403, "After a plan ends, only the store's owner can download the affiliate spreadsheet.");
  if (isRedisConfigured() && !store.statsId) return plain(503, UNCOUNTED);
  // One spreadsheet at a time for a store (#5256 focal 3634, 1): a second click, or the owner and an Admin at once,
  // waits for the first, with nothing counted, rather than being told of a failure that did not happen.
  let busy: Held | null = null;
  if (isRedisConfigured()) {
    try {
      busy = await takeLock(`nl:rl:export:${store.statsId}:book-busy`, BOOK_BUSY_SECONDS, 0);
    } catch (error) {
      if (error instanceof LockBusyError) return plain(429, BOOK_BUSY_WORDS);
      console.error("taking an affiliate spreadsheet's turn failed", error);
      return plain(503, UNCOUNTED);
    }
  }
  try {
    return await spreadsheet(store, ended);
  } finally {
    if (busy) await releaseLock(busy);
  }
}

/** The spreadsheet itself, made while the store's turn is held. */
async function spreadsheet(store: Store, ended: boolean): Promise<Response> {
  // Given back when nothing of the book was read (#5256 audit, 7bab 1 and 3c4a 5). Once the book was read, a failure
  // keeps what its reading took (that cost was real, and pricing a free reading again has no room: Store 66 ceiling).
  // A record of the book that could not be read (BookRecordUnreadable, the same every time) also takes, while a plan
  // runs, one of BOOK_FAILED_TRIES, so it is not read again and again (ea4f 2); a passing failure on our side does
  // not, so the download can be tried again at once (focal 3634, 2).
  let giveBack: () => Promise<void> = async () => {};
  let failedOnce: () => Promise<void> = async () => {};
  let span: string | null = null;
  let reading = false;
  try {
    let settle: ((sent: number) => Promise<void>) | null = null;
    if (ended) {
      if (!isRedisConfigured() || !store.statsId) return plain(503, UNCOUNTED);
      const since = Date.parse(store.planEndedAt) || 0;
      const key = `nl:rl:export:${store.statsId}:book-ended:${since}`;
      const taken = await counted(key, ENDED_BOOK_SECONDS, "counting an affiliate spreadsheet since a plan ended");
      if (taken === null) return plain(503, UNCOUNTED);
      const back = decr(key, "giving back an affiliate spreadsheet");
      if (taken > ENDED_BOOK_EXPORTS) {
        await back();
        return plain(429, `You have downloaded your affiliate spreadsheet ${times(ENDED_BOOK_EXPORTS)} since your plan ended, which is what a store whose plan has ended keeps for this.${PLANS_ON_SALE ? " Starting a plan again lets you download it again." : ""}`);
      }
      // A try whose record could not be read keeps its place: it is one of the ENDED_BOOK_EXPORTS, each priced at the
      // largest programme with the store's closing.
      giveBack = back;
    } else {
      // While a plan runs: counted first, at the programme's size. What its reading takes is held before anything is
      // read, and only that is held against what is left (7bab 7); the file's own size is counted once it is made,
      // past the figure if it must, as a list download's file is.
      store = await refreshPeriod(store);
      span = standingOf(store) === "trial" ? "in this trial" : "this month";
      const window = allowanceWindow(store);
      if (isRedisConfigured() && !window) return plain(503, resetWords(store));
      // A record that could not be read earlier in the window: the book is not read again, nothing is counted.
      const failedKey = isRedisConfigured() && window ? `nl:rl:export:${store.statsId}:book-failed:${window.id}` : null;
      if (failedKey) {
        const failed = await readCount(failedKey);
        if (failed === null) return plain(503, UNCOUNTED);
        if (failed >= BOOK_FAILED_TRIES) return plain(429, bookFailedUsedWords(span, resetWords(store)));
        failedOnce = async () => {
          await redisPipeline(windowCount(failedKey, windowKeySeconds(store, 86_400))).catch((error: unknown) => console.error("counting an affiliate spreadsheet's failed try failed", error));
        };
      }
      const sizes = await bookSizes(store);
      if (!sizes) return plain(503, UNCOUNTED);
      const units = bookExportSettled(sizes, 0);
      const held = await holdStudio(store, units);
      // Only the reading's part is held first, so the download needs at least that (#5256 audit, 729c 15).
      if (!held.ok) return plain(held.reason === "unknown" ? 503 : 429, held.reason === "used" ? shortWords(store, units, held, true) : held.message);
      giveBack = async () => { await held.give(units); };
      settle = async (sent) => {
        const more = bookExportSettled(sizes, sent) - units;
        // A count of the file that is not confirmed: the file is not sent, so nothing goes out uncounted (Claude 7 xAF's
        // LEVE 2 on #5256); the reading stays counted, as for any passing failure.
        if (more > 0 && !(await held.force(more))) throw new FileUncounted();
      };
    }
    // Counted ahead, the invoices kept between readings with it (bookExportWork), so the reading takes no more.
    reading = true;
    const [book, people] = await Promise.all([readBook(store, undefined, { keptPaid: true }), listAffiliates(store)]);
    const day = new Date().toISOString().slice(0, 10);
    const csv = bookCsv(book, people);
    if (settle) await settle(Buffer.byteLength(csv, "utf8"));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="affiliates-${store.handle}-${day}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("exporting the affiliate book failed", error);
    if (!reading) {
      await giveBack().catch((caught: unknown) => console.error("giving back an affiliate spreadsheet failed", caught));
      return plain(500, "Something went wrong on our side before your affiliate spreadsheet was read. Nothing was counted. Try again in a moment.");
    }
    // The reading was done, so it stays counted. A record that does not read fails the same way every time: it also
    // takes the window's failed try, so it is not read again. Anything else is a passing failure on our side: the
    // download can be tried again at once (focal 3634, 2).
    if (error instanceof BookRecordUnreadable) {
      await failedOnce();
      return plain(500, bookFailedWords(ended, span));
    }
    return plain(500, bookPassingWords(ended));
  }
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** The file's size could not be counted: the file is held back, a passing failure (Claude 7 xAF's LEVE 2 on #5256). */
class FileUncounted extends Error {
  constructor() {
    super("the affiliate spreadsheet's size was not counted");
    this.name = "FileUncounted";
  }
}

/** A count taken (INCR, kept `seconds`): the new count, or null when it could not be read. */
async function counted(key: string, seconds: number, what: string): Promise<number | null> {
  try {
    const count = windowCountOf(await redisPipeline(windowCount(key, seconds)));
    return count !== null && count >= 1 ? count : null;
  } catch (error) {
    console.error(`${what} failed`, error);
    return null;
  }
}

/** A count read: 0 when absent, null when the reply is not one. */
async function readCount(key: string): Promise<number | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", key]]), 1);
    if (!replies) return null;
    const [value] = replies;
    if (value === null) return 0;
    return typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : null;
  } catch (error) {
    console.error("reading an affiliate spreadsheet's failed tries failed", error);
    return null;
  }
}

/** Gives one back to a count taken. */
function decr(key: string, what: string): () => Promise<void> {
  return async () => {
    await redisPipeline([["DECR", key]]).catch((error: unknown) => console.error(`${what} failed`, error));
  };
}
