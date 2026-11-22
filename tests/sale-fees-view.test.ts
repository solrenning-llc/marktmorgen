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
import { FEES_PAGE_SALES, downloadRefusal, exportReachRefusal, feesOf, keptWords, monthWords, outWords, reachWords, readWords, stateWords, unavailableWords } from "@/lib/sale-fees-view";
import { saleFeeMonths, saleFeesCsv } from "@/lib/sale-fees-months";
import { SALE_FEES_FILE_MAX_BYTES, SALE_FEES_KEPT_SHAPE, SALE_FEES_PAGES, SALE_FEES_PAGE_SIZE } from "@/lib/sale-fees-reading";
import { saleFees } from "@/lib/sale-fees-rules";
import { STUDIO_ACTIONS } from "@/lib/studio-actions";
import { can } from "@/lib/team-roles";
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
  is("did not: says from when, and that older months say Not read", reachWords(Date.UTC(2026, 6, 2, 0, 0, 1), 1000), 'One reading could not go back to the start of the year in your Stripe account (it has too many sales, or Stripe answered slowly), so only what happened since July 2, 2026 is shown. Months before it say "Not read", never zero.');

  part("A download that would not start at the year's start is refused (audit 1285)");
  is("reached the year: a file", exportReachRefusal(1000, 1000), null);
  is("did not: no file, and why", exportReachRefusal(Date.UTC(2026, 6, 2, 0, 0, 1), 1000), "One reading could not go back to the start of the year in your Stripe account (it has too many sales, or Stripe answered slowly), so the file would start on July 2, 2026, not at the start of the year. No file is made from a part: it would look like the whole year.");
  is("the route refuses before it writes the file", route.indexOf("exportReachRefusal(state.kept.since, readingSince(state.kept.at") > 0 && route.indexOf("exportReachRefusal(") < route.indexOf("saleFeesCsv(report"), true);
  part("The page offers no download that would fail (audit f89b)");
  is("a whole reading kept: the download", downloadRefusal({ since: 1000, stored: true }, 1000), null);
  is("a copy read back (kept): the download", downloadRefusal({ since: 1000 }, 1000), null);
  is("a reading short of the year: the reason, never a link", downloadRefusal({ since: Date.UTC(2026, 6, 2, 0, 0, 1), stored: true }, 1000), exportReachRefusal(Date.UTC(2026, 6, 2, 0, 0, 1), 1000));
  is("a reading too large to keep: the reason, never a link", downloadRefusal({ since: 1000, stored: false, tooLarge: true }, 1000), "This reading was too large to keep, so no file is made from it. The figures on this page are the whole reading.");
  is("a copy that could not be written: said as that, never 'too large' (audit 2fb6)", downloadRefusal({ since: 1000, stored: false }, 1000), "This reading could not be kept, so no file is made from it now. The figures on this page are the whole reading. Try the download again later.");
  is("the page asks it of the reading it shows", page.includes('const noFile = kept ? downloadRefusal(kept, readingSince(kept.at, "UTC")) : null;'), true);
  is("the link and 'The download has every one.' only when there is a file", [/noFile === null \? \(\s*<p className="mt-4">\s*<a className="btn btn-secondary btn-sm" href=\{download\} download>/.test(page), page.includes('${noFile === null ? " The download has every one." : ""}')], [true, true]);
  is("and the reason in its place", page.includes('role="status">{noFile}</p>'), true);
  is("the page says how far the reading went even when no month can be shown", /const reach = kept \? reachWords\(kept\.since, readingSince\(kept\.at, "UTC"\)\) : null;/.test(page), true);

  part("The owner's only, as the tax page: an editor has 'stats' but not 'payments' (audit 9c68)");
  is("the page asks 'payments', never 'stats'", page.includes(': undefined, "payments")') && !page.includes(': undefined, "stats")'), true);
  is("the download asks 'payments'", route.includes('creatorFrom(request, "payments")') && !route.includes('creatorFrom(request, "stats")'), true);
  is("the studio action asks 'payments'", STUDIO_ACTIONS.find((a) => a.id === "fees")?.permission, "payments");
  is("an editor is refused, the owner is not", [can("editor", "payments"), can("editor", "stats"), can("owner", "payments")], [false, true, true]);

  part("Nothing to show, said");
  for (const kind of ["none", "not_configured", "used", "failed"] as const) {
    const words = stateWords({ kind });
    is(`${kind}: a sentence, no zero, no figure`, [words.length > 20, /\$0|\b0\b/.test(words.replace("00:00", ""))], [true, false]);
  }
  for (const why of ["incomplete", "unreadable", "repeated", "too_large", "zone", "late"] as const) {
    is(`${why}: says nothing here is a zero`, unavailableWords(why).endsWith("Nothing here is a zero."), true);
  }

  part("The page and the download");
  is("the page is the owner's only ('payments', audit 9c68)", /studioView\(await cookies\(\), [^\n]*: undefined, "payments"\)/.test(page), true);
  is("the download too", /creatorFrom\(request, "payments"\)/.test(route), true);
  is("both read the same reading", [page.includes("keptSaleFees(store)"), route.includes("keptSaleFees(store)")], [true, true]);
  is("the download link says what it gives", page.includes(">Download every sale as a spreadsheet (CSV)</a>"), true);
  is("the page lists at most FEES_PAGE_SALES and says the download has every one", [FEES_PAGE_SALES, page.includes("sales.rows.slice(0, FEES_PAGE_SALES)"), page.includes(" The download has every one.")], [50, true, true]);
  is("a download that is not whole gives no file", route.includes("if (csv === null) return plain(503"), true);
  is("the file is never cached or indexed", [route.includes('"private, no-store"'), route.includes('"X-Robots-Tag": "noindex"')], [true, true]);

  part("The file is never larger than it is priced to send (audit 2fb6)");
  is("the kept shape prices the file sent at its largest", SALE_FEES_KEPT_SHAPE.outBytes, SALE_FEES_FILE_MAX_BYTES);
  is("the route refuses a larger file before sending it", route.indexOf("Buffer.byteLength(csv, \"utf8\") + 4 > SALE_FEES_FILE_MAX_BYTES") > route.indexOf("saleFeesCsv(report") && route.indexOf("Buffer.byteLength(csv") < route.indexOf("new Response(`"), true);
  {
    // Every sale one reading can hold, each at its longest fields, with a note: well inside the ceiling.
    const created = Math.floor(Date.UTC(2026, 10, 11) / 1000);
    const worst = Array.from({ length: SALE_FEES_PAGES * SALE_FEES_PAGE_SIZE }, (_, i) => ({
      id: `txn_${"9".repeat(24)}${i}`, object: "balance_transaction", amount: 99_999_999, currency: "usd", fee: 9_999_999,
      fee_details: [{ amount: 9_999_999, currency: "usd", type: "stripe_fee" }], net: 90_000_000, type: "charge", reporting_category: "charge",
      created: created - i, source: { id: `ch_${"9".repeat(24)}${i}`, charge: null },
    }));
    const csv = saleFeesCsv(saleFees(worst, { complete: true }), "UTC", readWords({ at: AT, stale: true, failed: true }));
    is("the largest file one reading can make is under the ceiling", csv === null ? "no file" : Buffer.byteLength(csv, "utf8") + 4 < SALE_FEES_FILE_MAX_BYTES ? "under" : Buffer.byteLength(csv, "utf8"), "under");
  }

  part("A payout's fee is shown, never dropped (Codex G on #3651, from #3632)");
  // lib/sale-fees-rules.ts books a payout's or transfer's fee as an account fee (tests/sale-fees-rules.test.ts,
  // tests/sale-fees-months.test.ts); the page shows the month's account fees as money out.
  is("the months table has the account fees column", page.includes("outWords(-l.accountFees, l.currency)"), true);
  is("a payout's 72-cent fee (account fees -72) reads as money out", outWords(-(-72), "usd"), "$0.72");
  // Claude 3 nuvem K's LEVE on #3651: a payout line taken through the page's own reading (saleFeeMonths in "UTC", as
  // app/studio/fees/page.tsx calls it) reaches the account fees cell, never only the formatter on a typed number.
  const payout = {
    id: "txn_payout1", object: "balance_transaction", amount: -4800, currency: "usd", fee: 72,
    fee_details: [{ amount: 72, currency: "usd", type: "stripe_fee" }], net: -4872, type: "payout",
    reporting_category: "payout", source: null, created: Math.floor(Date.UTC(2026, 10, 5, 15) / 1000),
  };
  const read = saleFeeMonths([payout], { complete: true, since: Date.UTC(2026, 0, 1), at: AT }, "UTC");
  const november = read.available ? read.months.find((m) => m.month === "2026-11") : undefined;
  const line = november && november.state !== "unknown" ? november.lines.find((l) => l.currency === "usd") : undefined;
  is("a payout's fee reaches the month's account fees cell as the page draws it", line ? outWords(-line.accountFees, line.currency) : null, "$0.72");

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
