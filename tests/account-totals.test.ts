/**
 * 639 [GL7](38): all of an account's stores added up. Counts add; money adds
 * only within one currency; a store the person may not read, a paused one or
 * one that failed is named and left out; sales read short are said; the page
 * reads each other store inside that store's own studio allowance.
 */
import { readFileSync } from "node:fs";
import { LEFT_WORDS, type StoreFigures, sumStores } from "@/lib/account-totals";
import type { StatsData } from "@/lib/stats";
import { done, is, part } from "./check";

const totals = (visitors: number, checkouts: number, sales: number, cents: number) => ({ visitors, views: visitors * 2, checkouts, sales, cents });
function data(currency: string, d30: [number, number, number, number], extra: Partial<StatsData> = {}): StatsData {
  const t = totals(...d30);
  return { totals: { d7: totals(1, 1, 1, 100), d30: t, d90: t, all: t }, currency, sales: "ok", partial: false, ...extra } as unknown as StatsData;
}
const store = (name: string, read: StoreFigures["read"]): StoreFigures => ({ sid: name.toLowerCase(), name, handle: name.toLowerCase(), read });

function main(): void {
  part("Counts add, money only within one currency");
  const sum = sumStores([
    store("Bread", { state: "ok", data: data("usd", [100, 10, 4, 4_000]), members: { currency: "usd", paying: 3, trialing: 1, mrr: 2_700, complete: true, elsewhere: 0 } }),
    store("Pasta", { state: "ok", data: data("USD", [50, 5, 2, 1_000]), members: { currency: "usd", paying: 2, trialing: 0, mrr: 1_800, complete: true, elsewhere: 0 } }),
    store("Brot", { state: "ok", data: data("eur", [20, 2, 1, 900]), members: null }),
  ]);
  is("visitors, checkouts and sales add up", [sum.windows.d30.visitors, sum.windows.d30.checkouts, sum.windows.d30.sales], [170, 17, 7]);
  is("dollars and euros stay apart, largest first", sum.windows.d30.revenue, [{ currency: "USD", cents: 5_000 }, { currency: "EUR", cents: 900 }]);
  is("members add, their monthly money by currency", [sum.members.paying, sum.members.trialing, sum.members.mrr], [5, 1, [{ currency: "USD", cents: 4_500 }]]);
  is("three stores in, nothing left out, sales whole", [sum.counted, sum.left, sum.salesWhole], [3, [], true]);
  is("each window on its own", sum.windows.d7.sales, 3);

  part("What is left out is named, with why");
  const some = sumStores([
    store("Bread", { state: "ok", data: data("usd", [100, 10, 4, 4_000], { partial: true }), members: null }),
    store("Theirs", { state: "no_access" }),
    store("Tired", { state: "paused" }),
    store("Broken", { state: "error" }),
    store("New", { state: "ok", data: null, members: null }),
  ]);
  is("only the readable store is in the sums", [some.counted, some.windows.d30.sales], [1, 4]);
  is("the others are named with why", some.left.map((l) => [l.name, l.why]), [["Theirs", "no_access"], ["Tired", "paused"], ["Broken", "error"], ["New", "no_numbers"]]);
  is("sales read short are said", some.salesWhole, false);
  is("every reason has words", some.left.every((l) => LEFT_WORDS[l.why].length > 0), true);
  is("a store with no sales account does not make the sales short", sumStores([store("A", { state: "ok", data: data("usd", [1, 0, 0, 0], { sales: "none" }), members: null })]).salesWhole, true);
  is("nothing to add: zero, no money lines", [sumStores([]).windows.d90.revenue, sumStores([]).counted], [[], 0]);

  part("The page");
  const page = readFileSync("app/studio/totals/page.tsx", "utf8");
  const header = readFileSync("components/studio-header.tsx", "utf8");
  is("each other store is read inside its own studio allowance", page.includes("countStudio(store, null, STUDIO_PAGE_UNITS)"), true);
  is("only where the role includes the numbers", page.includes('can(entry.role, "stats")'), true);
  is("a table with a caption and headers, and one h1", [page.includes("<caption"), page.includes('scope="col"'), page.split("<h1").length - 1], [true, true, 1]);
  is("reached from the store menu when there are two or more", header.includes("stores.length > 1") && header.includes("/studio/totals?store="), true);
  done();
}

main();
