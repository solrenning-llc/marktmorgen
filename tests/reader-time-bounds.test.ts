/**
 * The MEDIUMs on #4166 (Claude 1 cloud, then confirmed by Claude 1 rev-pares and Claude 7, 12-13/11/2026):
 *
 * 1. A day in the past made deliveryPlan call itself for each of the next 7 days, each of those for its own next 7,
 *    without bound: about 7^k calls for a day k days back (15 days: 37 s; 18 days: still running after 300 s), each
 *    rebuilding the groups over every reader. The search is now one flat pass over the 7 candidate days.
 * 2. A reader's zone was any name Intl accepts, offsets ("+05:17") and odd case ("america/new_york") included, so the
 *    1,561 offsets from -12:00 to +14:00 made 1,561 groups for one day against MAX_GROUPS 48, about one scheduled job
 *    per contact. Only IANA-style names are kept now, in their canonical case, and the plan itself refuses more than
 *    MAX_GROUPS groups.
 */
import { MAX_GROUPS, deliveryPlan, readerZone } from "@/lib/reader-time";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 18, 0);
const timed = <T>(f: () => T): { value: T; ms: number } => {
  const start = Date.now();
  const value = f();
  return { value, ms: Date.now() - start };
};

part("A day in the past is refused at once, however far back");
for (const back of [20, 400, 3650]) {
  const day = new Date(NOW - back * 86_400_000).toISOString().slice(0, 10);
  const { value, ms } = timed(() => deliveryPlan({ day, storeZone: "America/New_York", zones: ["America/New_York", "Asia/Tokyo"], now: NOW }));
  is(`${back} days back: refused as past, with no day of its next week to offer`, value, { ok: false, reason: "past" });
  is(`${back} days back: answered within 2 s (took ${ms} ms)`, ms < 2_000, true);
}
const yesterday = deliveryPlan({ day: "2026-11-11", storeZone: "America/New_York", zones: ["America/New_York"], now: NOW });
is("control: yesterday still offers the first day that works", yesterday, { ok: false, reason: "past", firstDay: "2026-11-13" });

part("Only real zone names are a reader's zone, kept in their own case");
is("an offset is not a reader's zone", [readerZone("+05:17"), readerZone("-00:01"), readerZone("+14:00")], [null, null, null]);
is("a name in another case is kept as the zone data writes it", readerZone("america/new_york"), "America/New_York");
is("a real name stays as given", [readerZone("Asia/Kolkata"), readerZone("Europe/Berlin")], ["Asia/Kolkata", "Europe/Berlin"]);

part("However the zones are written, a day's groups never pass MAX_GROUPS");
const offsets: string[] = [];
for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 1) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  offsets.push(`${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`);
}
const flood = deliveryPlan({ day: "2026-12-01", storeZone: "America/New_York", zones: offsets, now: NOW });
is(`1,561 offset strings: within MAX_GROUPS (${flood.ok ? flood.groups.length : flood.reason})`, flood.ok ? flood.groups.length <= MAX_GROUPS : flood.reason === "groups", true);
done();
