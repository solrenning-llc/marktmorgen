import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { readStats, salesCsv, sourcesCsv, studioStats, visitsCsv, readsSales } from "@/lib/stats";
import { exportShape, exportUnits, storeExport } from "@/lib/store-export";
import { standingOf } from "@/lib/plan-standing";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";

/** How long the count of whole exports since a plan ended is kept: past its closing day and the week a late last notice adds. */
const ENDED_EXPORT_SECONDS = 60 * 86_400;
import { takeAllowance } from "@/lib/store-allowance";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { APP_IMPORT_CAPS, accountingFile, accountingLines, accountingPeriod, cleanAccountCode, cleanTaxName } from "@/lib/accounting-export-rules";
import { ACCOUNTING_PAGES, ACCOUNTING_PAYPAL_LIMIT, readAccountingSales } from "@/lib/accounting-export";

/**
 * The count a SET NX then INCR round gave, only in its exact shape (CX-123
 * rule 24): two replies, the SET's "OK" or null, and a whole count from one
 * up. Anything else, or no answer at all, is null: unknown, never a count
 * under the limit.
 */
function countFrom(reply: unknown): number | null {
  const replies = repliesFor(reply, 2);
  if (!replies || (replies[0] !== "OK" && replies[0] !== null)) return null;
  const count = countOf(replies[1]);
  return count !== null && count >= 1 ? count : null;
}

const unanswered = (error: unknown) => {
  console.error("counting an export failed", error);
  return null;
};

/** Files one store may take in ten minutes: each sales file is up to a hundred reads of Stripe. */
const EXPORTS_PER_WINDOW = 10;

