/**
 * R27 finding 1 (HIGH): a calendar file's parse had no budget for the whole
 * file. MAX_STEPS (5,000) was per repeating event, a repeat with COUNT (and
 * every MONTHLY or YEARLY one) was walked from its first date, and each step
 * built a new Intl.DateTimeFormat (lib/call-setup.ts partsIn). A 1,150-byte
 * file held the function's only thread for 3.3 s, and the 2 MB cap allowed
 * hours. The same cap also cut a long repeat short without a word: its times
 * in the window were dropped, so a booking could be offered on top of them.
 *
 * Held here, with synthetic files only:
 *   - the R27 proof (a 1 KB file, the studio's addFeed path, a MONTHLY repeat
 *     from 1600) finishes fast, and the parse reports the work it spent;
 *   - a repeat that began long ago, with or without COUNT, starts close to the
 *     window and gives exactly the times the slow walk gives
 *     (tests/ics-walk-reference.ts), with EXDATE, RDATE, RECURRENCE-ID, UNTIL,
 *     clock changes in America/New_York and Europe/Berlin, all-day times,
 *     the 29th/30th/31st and February 29;
 *   - a file that needs more work than the budget is refused as unreadable
 *     (CalendarTooComplex): readFeed throws, addFeed refuses and saves nothing,
 *     and calendarBusy keeps the last good reading, as for any unreadable file;
 *   - a repeat that cannot be walked to the end of the window within its own
 *     cap makes the file unreadable instead of silently shorter;
 *   - partsIn answers exactly as a new formatter would.
 *
 * Network: none. Names resolve to a public stand-in address and every socket
 * goes to a local plain server (the LocalAgent pattern of
 * tests/email-sync-exact-view.test.ts).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import "./redis-stub";
import { advance, store as redis } from "./redis-stub";
import { addFeed, calendarBusy, CACHE_SECONDS, readFeed } from "@/lib/calendar-sync";
import { partsIn } from "@/lib/call-setup";
import * as ics from "@/lib/ics-parse";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { walkIcs } from "./ics-walk-reference";
import { done, is, part } from "./check";

// Read through a plain record so this file also builds against the parser
// before the fix (the RED commit), where these names did not exist yet.
const named = ics as unknown as Record<string, unknown>;
const TooComplex = named.CalendarTooComplex as (new (...args: never[]) => Error) | undefined;
const MAX_WORK = named.ICS_MAX_WORK as number | undefined;
const isTooComplex = (error: unknown) => Boolean(TooComplex) && error instanceof (TooComplex as new () => Error);

type Parsed = ics.ParsedCalendar & { work?: number };
const DAY = 86_400_000;
const LOOKAHEAD = 120;
const window = (now: number) => ({ from: now - DAY, to: now + LOOKAHEAD * DAY, fallbackTz: "UTC", maxIntervals: 1_000_000 });

function calendar(events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//r27//EN\r\n${events.join("")}END:VCALENDAR\r\n`;
}
function vevent(lines: string[]): string {
  return `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;
}
/** What a reading says about the times, for comparing two readers. */
const shape = (p: Pick<ics.ParsedCalendar, "busy" | "events" | "unsupported" | "truncated" | "zone">) => ({ busy: p.busy, events: p.events, unsupported: p.unsupported, truncated: p.truncated, zone: p.zone });

function tryParse(text: string, options: ReturnType<typeof window>): { parsed: Parsed | null; error: unknown } {
  try {
    return { parsed: ics.parseIcs(text, options) as Parsed, error: null };
  } catch (error) {
    return { parsed: null, error };
  }
}

// ---- The R27 proof, kept ----------------------------------------------------

const OWNER = "r27-ics-owner@example.com";
const EVENTS = 6;
function heavyIcs(events: number): string {
  return calendar(Array.from({ length: events }, (_, i) => vevent([
    `UID:r27-${i}@example.com`,
    "DTSTART;TZID=America/New_York:19000101T090000",
    "DTEND;TZID=America/New_York:19000101T100000",
    "RRULE:FREQ=DAILY;COUNT=9999",
    "SUMMARY:x",
  ])));
}

