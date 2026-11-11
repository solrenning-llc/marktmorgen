/**
 * The studio's fees page and its download (282 [HG1], unit 3;
 * lib/sale-fees-view.ts, app/studio/fees/page.tsx,
 * app/api/store/fees/export/route.ts). Checked:
 *
 *   - a loss is said in words, money back is said as such, unknown is
 *     "Not known", never zero;
 *   - the reading's time, a stale copy and a failed try are said;
 *   - a reading that did not reach the year's first month says from when
 *     it shows, and that older months are "Not read";
 *   - every state with nothing to show says why, never a zero;
 *   - the page and the download read the same reading, for whoever may see
 *     the store's numbers, and the download link says what it gives;
 *   - the tables have captions, column and row headers, and scroll on their
 *     own under the keyboard on a narrow screen.
 */
import { readFileSync } from "node:fs";
import { FEES_PAGE_SALES, feesOf, keptWords, monthWords, outWords, reachWords, readWords, stateWords, unavailableWords } from "@/lib/sale-fees-view";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/fees/page.tsx", "utf8");
const route = readFileSync("app/api/store/fees/export/route.ts", "utf8");
const AT = Date.UTC(2026, 10, 11, 15, 4);

function main(): void {
  part("Amounts");
  is("kept", keptWords(382500, "usd"), "$3,825");
  is("kept with cents", keptWords(3825, "usd"), "$38.25");
  is("a loss in words", keptWords(-140, "eur"), "€1.40 loss");
  is("unknown is said, never zero", keptWords(null, "usd"), "Not known");
  is("money out", outWords(175, "usd"), "$1.75");
  is("money that came back", outWords(-3000, "usd"), "$30 back");
  is("nothing", outWords(0, "usd"), "$0");
  is("every fee added", feesOf({ stripeFee: 175, feeTax: 35, applicationFee: 0, otherFee: 7 }), 217);
  is("a month in words", monthWords("2026-11"), "November 2026");

  part("When it was read");
  is("fresh", readWords({ at: AT, stale: false }), "Read from your Stripe account on November 11, 2026 at 15:04 UTC.");
  is("stale", readWords({ at: AT, stale: true }), "Read from your Stripe account on November 11, 2026 at 15:04 UTC. Today's readings are used, so this is the last one kept. They come back at 00:00 UTC.");
  is("failed", readWords({ at: AT, stale: true, failed: true }), "Read from your Stripe account on November 11, 2026 at 15:04 UTC. The last try to read it again did not work, so this is the reading before it.");
  is("reached the year: nothing said", reachWords(1000, 1000), null);
  is("did not: says from when, and that older months say Not read", reachWords(Date.UTC(2026, 6, 2, 0, 0, 1), 1000), 'Your Stripe account has more lines than one reading takes, so only what happened since July 2, 2026 is shown. Months before it say "Not read", never zero.');

  part("Nothing to show, said");
  for (const kind of ["none", "not_configured", "used", "failed"] as const) {
    const words = stateWords({ kind });
    is(`${kind}: a sentence, no zero, no figure`, [words.length > 20, /\$0|\b0\b/.test(words.replace("00:00", ""))], [true, false]);
  }
  for (const why of ["incomplete", "unreadable", "repeated", "too_large", "zone", "late"] as const) {
    is(`${why}: says nothing here is a zero`, unavailableWords(why).endsWith("Nothing here is a zero."), true);
  }

  part("The page and the download");
  is("the page is for whoever may see the store's numbers", /studioView\(await cookies\(\), [^\n]*: undefined, "stats"\)/.test(page), true);
  is("the download too", /creatorFrom\(request, "stats"\)/.test(route), true);
  is("both read the same reading", [page.includes("keptSaleFees(store)"), route.includes("keptSaleFees(store)")], [true, true]);
  is("the download link says what it gives", page.includes(">Download every sale as a spreadsheet (CSV)</a>"), true);
  is("the page lists at most FEES_PAGE_SALES and says the download has every one", [FEES_PAGE_SALES, page.includes("sales.rows.slice(0, FEES_PAGE_SALES)"), page.includes("The download has every one.")], [50, true, true]);
  is("a download that is not whole gives no file", route.includes("if (csv === null) return plain(503"), true);
  is("the file is never cached or indexed", [route.includes('"private, no-store"'), route.includes('"X-Robots-Tag": "noindex"')], [true, true]);

  part("Tables a screen reader and a keyboard can use");
  is("two tables, each with a caption", (page.match(/<caption/g) ?? []).length, 2);
  is("column headers scoped", (page.match(/scope="col"/g) ?? []).length, 15);
  is("each row has its own header", (page.match(/scope="row"/g) ?? []).length, 4);
  is("each table scrolls on its own and is reachable by keyboard", (page.match(/overflow-x-auto" tabIndex=\{0\} role="region" aria-label=/g) ?? []).length, 2);
  is("the studio's trail says where the page is (components/breadcrumb.tsx)", page.includes('<StudioTrail store={store} here="Fees and what you keep" />'), true);
  is("what changes after loading is announced", (page.match(/role="status"/g) ?? []).length >= 3, true);
  is("one h1, sections under h2", [(page.match(/<h1/g) ?? []).length, (page.match(/<h2/g) ?? []).length], [1, 2]);

  done();
}

main();