/**
 * The store's numbers as files: its sales (read from its own Stripe account,
 * for the last 30 or 90 days or all of them), its visits day by day, and
 * where its visitors came from; and, since 18 October 2026, everything the
 * store keeps as one file (what=store, lib/store-export.ts), which a store
 * whose plan has ended needs before it closes (lib/plan-closing.ts). Since 6 November 2026 (queue item 37 [F6]),
 * sales with format=xero or format=quickbooks are one month, or half of one, as a file those apps import
 * (lib/accounting-export-rules.ts), read exactly within the sales file's own ceiling (lib/accounting-export.ts):
 * a read that is not whole makes no file. Only someone whose role on the store has the
 * permission reaches it (sales need "export", the rest "stats"), and the
 * store is settled by lib/studio-route.ts, never read from the query alone.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const what = params.get("what") ?? "";
  // Sales and the whole store carry buyers' addresses; visits and sources are only counts.
  const creator = await creatorFrom(request, what === "sales" || what === "store" ? "export" : "stats");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const range = params.get("range") ?? "";
  const plain = (status: number, body: string) =>
    new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  if (isRedisConfigured() && store.statsId) {
    const key = `nl:rl:export:${store.statsId}`;
    const count = countFrom(await redisPipeline([
      ["SET", key, "0", "EX", 600, "NX"],
      ["INCR", key],
    ]).catch(unanswered));
    // A count that could not be read makes no file: nothing was read, and the answer says so.
    if (count === null) {
      return what === "store"
        ? plain(503, "Your store's file could not be made just now. Try again in a minute.")
        : plain(502, "Stripe or our records did not answer just now. Nothing is lost; try again in a moment.");
    }
    if (count > EXPORTS_PER_WINDOW) return plain(429, "That is a lot of files in ten minutes. Try again in a few minutes.");
  }

  const day = new Date().toISOString().slice(0, 10);
  const file = (csv: string, name: string) =>
    // The byte-order mark makes Excel read the file as UTF-8.
    new Response(`\uFEFF${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });

  if (what === "store") {
    // While a plan runs, it is read out of the store's studio figure, at its size. Once the plan
    // has ended, the store has ENDED_STORE_EXPORTS of its own before it closes, counted for that
    // ending and never taken from a figure or the share of stores that pay nothing, so it is
    // never refused for want of room (priced with its closing, tests/plan-cost-registry.ts).
    if (standingOf(store) === "ended") {
      if (!isRedisConfigured() || !store.statsId) return plain(503, "Your store's file could not be made just now. Try again in a minute.");
      const ended = Date.parse(store.planEndedAt) || 0;
      const key = `nl:rl:export:${store.statsId}:ended:${ended}`;
      const taken = countFrom(await redisPipeline([["SET", key, "0", "EX", ENDED_EXPORT_SECONDS, "NX"], ["INCR", key]]).catch(unanswered));
      if (taken === null) return plain(503, "Your store's file could not be made just now. Try again in a minute.");
      if (taken > ENDED_STORE_EXPORTS) {
        return plain(429, `You have downloaded your store's main data ${ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`} since your plan ended, which is what a store whose plan has ended keeps for this. Your list, your sales and your numbers still download one by one below, and starting a plan again lets you download it again.`);
      }
    } else {
      let shape;
      try {
        shape = await exportShape(store);
      } catch (error) {
        console.error("measuring a store export failed", error);
        return plain(503, "Your store's file could not be measured just now. Try again in a minute.");
      }
      const took = await takeAllowance(store, "studio", exportUnits(shape));
      if (!took.ok) return plain(429, took.message);
    }
    return new Response(storeExport(store), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${store.handle}-everything-${day}.json"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  try {
    if (what === "sales") {
      if (!readsSales(store)) return plain(400, "Connect Stripe or PayPal first: sales are read from them.");
      // The same sales for Xero or QuickBooks (queue item 37 [F6]): one period, read exactly, or no file at all.
      const format = params.get("format") ?? "";
      if (format) {
        if (format !== "xero" && format !== "quickbooks") return plain(400, "Choose Xero or QuickBooks.");
        const app = format === "xero" ? "Xero" : "QuickBooks";
        const period = accountingPeriod(params.get("month") ?? "", params.get("half") ?? "", Date.now());
        if (!period) return plain(400, "Choose one of the last 12 months, and a part of it that has started. A day is in the file once it is over (UTC).");
        const account = cleanAccountCode(params.get("account") ?? "");
        if (account === null) return plain(400, "An account code is up to 10 letters and digits, like 200. Or leave it empty and choose it in Xero.");
        const tax = cleanTaxName(params.get("tax") ?? "");
        if (tax === null) return plain(400, `A tax rate is its name in ${app}, in plain words up to 50 characters, like Tax Exempt. Or leave it empty and choose it in ${app}.`);
        const read = await readAccountingSales(store, period);
        if (!read.ok && read.reason === "unreadable") {
          return plain(502, "Some of your sales could not be read exactly just now, so no file was made: a file with sales missing would put wrong totals in your books. Nothing is lost. Try again in a few minutes.");
        }
        if (!read.ok) {
          // too_many: past the sales file's own ceiling, refused rather than cut short.
          return plain(422, `${period.label} has more sales than one file can read (${(ACCOUNTING_PAGES * 100).toLocaleString("en-US")} Stripe checkouts or ${ACCOUNTING_PAYPAL_LIMIT.toLocaleString("en-US")} PayPal sales). No file was made. Choose the first or the second half of the month. If that is still too many, write to support.`);
        }
        if (!read.sales.length) return plain(200, `There were no paid sales in ${period.label}, so there is nothing to import.`);
        const made = accountingFile(format, accountingLines(read.sales), { account: format === "xero" ? account : "", tax });
        if (!made.ok) {
          const limit = APP_IMPORT_CAPS[format];
          return made.reason === "too_big"
            ? plain(422, `This file would have ${made.rows} lines on ${made.invoices} invoices, and ${app} takes up to ${limit.rows} lines${format === "quickbooks" ? ` and ${limit.invoices} invoices` : ""} in one import. No file was made. Choose the first or the second half of the month.`)
            : plain(502, "Some of your sales could not be written exactly, so no file was made. Nothing is lost. Write to support.");
        }
        return file(made.csv, `${store.handle}-${format}-sales-${period.slug}.csv`);
      }
      const days = range === "30" ? 30 : range === "90" ? 90 : range === "all" ? 0 : -1;
      if (days < 0) return plain(400, "Choose 30 days, 90 days or all time.");
      const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
      const { csv, partial } = await salesCsv(store, since);
      return file(csv, `${store.handle}-sales-${days ? `${days}-days` : "all"}-${day}${partial ? "-partial" : ""}.csv`);
    }
    if (what === "visits") {
      return file(await visitsCsv(store), `${store.handle}-visits-${day}.csv`);
    }
    if (what === "sources") {
      const stats = await readStats(store);
      if (!stats) return plain(503, "Your numbers could not be read just now. Try again in a moment.");
      return file(sourcesCsv(studioStats(store, stats, null, "none")), `${store.handle}-sources-${day}.csv`);
    }
    return plain(400, "Choose store, sales, visits or sources.");
  } catch (error) {
    console.error("exporting numbers failed", error);
    return plain(502, "Stripe or our records did not answer just now. Nothing is lost; try again in a moment.");
  }
}