let served = heavyIcs(EVENTS);
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.end(served);
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

/** A seeded generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) };
  const now = Date.UTC(2026, 10, 9, 12);
  const url = "https://calendar.r27.example.org/cal.ics";

  part(`R27 proof: a ${served.length}-byte calendar (${EVENTS} events, COUNT=9999 from 1900)`);
  let t = Date.now();
  const reading = await readFeed(url, "UTC", now, hooks);
  const readMs = Date.now() - t;
  console.log(`        readFeed took ${readMs} ms (busy ${reading.busy.length}, truncated ${reading.truncated})`);
  is("readFeed of a 1 KB calendar finishes in under 1,500 ms", readMs < 1_500, true);
  is("its times all ended in 1927, so nothing in the window is busy", reading.busy, []);
  const proof = ics.parseIcs(served, window(now)) as Parsed;
  is("the parse reports the work it spent, and it is a few units per event (not thousands of steps)", typeof proof.work === "number" && proof.work <= EVENTS * 20, true);

  part("The studio path: addFeed (the route's only work) runs the same parse before answering");
  const claimed = await claimHandle(OWNER, "r27-ics", "R27 ICS", "");
  is("setup: a store without a plan was made", claimed.ok, true);
  const store = await ensureStatsId(OWNER);
  is("setup: it has a stats id", Boolean(store?.statsId), true);
  t = Date.now();
  const added = await addFeed(store!, url, now, hooks);
  const addMs = Date.now() - t;
  console.log(`        addFeed took ${addMs} ms, answered ok=${added.ok}`);
  is("addFeed of a 1 KB calendar finishes in under 1,500 ms and is added", [addMs < 1_500, added.ok], [true, true]);

  part("No COUNT needed: a MONTHLY repeat that began in 1600");
  const monthly = calendar(Array.from({ length: 3 }, (_, i) => vevent([
    `UID:m${i}`, "DTSTART;TZID=Europe/Berlin:16000101T090000", "DTEND;TZID=Europe/Berlin:16000101T100000", "RRULE:FREQ=MONTHLY",
  ])));
  t = Date.now();
  const monthlyRead = ics.parseIcs(monthly, window(now)) as Parsed;
  const monthlyMs = Date.now() - t;
  console.log(`        parseIcs of ${monthly.length} bytes took ${monthlyMs} ms, work ${monthlyRead.work}`);
  is("a 3-event, ~400-byte calendar parses in under 500 ms", monthlyMs < 500, true);
  is("and its times in the window are there (the 5,000-step cap used to stop it in 2016)", monthlyRead.busy.length, 4);
  is("the same times as the slow walk", shape(monthlyRead), shape(walkIcs(monthly, window(now))));
  is("in a few dozen units of work", typeof monthlyRead.work === "number" && monthlyRead.work <= 3 * 40, true);

  part("A long COUNT is never cut short: DAILY COUNT=99999 from 1900 is busy every day of the window");
  const longCount = calendar([vevent(["UID:long", "DTSTART;TZID=America/New_York:19000101T090000", "DTEND;TZID=America/New_York:19000101T100000", "RRULE:FREQ=DAILY;COUNT=99999"])]);
  const longRead = ics.parseIcs(longCount, window(now)) as Parsed;
  is("one busy hour for each of the 121 days", longRead.busy.length, 121);
  is("the same times as the slow walk", shape(longRead), shape(walkIcs(longCount, window(now))));

  // ---- Exactness against the slow walk ---------------------------------------

  part("Exact: targeted repeats, each against the slow walk");
  const nowWinter = Date.UTC(2027, 1, 20, 12); // window holds 14 March (US) and 28 March (EU) 2027
  const nowAutumn = Date.UTC(2026, 8, 15, 12); // window holds 25 October (EU) and 1 November (US) 2026
  const nowLeap = Date.UTC(2028, 1, 1, 12); // window holds 29 February 2028
  const targeted: { name: string; now: number; lines: string[] }[] = [
    { name: "New York 02:30 daily, COUNT, over the skipped hour of 14 March 2027", now: nowWinter, lines: ["DTSTART;TZID=America/New_York:20000312T023000", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=20000"] },
    { name: "New York 01:30 Sundays, COUNT, over the repeated hour of 1 November 2026", now: nowAutumn, lines: ["DTSTART;TZID=America/New_York:20011104T013000", "DTEND;TZID=America/New_York:20011104T023000", "RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=5000"] },
    { name: "Berlin 02:30 weekly MO,WE,FR every 3 weeks, COUNT, over 28 March 2027", now: nowWinter, lines: ["DTSTART;TZID=Europe/Berlin:19990301T023000", "DURATION:PT90M", "RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,WE,FR;WKST=SU;COUNT=4000"] },
    { name: "daily on weekdays every 2 days, COUNT", now: nowWinter, lines: ["DTSTART;TZID=America/New_York:19950105T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;COUNT=4300"] },
    { name: "monthly on the 31st from 1900, COUNT", now, lines: ["DTSTART;TZID=America/New_York:19000131T100000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;COUNT=1000"] },
    { name: "monthly on the 31st every 2 months from 1850, no COUNT", now, lines: ["DTSTART;TZID=Europe/Berlin:18500131T100000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;INTERVAL=2"] },
    { name: "monthly on the 30th every 13 months, COUNT", now, lines: ["DTSTART:17000330T100000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;INTERVAL=13;COUNT=300"] },
    { name: "all-day monthly on the 29th from 1700, COUNT, two days long", now: nowLeap, lines: ["DTSTART;VALUE=DATE:17000129", "DTEND;VALUE=DATE:17000131", "RRULE:FREQ=MONTHLY;COUNT=3850"] },
    { name: "yearly on 29 February from 1704, no COUNT", now: nowLeap, lines: ["DTSTART;TZID=America/New_York:17040229T120000", "DURATION:PT2H", "RRULE:FREQ=YEARLY"] },
    { name: "yearly on 29 February every 3 years from 1704, COUNT", now: nowLeap, lines: ["DTSTART;TZID=America/New_York:17040229T120000", "DURATION:PT2H", "RRULE:FREQ=YEARLY;INTERVAL=3;COUNT=40"] },
    { name: "yearly every 2 years on 15 March, COUNT", now: nowWinter, lines: ["DTSTART;TZID=America/New_York:15010315T020000", "DURATION:PT1H", "RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=264"] },
    { name: "UNTIL among the skipped times, with COUNT", now, lines: ["DTSTART:19900101T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=99999;UNTIL=20000101T000000Z"] },
    { name: "UNTIL inside the window, with COUNT", now, lines: ["DTSTART:19900101T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=99999;UNTIL=20261201T000000Z"] },
    {
      name: "EXDATE, RDATE and a moved time inside the window, with COUNT",
      now,
      lines: [
        "UID:moved@example.com",
        "DTSTART;TZID=America/New_York:19980105T140000",
        "DURATION:PT1H",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4000",
        "EXDATE;TZID=America/New_York:20261116T140000,20261119T140000",
        "RDATE;TZID=America/New_York:20261121T080000",
      ],
    },
  ];
  for (const c of targeted) {
    const extra = c.name.startsWith("EXDATE")
      ? [vevent(["UID:moved@example.com", "RECURRENCE-ID;TZID=America/New_York:20261123T140000", "DTSTART;TZID=America/New_York:20261123T180000", "DURATION:PT1H"])]
      : [];
    const text = calendar([vevent([...(c.lines[0].startsWith("UID:") ? [] : ["UID:t@example.com"]), ...c.lines]), ...extra]);
    const { parsed, error } = tryParse(text, window(c.now));
    is(`${c.name}: same times as the slow walk`, parsed ? shape(parsed) : String(error), shape(walkIcs(text, window(c.now))));
  }

  part("Exact: COUNT values on both sides of the window's edge, against the slow walk");
  {
    // Monthly on the 29th from 1700 and yearly on 29 February: every COUNT
    // whose last time falls just before, inside or after the window.
    let same = 0;
    let total = 0;
    for (let count = 3835; count <= 3870; count += 1) {
      const text = calendar([vevent(["UID:c29", "DTSTART;TZID=America/New_York:17000129T090000", "DURATION:PT1H", `RRULE:FREQ=MONTHLY;COUNT=${count}`])]);
      const { parsed } = tryParse(text, window(nowLeap));
      total += 1;
      if (parsed && JSON.stringify(shape(parsed)) === JSON.stringify(shape(walkIcs(text, window(nowLeap))))) same += 1;
    }
    for (let count = 70; count <= 82; count += 1) {
      const text = calendar([vevent(["UID:f29", "DTSTART;TZID=Europe/Berlin:17040229T090000", "DURATION:PT1H", `RRULE:FREQ=YEARLY;COUNT=${count}`])]);
      const { parsed } = tryParse(text, window(nowLeap));
      total += 1;
      if (parsed && JSON.stringify(shape(parsed)) === JSON.stringify(shape(walkIcs(text, window(nowLeap))))) same += 1;
    }
    for (let count = 11_660; count <= 11_700; count += 4) {
      const text = calendar([vevent(["UID:d", "DTSTART;TZID=America/New_York:19950201T233000", "DURATION:PT1H", `RRULE:FREQ=DAILY;COUNT=${count}`])]);
      const { parsed } = tryParse(text, window(now));
      total += 1;
      if (parsed && JSON.stringify(shape(parsed)) === JSON.stringify(shape(walkIcs(text, window(now))))) same += 1;
    }
    is(`all ${total} COUNT values give the slow walk's times`, same, total);
  }

  part("Exact: 160 random repeats (seeded), against the slow walk");
  {
    const rand = random(27_001);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const nows = [now, nowWinter, nowAutumn, nowLeap];
    const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    const mismatches: string[] = [];
    const CASES = 160;
    for (let i = 0; i < CASES; i += 1) {
      const freq = pick(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const);
      const at = pick(nows);
      const kind = pick(["ny", "berlin", "utc", "floating", "allday"] as const);
      const firstYear = freq === "DAILY" || freq === "WEEKLY" ? 1995 + Math.floor(rand() * 33) : freq === "MONTHLY" ? 1800 + Math.floor(rand() * 228) : 1700 + Math.floor(rand() * 328);
      const month = freq === "YEARLY" && rand() < 0.3 ? 2 : 1 + Math.floor(rand() * 12);
      const day = freq === "YEARLY" && month === 2 && rand() < 0.6 ? 29 : freq === "MONTHLY" && rand() < 0.5 ? 28 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 28);
      const hour = rand() < 0.2 ? 2 : Math.floor(rand() * 24);
      const minute = pick([0, 30]);
      const date = `${pad(firstYear, 4)}${pad(month)}${pad(day)}`;
      const time = `T${pad(hour)}${pad(minute)}00`;
      const zoneParam = kind === "ny" ? ";TZID=America/New_York" : kind === "berlin" ? ";TZID=Europe/Berlin" : "";
      const lines = [`UID:r${i}@example.com`];
      if (kind === "allday") {
        lines.push(`DTSTART;VALUE=DATE:${date}`, `DURATION:P${1 + Math.floor(rand() * 3)}D`);
      } else {
        lines.push(`DTSTART${zoneParam}:${date}${time}${kind === "utc" ? "Z" : ""}`, `DURATION:PT${pick([30, 60, 90, 180])}M`);
      }
      const rule = [`FREQ=${freq}`];
      const interval = pick([1, 1, 1, 2, 3, 4, 5, 7, 12, 13]);
      if (interval > 1) rule.push(`INTERVAL=${interval}`);
      if ((freq === "WEEKLY" && rand() < 0.5) || (freq === "DAILY" && rand() < 0.2)) {
        const chosen = days.filter(() => rand() < 0.4);
        if (chosen.length) rule.push(`BYDAY=${chosen.join(",")}`);
      }
      if (freq === "WEEKLY" && rand() < 0.3) rule.push(`WKST=${pick(days)}`);
      if (rand() < 0.6) rule.push(`COUNT=${Math.max(1, Math.round(Math.exp(rand() * Math.log(100_000))))}`);
      if (rand() < 0.15) rule.push(`UNTIL=${ymd(at + (rand() - 0.3) * 200 * DAY)}T000000Z`);
      lines.push(`RRULE:${rule.join(";")}`);
      if (rand() < 0.35) {
        const stamps = Array.from({ length: 3 }, () => ymd(at + Math.floor(rand() * 120) * DAY));
        lines.push(kind === "allday" ? `EXDATE;VALUE=DATE:${stamps.join(",")}` : `EXDATE${zoneParam}:${stamps.map((s) => `${s}${time}${kind === "utc" ? "Z" : ""}`).join(",")}`);
      }
      if (rand() < 0.2) {
        const stamp = ymd(at + Math.floor(rand() * 120) * DAY);
        lines.push(kind === "allday" ? `RDATE;VALUE=DATE:${stamp}` : `RDATE${zoneParam}:${stamp}${time}${kind === "utc" ? "Z" : ""}`);
      }
      const text = calendar([vevent(lines)]);
      const options = { ...window(at), fallbackTz: "America/New_York" };
      const { parsed, error } = tryParse(text, options);
      const want = JSON.stringify(shape(walkIcs(text, options)));
      const got = parsed ? JSON.stringify(shape(parsed)) : `threw ${String(error)}`;
      if (got !== want) mismatches.push(`case ${i}: ${lines.slice(1).join(" | ")}\n          got  ${got.slice(0, 300)}\n          want ${want.slice(0, 300)}`);
    }
    if (mismatches.length) console.log(`        first mismatches:\n        ${mismatches.slice(0, 3).join("\n        ")}`);
    is(`all ${CASES} random repeats give the slow walk's times`, mismatches.length, 0);
  }

  part("Rules that never land on a day give nothing, at once, without a throw");
  {
    const never = calendar([
      vevent(["UID:n1", "DTSTART:20240101T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=TU"]), // 1 January 2024 is a Monday
      vevent(["UID:n2", "DTSTART:20200231T090000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;INTERVAL=12"]), // "31 February" every year
      vevent(["UID:n3", "DTSTART:20250229T090000Z", "DURATION:PT1H", "RRULE:FREQ=YEARLY;INTERVAL=4"]), // "29 February" of 2025, 2029, ...
    ]);
    const { parsed, error } = tryParse(never, window(now));
    is("no busy time and no refusal", [parsed?.busy ?? null, error === null], [[], true]);
    is("in a few units of work, not three caps of 5,000 steps", typeof parsed?.work === "number" && parsed.work <= 30, true);
  }

  // ---- The budget ----------------------------------------------------------------

  part("A file that needs more work than its budget is refused as unreadable");
  is("the budget is a named whole-file number", typeof MAX_WORK === "number" && MAX_WORK >= 50_000 && MAX_WORK <= 200_000, true);
  const crowded = calendar(Array.from({ length: 500 }, (_, i) => vevent([
    `UID:c${i}@example.com`, "DTSTART;TZID=America/New_York:20261101T090000", "DURATION:PT30M", "RRULE:FREQ=DAILY",
  ])));
  console.log(`        ${crowded.length} bytes, 500 events repeating daily inside the window`);
  t = Date.now();
  const crowdedRead = tryParse(crowded, window(now));
  const crowdedMs = Date.now() - t;
  console.log(`        parseIcs answered in ${crowdedMs} ms`);
  is("parseIcs throws CalendarTooComplex instead of returning a partial reading", [crowdedRead.parsed === null, isTooComplex(crowdedRead.error)], [true, true]);
  is("with a sentence the creator can act on", crowdedRead.error instanceof Error && /too (large|many)|repeating/i.test(crowdedRead.error.message), true);

  served = crowded;
  const readRefused = await readFeed(url, "UTC", now, hooks).then(() => null, (error: unknown) => error);
  is("readFeed rejects with it (the way it rejects any file it cannot read)", isTooComplex(readRefused), true);
  const second = await addFeed(store!, "https://calendar2.r27.example.org/cal.ics", now, hooks);
  is("addFeed refuses it, saving nothing", [second.ok, second.ok ? null : second.reason, second.ok ? "" : second.message === (crowdedRead.error as Error | null)?.message], [false, "invalid", true]);

  part("A saved calendar that turns too complex keeps its last good reading, as any unreadable one does");
  served = calendar([vevent(["UID:good@example.com", "DTSTART;TZID=America/New_York:20261110T090000", "DURATION:PT1H"])]);
  const good = await addFeed(store!, "https://calendar3.r27.example.org/cal.ics", now, hooks);
  is("setup: a light calendar is added with its one busy time", [good.ok, good.ok ? good.busyTimes : -1], [true, 1]);
  served = crowded;
  advance((CACHE_SECONDS + 5) * 1000);
  const later = now + (CACHE_SECONDS + 5) * 1000;
  const busyLater = await calendarBusy(store!, later, hooks);
  const lastGood = Date.UTC(2026, 10, 10, 14);
  // Both saved calendars (the R27 one and this one) now answer with the crowded file.
  is("the refusal counts as a failing calendar, for each of the two saved ones", busyLater.failing, 2);
  is("and the last good busy time still blocks (no partial reading replaced it)", busyLater.busy.some((b) => b.start === lastGood && b.end === lastGood + 3_600_000), true);

  part("A repeat that cannot be walked to the window within its own cap makes the file unreadable, never shorter");
  {
    // Fifteen-year-long times, daily, COUNT so large it reaches past the window:
    // every one that overlaps the window starts in the last fifteen years, more
    // than the 5,000 steps one event may take. The old cap stopped in 2003 and
    // the window came back free.
    const endless = calendar([vevent(["UID:e", "DTSTART:19900101T000000Z", "DTEND:20050101T000000Z", "RRULE:FREQ=DAILY;COUNT=99999"])]);
    const { parsed, error } = tryParse(endless, window(now));
    is("refused as too complex, not read as free", [parsed === null, isTooComplex(error)], [true, true]);
  }

  part("A long history of single events stays well inside the budget");
  {
    const history = calendar(Array.from({ length: 6000 }, (_, i) => {
      const startMs = Date.UTC(2010, 0, 1, 15) + i * DAY;
      const d = new Date(startMs);
      const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T100000`;
      return vevent([`UID:h${i}@example.com`, `DTSTART;TZID=America/New_York:${stamp}`, "DURATION:PT1H", "SUMMARY:Lesson"]);
    }));
    const { parsed, error } = tryParse(history, window(now));
    console.log(`        ${history.length} bytes, 6,000 events: work ${parsed?.work}, error ${String(error)}`);
    is("6,000 single events are read", [parsed?.events, error === null], [6000, true]);
    is("using under a third of the budget", typeof parsed?.work === "number" && typeof MAX_WORK === "number" && parsed.work < MAX_WORK / 3, true);
  }

  part("partsIn answers exactly as a new formatter would");
  {
    const zones = ["America/New_York", "Europe/Berlin", "Asia/Kolkata", "Australia/Lord_Howe", "UTC", "america/new_york", "Pacific/Chatham"];
    const instants = [Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 2, 8, 7, 0), Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30), Date.UTC(1900, 0, 1), Date.UTC(2099, 11, 31, 23, 59)];
    let same = 0;
    let total = 0;
    for (let round = 0; round < 2; round += 1) {
      for (const tz of zones) {
        for (const ms of instants) {
          const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(ms));
          const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
          const want = { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
          total += 1;
          if (JSON.stringify(partsIn(ms, tz)) === JSON.stringify(want)) same += 1;
        }
      }
    }
    is(`all ${total} answers match, twice over`, same, total);
    let threw = false;
    try {
      partsIn(0, "Not/AZone");
    } catch {
      threw = true;
    }
    is("an unknown zone still throws, and is not kept", threw, true);
  }

  server.close();
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
