import type { NextRequest } from "next/server";
import { creatorFrom, holdStudio } from "@/lib/studio-route";
import { bookCsv, bookSizes, listAffiliates, readBook } from "@/lib/affiliates";
import { bookExportSettled, bookExportUnits } from "@/lib/affiliate-book-export";
import { shortWords } from "@/lib/list-download";
import { ENDED_BOOK_EXPORTS } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { windowCount, windowCountOf } from "@/lib/window-count";
import { PLANS_ON_SALE } from "@/lib/opening";

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
 * runs, from the store's studio figure (bookExportUnits, counted first by
 * bookSizes); once it has ended, from ENDED_BOOK_EXPORTS of its own, never
 * from a figure. A count that does not read refuses with nothing read.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  try {
    if (standingOf(store) === "ended") {
      if (!isRedisConfigured() || !store.statsId) return plain(503, UNCOUNTED);
      const key = `nl:rl:export:${store.statsId}:book-ended:${Date.parse(store.planEndedAt) || 0}`;
      let taken: number | null = null;
      try {
        const count = windowCountOf(await redisPipeline(windowCount(key, ENDED_BOOK_SECONDS)));
        taken = count !== null && count >= 1 ? count : null;
      } catch (error) {
        console.error("counting an affiliate spreadsheet since a plan ended failed", error);
      }
      if (taken === null) return plain(503, UNCOUNTED);
      if (taken > ENDED_BOOK_EXPORTS) {
        const times = ENDED_BOOK_EXPORTS === 1 ? "once" : ENDED_BOOK_EXPORTS === 2 ? "twice" : `${ENDED_BOOK_EXPORTS} times`;
        return plain(429, `You have downloaded your affiliate spreadsheet ${times} since your plan ended, which is what a store whose plan has ended keeps for this.${PLANS_ON_SALE ? " Starting a plan again lets you download it again." : ""}`);
      }
    }
    // While a plan runs: counted first, at the programme's size, and what it reads and sends is held before any of it
    // is read; once the file is made, what its real size did not need is given back.
    let settle: ((sent: number) => Promise<void>) | null = null;
    if (standingOf(store) !== "ended") {
      const sizes = await bookSizes(store);
      if (!sizes) return plain(503, UNCOUNTED);
      const units = bookExportUnits(sizes);
      const held = await holdStudio(store, units);
      if (!held.ok) return plain(held.reason === "unknown" ? 503 : 429, held.reason === "used" ? shortWords(store, units, held) : held.message);
      settle = async (sent) => held.give(units - bookExportSettled(sizes, sent));
    }
    // Counted ahead, the invoices kept between readings with it (bookExportWork), so the reading takes no more.
    const [book, people] = await Promise.all([readBook(store, undefined, { keptPaid: true }), listAffiliates(store)]);
    const day = new Date().toISOString().slice(0, 10);
    const csv = bookCsv(book, people);
    if (settle) await settle(Buffer.byteLength(csv, "utf8")).catch((error: unknown) => console.error("giving back an affiliate spreadsheet's units failed", error));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="affiliates-${store.handle}-${day}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("exporting the affiliate book failed", error);
    return new Response("Something went wrong on our side. Try again in a moment.", { status: 500 });
  }
}
