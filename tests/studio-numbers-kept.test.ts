/**
 * Inbox C4-33 (2), (3), (5): a store's numbers kept from an earlier reading are
 * shown as they are, with the time they were read on the creator's own clock,
 * "Update now" while the day has a reading left, and once they are used when
 * they come back (00:00 UTC, and on the creator's clock). Never "incomplete"
 * for being kept, never "no numbers yet" for a store whose readings are used.
 *
 * What fails here:
 *   - a kept sales reading marked partial (the panel then hides totals, rates
 *     and rankings behind "The recent purchase reading is incomplete");
 *   - none kept and none may be read said as no numbers or as an error;
 *   - "Update now" offered when the day has no reading left, or not offered
 *     when it has;
 *   - the time or the return said only in UTC, or not at all;
 *   - the rule's words for the help missing a figure.
 */
import { readFileSync } from "node:fs";
import { NotRead, ReadingFailed, ReadingsUsed, SINCE_READINGS_PER_DAY, STORE_READINGS_PER_DAY, HEAVY_READINGS_PER_DAY, keptReading, readingsBackAt, readingsLeft } from "@/lib/store-readings";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadingLine } from "@/components/stats-panel";
import { clockWords, nextUtcMidnight, utcAndLocal } from "@/lib/local-clock";
import { READINGS_RULE_WORDS } from "@/lib/store-reading-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const read = (path: string) => readFileSync(path, "utf8");

