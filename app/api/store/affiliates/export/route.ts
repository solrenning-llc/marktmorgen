import type { NextRequest } from "next/server";
import { creatorFrom, holdStudio } from "@/lib/studio-route";
import { bookCsv, bookSizes, listAffiliates, readBook } from "@/lib/affiliates";
import { bookExportSettled } from "@/lib/affiliate-book-export";
import { shortWords } from "@/lib/list-download";
import { ENDED_BOOK_EXPORTS } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { windowCount, windowCountOf } from "@/lib/window-count";
import { PLANS_ON_SALE } from "@/lib/opening";
import { BOOK_FAILED_TRIES, bookFailedUsedWords, bookFailedWords } from "@/lib/affiliate-book-export-rules";
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
  let { store } = creator;
  // Given back when nothing of the book was read (#5256 audit, 7bab 1 and 3c4a 5); once the book was read, a failure
  // keeps what its reading took, and its failed try (BOOK_FAILED_TRIES), so a record that cannot be read is not read
  // again and again (coordinator ea4f 2).
  let giveBack: () => Promise<void> = async () => {};
  // Given back once the file is made: the failed try taken before the reading.
  let made: () => Promise<void> = async () => {};
  let ended = false;
  let span: string | null = null;
  let reading = false;
  try {
    let settle: ((sent: number) => Promise<void>) | null = null;
    if (standingOf(store) === "ended") {
      // After the plan ends: the owner's own downloads, ENDED_BOOK_EXPORTS of them, never a figure's; as the whole
      // store's file (#4081), a teammate with "export" is refused before anything is counted.
      ended = true;
      if (creator.role !== "owner") return plain(403, "After a plan ends, only the store's owner can download the affiliate spreadsheet.");
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
      // A try that read the book and failed keeps its place: it is one of the ENDED_BOOK_EXPORTS, each priced at the
      // largest programme with the store's closing, so failing again and again reads it no more than they allow.
      giveBack = back;
    } else {
      // While a plan runs: counted first, at the programme's size. What its reading takes is held before anything is
      // read, and only that is held against what is left (7bab 7); the file's own size is counted once it is made,
      // past the figure if it must, as a list download's file is. A reading that fails keeps what its reading took.
      if (isRedisConfigured() && !store.statsId) return plain(503, UNCOUNTED);
      store = await refreshPeriod(store);
      span = standingOf(store) === "trial" ? "in this trial" : "this month";
      const sizes = await bookSizes(store);
      if (!sizes) return plain(503, UNCOUNTED);
      const units = bookExportSettled(sizes, 0);
      const window = allowanceWindow(store);
      if (isRedisConfigured() && !window) return plain(503, resetWords(store));
      // The failed try first, so a spreadsheet that cannot be made is refused before the studio figure is touched.
      const tries = isRedisConfigured() && window ? await failedTry(`nl:rl:export:${store.statsId}:book-failed:${window.id}`, windowKeySeconds(store, 86_400)) : { back: async () => {} };
      if (tries === "unknown") return plain(503, UNCOUNTED);
      if (tries === "used") return plain(429, bookFailedUsedWords(span, resetWords(store)));
      const held = await holdStudio(store, units);
      if (!held.ok) {
        await tries.back();
        // Only the reading's part is held first, so the download needs at least that (#5256 audit, 729c 15).
        return plain(held.reason === "unknown" ? 503 : 429, held.reason === "used" ? shortWords(store, units, held, true) : held.message);
      }
      giveBack = async () => { await held.give(units); await tries.back(); };
      made = tries.back;
      settle = async (sent) => {
        const more = bookExportSettled(sizes, sent) - units;
        if (more > 0) await held.force(more);
      };
    }
    // Counted ahead, the invoices kept between readings with it (bookExportWork), so the reading takes no more.
    reading = true;
    const [book, people] = await Promise.all([readBook(store, undefined, { keptPaid: true }), listAffiliates(store)]);
    const day = new Date().toISOString().slice(0, 10);
    const csv = bookCsv(book, people);
    if (settle) await settle(Buffer.byteLength(csv, "utf8")).catch((error: unknown) => console.error("counting an affiliate spreadsheet's file failed", error));
    await made().catch((error: unknown) => console.error("giving back an affiliate spreadsheet's try failed", error));
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
    return plain(500, bookFailedWords(ended, span));
  }
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

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

/** Gives one back to a count taken. */
function decr(key: string, what: string): () => Promise<void> {
  return async () => {
    await redisPipeline([["DECR", key]]).catch((error: unknown) => console.error(`${what} failed`, error));
  };
}

/** Takes one of the BOOK_FAILED_TRIES before the book is read: given back (`back`) once the file is made, or when nothing was read. */
async function failedTry(key: string, seconds: number): Promise<{ back: () => Promise<void> } | "used" | "unknown"> {
  const count = await counted(key, seconds, "counting an affiliate spreadsheet's failed tries");
  if (count === null) return "unknown";
  const back = decr(key, "giving back an affiliate spreadsheet's try");
  if (count > BOOK_FAILED_TRIES) {
    await back();
    return "used";
  }
  return { back };
}
