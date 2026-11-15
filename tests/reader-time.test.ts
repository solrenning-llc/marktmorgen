/**
 * "Deliver at 9 a.m. in each reader's time zone", the rules (lib/reader-time.ts,
 * 367 [EZ4] unit 1; added 12 November 2026). Synthetic readers only. Checked:
 *
 *   - each reader's 9:00 on the day picked, exact in the southern hemisphere,
 *     in half-hour zones and on a daylight-saving change;
 *   - a missing or made-up zone uses the creator's own zone (an alias such
 *     as Asia/Kolkata is a real zone),
 *     and the plan counts those readers;
 *   - readers with the same 9:00 are one group; groups are in time order and
 *     bounded even with every zone there is;
 *   - a day whose first 9:00 is already (or nearly) here is refused with the
 *     first day that works; an impossible day or one past the scheduler's
 *     window is refused; nothing is guessed.
 */
import { DELIVERY_HOUR, MAX_GROUPS, MIN_LEAD_MS, PLAN_PROBLEMS, deliveryPlan, planWords, readerZone } from "@/lib/reader-time";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 18, 0); // Thursday 12 November 2026, 18:00 UTC
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const plan = (day: string, zones: (string | null)[], storeZone = "America/New_York", now = NOW) => deliveryPlan({ day, storeZone, zones, now });

part("A reader's zone is only one they gave");
is("a real zone is kept", readerZone("Australia/Sydney"), "Australia/Sydney");
is("a made-up zone is not", readerZone("Mars/Olympus"), null);
is("an alias a browser may report is kept, not refused", readerZone("Asia/Kolkata"), "Asia/Kolkata");
is("nothing, or not a string", [readerZone(null), readerZone(""), readerZone(42)], [null, null, null]);

part("9:00 where each reader is");
{
  const p = plan("2026-11-20", ["Australia/Sydney", "Asia/Kolkata", "Europe/Paris", "Europe/Berlin", "America/New_York", "Pacific/Kiritimati"]);
  if (!p.ok) is("planned", p.reason, "ok");
  else {
    is("each group at its 9:00, first to last", p.groups.map((g) => [iso(g.at), g.zones]), [
      ["2026-11-19T19:00", ["Pacific/Kiritimati"]], // UTC+14
      ["2026-11-19T22:00", ["Australia/Sydney"]], // UTC+11 in its summer
      ["2026-11-20T03:30", ["Asia/Kolkata"]], // UTC+5:30
      ["2026-11-20T08:00", ["Europe/Berlin", "Europe/Paris"]], // the same 9:00: one group
      ["2026-11-20T14:00", ["America/New_York"]], // UTC−5
    ]);
    is("every reader counted once", [p.readers, p.groups.reduce((n, g) => n + g.readers, 0)], [6, 6]);
    is("first and last", [iso(p.first), iso(p.last)], ["2026-11-19T19:00", "2026-11-20T14:00"]);
  }
  const dst = plan("2027-03-14", ["America/New_York"], "America/New_York");
  is("on the day clocks spring forward, 9:00 is 13:00 UTC, not 14:00", dst.ok ? iso(dst.first) : dst.reason, "2027-03-14T13:00");
}

part("Readers without a zone");
{
  const p = plan("2026-11-20", [null, "Mars/Olympus", "Asia/Tokyo"], "America/Sao_Paulo");
  if (!p.ok) is("planned", p.reason, "ok");
  else {
    is("missing and made-up zones use the creator's zone", p.groups.map((g) => [iso(g.at), g.zones, g.readers]), [["2026-11-20T00:00", ["Asia/Tokyo"], 1], ["2026-11-20T12:00", ["America/Sao_Paulo"], 2]]);
    is("and the plan counts them", p.storeZoneReaders, 2);
    is("the scheduler says it in words, in the creator's time", planWords(p, "America/Sao_Paulo"), "It goes out in 2 groups, from Thu, Nov 19, 9:00 PM GMT-3 to Fri, Nov 20, 9:00 AM GMT-3, your time. 2 readers have no time zone we know, so they get it at 9:00 AM your time.");
  }
  const one = plan("2026-11-20", ["America/New_York"]);
  is("one group says one time", one.ok ? planWords(one, "America/New_York") : one.reason, "It goes out at Fri, Nov 20, 9:00 AM EST.");
  is("the creator's zone must be real", plan("2026-11-20", [null], "Nowhere/Here").ok ? "ok" : "store-zone", "store-zone");
}

part("Bounded");
{
  const every = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  const p = plan("2026-12-01", every);
  is(`every zone there is still makes at most ${MAX_GROUPS} groups`, p.ok ? p.groups.length <= MAX_GROUPS && p.groups.length > 20 : p.reason, true);
  is("groups are in time order", p.ok ? p.groups.every((g, i) => i === 0 || p.groups[i - 1].at < g.at) : false, true);
}

part("The whole day must still be ahead");
{
  const at = Date.UTC(2026, 10, 12, 19, 0); // 9:00 on 13 November in UTC+14
  const today = plan("2026-11-13", ["Pacific/Kiritimati", "America/New_York"], "America/New_York", at);
  is("13 November's 9:00 in UTC+14 is here: refused, with the first day that works", today, { ok: false, reason: "past", firstDay: "2026-11-14" });
  is("with no one in UTC+14 the same day is still fine", plan("2026-11-13", ["America/New_York"], "America/New_York", at).ok, true);
  const justEnough = Date.UTC(2026, 10, 13, 19, 0) - MIN_LEAD_MS; // the first group exactly MIN_LEAD_MS away
  is(`exactly ${MIN_LEAD_MS / 60000} minutes before the first group is fine`, plan("2026-11-14", ["Pacific/Kiritimati"], "America/New_York", justEnough).ok, true);
  is("a minute later is not", plan("2026-11-14", ["Pacific/Kiritimati"], "America/New_York", justEnough + 60_000).ok, false);
  is("a day that is not one", [plan("2026-02-30", []), plan("20-11-2026", []), plan("2026-11-20T09:00", [])].map((p) => (p.ok ? "ok" : p.reason)), ["day", "day", "day"]);
  is("more than a year ahead", plan("2028-01-01", ["America/New_York"]).ok ? "ok" : "far", "far");
  is("every refusal has its words", Object.values(PLAN_PROBLEMS).every((w) => w.length > 15), true);
  is(`the hour is ${DELIVERY_HOUR}:00`, DELIVERY_HOUR, 9);
}

done();