async function main(): Promise<void> {
  redis.clear();
  const store = { statsId: "k".repeat(32) };
  const t = Date.UTC(2031, 3, 7, 14, 5);
  const day = "2031-04-07";

  part("A kept reading is shown as it is, with its time");
  const sales = { partial: false, totals: { d30: { sales: 3 } } };
  const first = await keptReading(store, "sales", async () => sales, t);
  is("read, kept, not stale", [first?.stale, first?.at, (first?.value as typeof sales).partial], [false, t, false]);
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}`, String(STORE_READINGS_PER_DAY), "EX", 86_400]);
  const later = await keptReading(store, "sales", async () => ({ ...sales, totals: { d30: { sales: 9 } } }), t + 3_600_000);
  is("the day used: the kept one, with the time it was read, its sales whole (never marked partial)", [later?.stale, later?.at, (later?.value as typeof sales).partial, (later?.value as typeof sales).totals.d30.sales], [true, t, false, 3]);
  const keptSales = read("lib/store-readings.ts");
  is("keptSales no longer marks a kept reading partial", keptSales.includes("partial: true"), false);

  part("None kept and none may be read: said as used, with when it comes back");
  redis.run(["DEL", `nl:reading:stats:${store.statsId}`]);
  const used = await keptReading(store, "stats", async () => ({}), t + 3_600_000).then(() => "read", (error: unknown) => (error instanceof ReadingsUsed ? "used" : String(error)));
  is("ReadingsUsed, not null or an error", used, "used");
  is("they come back at the next 00:00 UTC", readingsBackAt(t), Date.UTC(2031, 3, 8));
  is("said in UTC and on the reader's clock", [utcAndLocal(nextUtcMidnight(t), "America/Fortaleza"), utcAndLocal(nextUtcMidnight(t), "UTC"), utcAndLocal(nextUtcMidnight(t))], ["00:00 UTC (9:00 PM your time)", "00:00 UTC", "00:00 UTC"]);
  is("a time on the reader's clock, or UTC before the page runs", [clockWords(t, "America/Fortaleza"), clockWords(t)], ["11:05 AM", "14:05 UTC"]);

  part("Update now only while the day has a reading left");
  // The sales brought up to date since the day's whole one (C4-36 (B)) have their own count: used here, so only the
  // counts below decide.
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}:since`, String(SINCE_READINGS_PER_DAY), "EX", 86_400]);
  is("the day used: nothing left", await readingsLeft(store, t), { any: false, heavy: false, anyLeft: 0, heavyLeft: 0 });
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}`, "2", "EX", 86_400]);
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}:heavy`, String(HEAVY_READINGS_PER_DAY), "EX", 86_400]);
  is("light ones left, the heavy ones used", await readingsLeft(store, t), { any: true, heavy: false, anyLeft: STORE_READINGS_PER_DAY - 2, heavyLeft: 0 });
  redis.run(["DEL", `nl:reading:day:${store.statsId}:${day}:heavy`]);
  is("both left", await readingsLeft(store, t), { any: true, heavy: true, anyLeft: STORE_READINGS_PER_DAY - 2, heavyLeft: HEAVY_READINGS_PER_DAY });

  part("The studio says it");
  const panel = read("components/stats-panel.tsx");
  const studio = read("app/studio/page.tsx");
  is("the panel's reading line: the time on the creator's clock, Update now or when they come back", [panel.includes("Updated at <LocalClock ms={reading.at} />."), panel.includes("{reading.canRefresh ? ("), panel.includes("Update now"), panel.includes("<UtcAndLocal ms={reading.backAt} />")], [true, true, true, true]);
  is("Update now reads again from the day's own budget, and is offered by what is left (heavy for a store that reads sales)", [studio.includes('const freshNumbers = params.numbers === "fresh";'), studio.includes("canRefresh: readsSales(current) ? left.heavy : left.any,"), studio.includes('refreshHref: studioPath(current, "numbers=fresh"),')], [true, true, true]);
  is("a store whose sales are used and none kept is said so, not as an error", studio.includes("used: error instanceof ReadingsUsed"), true);

  part("The rule, in words ready for the help (lib/help-content.ts is another agent's file today; inbox C4-33 (5))");
  is("in plain words, with the figures", [READINGS_RULE_WORDS.includes(`Your sales are read whole once a day (UTC) and brought up to date from what changed up to ${SINCE_READINGS_PER_DAY} more times`), READINGS_RULE_WORDS.includes("00:00 UTC")], [true, true]);
  part("A heavy reading that fails after calling Stripe is counted, and said so; one stopped before is given back (inbox C4-53)");
  {
    const shop = { statsId: "f".repeat(32) };
    const at = Date.UTC(2031, 4, 2, 9, 0);
    const nextDay = at + 86_400_000;
    // The day's whole reading made, kept; the next day's whole reading fails after Stripe was called.
    const ok = await keptReading(shop, "sales", async () => ({ n: 1 }), at, true);
    const beforeFail = await readingsLeft(shop, nextDay);
    const counted = await keptReading(shop, "sales", async () => { throw new Error("Stripe answered 500"); }, nextDay, true);
    const afterFail = await readingsLeft(shop, nextDay);
    is("a failure after the call: the kept reading shown, marked failed", [ok?.failed ?? false, counted?.stale, counted?.failed, (counted?.value as unknown as { n: number }).n], [false, true, true, 1]);
    is("and the day's whole reading of the sales counted", [beforeFail.heavyLeft - afterFail.heavyLeft, Number(redis.run(["GET", `nl:reading:day:${shop.statsId}:2031-05-03:heavy`]))], [HEAVY_READINGS_PER_DAY, HEAVY_READINGS_PER_DAY]);
    const fresh = { statsId: "g".repeat(32) };
    const before = await readingsLeft(fresh, at);
    const stopped = await keptReading(fresh, "sales", async () => { throw new NotRead(); }, at, true).then(() => "read", (e: unknown) => (e instanceof NotRead ? "not read" : String(e)));
    const afterStop = await readingsLeft(fresh, at);
    is("one stopped before calling anyone: given back, nothing below zero", [stopped, afterStop.heavyLeft === before.heavyLeft, afterStop.anyLeft], ["not read", true, STORE_READINGS_PER_DAY]);
    const none = await keptReading({ statsId: "h".repeat(32) }, "sales", async () => { throw new Error("Stripe timed out"); }, at, true).then(() => "read", (e: unknown) => (e instanceof ReadingFailed ? "failed, counted" : String(e)));
    is("with no copy to show, the failure is said as one that was counted", none, "failed, counted");
    const line = renderToStaticMarkup(createElement(ReadingLine, { reading: { at, canRefresh: true, refreshHref: "/studio?numbers=fresh", backAt: at, salesUsed: false, failed: true, left: 1 } }));
    is("the creator reads it: failed, counted, and what is left today", line.includes("The last reading failed and was counted; 1 reading left today."), true);
    const lineNone = renderToStaticMarkup(createElement(ReadingLine, { reading: { at, canRefresh: false, refreshHref: "/studio?numbers=fresh", backAt: at, salesUsed: false, failed: true, left: 0 } }));
    is("and with none left, 0 readings", lineNone.includes("The last reading failed and was counted; 0 readings left today."), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
