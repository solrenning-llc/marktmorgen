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
 *   - the rule missing from the help.
 */
import { readFileSync } from "node:fs";
import { ReadingsUsed, STORE_READINGS_PER_DAY, HEAVY_READINGS_PER_DAY, keptReading, readingsBackAt, readingsLeft } from "@/lib/store-readings";
import { clockWords, nextUtcMidnight, utcAndLocal } from "@/lib/local-clock";
import { READINGS_RULE_WORDS, UPDATE_RULE_WORDS } from "@/lib/store-reading-rules";
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
  is("the day used: nothing left", await readingsLeft(store, t), { any: false, heavy: false });
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}`, "2", "EX", 86_400]);
  redis.run(["SET", `nl:reading:day:${store.statsId}:${day}:heavy`, String(HEAVY_READINGS_PER_DAY), "EX", 86_400]);
  is("light ones left, the heavy ones used", await readingsLeft(store, t), { any: true, heavy: false });
  redis.run(["DEL", `nl:reading:day:${store.statsId}:${day}:heavy`]);
  is("both left", await readingsLeft(store, t), { any: true, heavy: true });

  part("The studio says it");
  const panel = read("components/stats-panel.tsx");
  const studio = read("app/studio/page.tsx");
  is("the panel's reading line: the time on the creator's clock, Update now or when they come back", [panel.includes("Updated at <LocalClock ms={reading.at} />."), panel.includes("{reading.canRefresh ? ("), panel.includes("Update now"), panel.includes("<UtcAndLocal ms={reading.backAt} />")], [true, true, true, true]);
  is("Update now reads again from the day's own budget, and is offered by what is left (heavy for a store that reads sales)", [studio.includes('const freshNumbers = params.numbers === "fresh";'), studio.includes("canRefresh: readsSales(current) ? left.heavy : left.any,"), studio.includes('refreshHref: studioPath(current, "numbers=fresh"),')], [true, true, true]);
  is("a store whose sales are used and none kept is said so, not as an error", studio.includes("used: error instanceof ReadingsUsed"), true);

  part("The help says the rule");
  const help = read("lib/help-content.ts");
  is("the readings' rule and a product update's lookups are in the help", [help.includes("READINGS_RULE_WORDS,"), help.includes("UPDATE_RULE_WORDS")], [true, true]);
  is("in plain words, with the figures", [READINGS_RULE_WORDS.includes(`up to ${STORE_READINGS_PER_DAY} times a day (UTC), ${HEAVY_READINGS_PER_DAY} of them with your sales`), READINGS_RULE_WORDS.includes("00:00 UTC"), UPDATE_RULE_WORDS.includes("one product's buyers a day")], [true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
