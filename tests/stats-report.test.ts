/**
 * The second half of the numbers added on 11 October 2026: countries and
 * devices, each channel from visit to sale, the API's summary and the weekly
 * email (lib/stats.ts, lib/source-rules.ts, lib/stats-report.ts). What is
 * checked:
 *
 *   - a device and a country are read from what the browser and the host say;
 *   - a view counts its country and device, a checkout its channel, a free
 *     product's address its channel too, and each window reads them back;
 *   - a channel's visits, checkouts, signups and sales sit on one row;
 *   - the API's summary keeps money null when Stripe was not read;
 *   - the weekly email says nothing when there was nobody, is claimed once a
 *     week, and its stop link only works for the store it was made for.
 */
import { channelRows, readStats, recordHit, studioStats } from "@/lib/stats";
import { countryOf, deviceOf } from "@/lib/source-rules";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { claimWeek, setWeeklyOff, summaryOf, weekOf, weeklyMessage, weeklyOff, weeklyToken, weeklyTokenOk } from "@/lib/stats-report";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";

async function main(): Promise<void> {
  part("What a browser and the host say");
  is("devices", [IPHONE, IPAD, ANDROID_TABLET, ANDROID_PHONE, MAC].map(deviceOf), ["mobile", "tablet", "tablet", "mobile", "desktop"]);
  is("countries", [countryOf("US"), countryOf("xx"), countryOf("XX"), countryOf(null), countryOf("USA")], ["US", "", "", "", ""]);

  part("Counted, and read back");
  redis.clear();
  process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const NOW = Date.UTC(2026, 9, 12, 12);
  const view = (ip: string, source: string, country: string, device: string) =>
    recordHit(store, { kind: "view", source, ip, userAgent: IPHONE, country, device }, NOW);
  await view("192.0.2.1", "instagram", "US", "mobile");
  await view("192.0.2.2", "instagram", "GB", "mobile");
  await view("192.0.2.3", "google", "US", "desktop");
  await recordHit(store, { kind: "checkout", id: "p1", ip: "192.0.2.1", userAgent: IPHONE, channel: "instagram" }, NOW);
  await recordHit(store, { kind: "checkout", id: "free1", ip: "192.0.2.2", userAgent: IPHONE, channel: "instagram", free: true }, NOW);
  await recordHit(store, { kind: "checkout", id: "p1", ip: "192.0.2.3", userAgent: IPHONE }, NOW);
  const stats = (await readStats(store, NOW))!;
  const w = stats.windows.d7;
  is("countries", w.countries, [{ name: "US", visits: 2 }, { name: "GB", visits: 1 }]);
  is("devices", w.devices, [{ name: "mobile", visits: 2 }, { name: "desktop", visits: 1 }]);
  is("checkouts by channel, untagged as direct", w.checkoutsBySource, [{ name: "instagram", visits: 2 }, { name: "direct", visits: 1 }]);
  is("free addresses by channel", w.freeBySource, [{ name: "instagram", visits: 1 }]);
  is("the all-time record keeps no countries", stats.life?.countries ?? [], []);

  part("A channel from visit to sale");
  const rows = channelRows(w, [{ source: "instagram", cents: 4900, sales: 1 }, { source: "", cents: 1000, sales: 1 }]);
  is("one row a channel, money first", rows, [
    { source: "instagram", visits: 2, checkouts: 2, free: 1, sales: 1, cents: 4900 },
    { source: "direct", visits: 0, checkouts: 1, free: 0, sales: 1, cents: 1000 },
    { source: "google", visits: 1, checkouts: 0, free: 0, sales: 0, cents: 0 },
  ]);

  part("The API's summary");
  const data = studioStats(store, stats, null, "none", []);
  const summary = summaryOf(data);
  const week = summary.days.last_7_days;
  is("visits are there, money is null without Stripe", [week.visitors, week.checkouts, week.sales, week.revenue], [3, 3, null, null]);
  is("its channels", week.channels.map((c) => [c.channel, c.visits, c.checkouts, c.signups, c.sales]), [
    ["instagram", 2, 2, 1, null],
    ["direct", 0, 1, 0, null],
    ["google", 1, 0, 0, null],
  ]);
  is("its countries and devices", [week.countries[0], week.devices[0]], [{ country: "US", views: 2 }, { device: "mobile", views: 2 }]);

  part("The weekly email");
  const message = weeklyMessage(store, data, "https://marktmorgen.com/api/store/weekly?h=harbor&t=x");
  is("it says the week", message?.subject, "Harbor Kitchen: 3 visitors this week");
  is("with where it came from and how to stop it", [/Instagram: 2 visits/.test(message?.text ?? ""), /To stop it: https:/.test(message?.text ?? "")], [true, true]);
  const quiet = { ...data, totals: { ...data.totals, d7: { ...data.totals.d7, visitors: 0 } } };
  is("a week with nobody is not written about", weeklyMessage(store, quiet, "x"), null);
  is("a week starts on its Monday", [weekOf(Date.UTC(2026, 9, 12)), weekOf(Date.UTC(2026, 9, 18, 23))], ["2026-10-12", "2026-10-12"]);
  is("claimed once a week", [await claimWeek("harbor", NOW), await claimWeek("harbor", NOW)], [true, false]);
  const token = weeklyToken("harbor");
  is("the stop link is the store's own", [weeklyTokenOk("harbor", token), weeklyTokenOk("other", token), weeklyTokenOk("harbor", "nope")], [true, false, false]);
  await setWeeklyOff(store, true);
  const off = await weeklyOff(store);
  await setWeeklyOff(store, false);
  is("stopped, and started again", [off, await weeklyOff(store)], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
