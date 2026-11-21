/**
 * Reviews of #3339 (Claude 3, cost; Claude 2, focal return): what the booking
 * page and the bill see when a creator's own calendar cannot be read.
 *
 * Held here, with synthetic files only:
 *   - a calendar whose busy times are not known blocks its whole window: a
 *     file refused as too complex at once, and a calendar that stopped
 *     answering once its last good reading is older than STALE_SECONDS. The
 *     creator's own busy hour is never offered, at any step;
 *   - one event whose repeat rule is beyond the per-rule caps blocks from its
 *     first time to the end of the window, and the rest of the file is read;
 *   - a failure is kept CACHE_SECONDS, as a good reading is, and a refused
 *     file that has not changed (its DTSTAMP lines aside, which name only when
 *     the file was made) is fetched again but never parsed again;
 *   - zone names are canonical before the formatter cache, so spellings of one
 *     zone build one formatter.
 *
 * Network: none. Names resolve to a public stand-in address and every socket
 * goes to a local plain server (the LocalAgent pattern of
 * tests/ics-file-budget.test.ts).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import "./redis-stub";
import { advance, store as redis } from "./redis-stub";
import { addFeed, calendarBusy, CACHE_SECONDS, STALE_SECONDS } from "@/lib/calendar-sync";
import { type Busy, type CallSetup, isOpenSlot, readSetup } from "@/lib/call-setup";
import { parseIcs } from "@/lib/ics-parse";
import { claimHandle, ensureStatsId, type Store } from "@/lib/store";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
const calendar = (events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//unread-window//EN\r\n${events.join("")}END:VCALENDAR\r\n`;
const vevent = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

// Monday 9 November 2026, noon UTC.
const now0 = Date.UTC(2026, 10, 9, 12);
// The creator's own busy hour: Wednesday 11 November, 15:00 UTC.
const ownHour = Date.UTC(2026, 10, 11, 15);
// A free slot before the outside event's first time, and one after it.
const freeEarly = Date.UTC(2026, 10, 16, 10);
const afterOutside = Date.UTC(2026, 10, 25, 10);
const outsideFirst = Date.UTC(2026, 10, 20, 10);

const own = vevent(["UID:own-hour@example.com", `DTSTART:${stamp(ownHour)}`, `DTEND:${stamp(ownHour + HOUR)}`]);
const clean = calendar([own]);
const outside = (rule: string) => vevent(["UID:outside@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", `RRULE:${rule}`]);
const wideInterval = calendar([own, outside("FREQ=WEEKLY;INTERVAL=2000000")]);
const manyDays = calendar([own, outside(`FREQ=WEEKLY;BYDAY=${Array.from({ length: 401 }, () => "MO").join(",")}`)]);
// Over the whole-file work budget: 500 events repeating daily in New York time, each stamped with when the file
// was made (DTSTAMP), as calendar services stamp every export.
const crowdedAt = (made: string) => calendar([
  own,
  ...Array.from({ length: 500 }, (_, i) => vevent([`UID:c${i}@example.com`, `DTSTAMP:${made}`, "DTSTART;TZID=America/New_York:20261101T090000", "DURATION:PT30M", "RRULE:FREQ=DAILY"])),
]);
const crowded = crowdedAt("20261109T120000Z");

// Every day 9:00 to 17:00 UTC, one-hour slots, 90 days ahead.
const EVERY_DAY: [number, number][][] = Array.from({ length: 7 }, () => [[540, 1020]]);
const setup = readSetup({ kind: "weekly", minutes: 60, tz: "UTC", weekly: EVERY_DAY, noticeHours: 1, horizonDays: 90, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;

/** What each path serves, and how many times it was fetched. */
const served = new Map<string, { status: number; body: string }>();
const fetches = new Map<string, number>();
const server = http.createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  fetches.set(path, (fetches.get(path) ?? 0) + 1);
  const answer = served.get(path) ?? { status: 404, body: "" };
  response.statusCode = answer.status;
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.end(answer.body);
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

// Counts of formatter work: formatToParts runs once for each local time a parse converts in a named zone, and
// partsIn's own formatters are the only ones built with hourCycle "h23".
const Original = Intl.DateTimeFormat;
const originalParts = Original.prototype.formatToParts;
let partsCalls = 0;
let clockFormatters = 0;
Original.prototype.formatToParts = function (this: Intl.DateTimeFormat, date?: Date | number) {
  partsCalls += 1;
  return originalParts.call(this, date);
};
class Counting extends Original {
  constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    super(locales, options);
    if (options?.hourCycle === "h23") clockFormatters += 1;
  }
}
(Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Counting;

let clock = now0;
function step(ms: number): number {
  advance(ms);
  clock += ms;
  return clock;
}

async function shopFor(name: string): Promise<Store> {
  const email = `${name}@example.com`;
  const claimed = await claimHandle(email, name, name, "");
  if (!claimed.ok) throw new Error(`setup: ${name} not claimed`);
  const store = await ensureStatsId(email);
  if (!store?.statsId) throw new Error(`setup: ${name} has no stats id`);
  return store;
}
const offered = (busy: Busy[], at: number, now: number) => isOpenSlot(setup, now, busy, at);

async function main(): Promise<void> {
  redis.clear();
  advance(0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) };
  const urlOf = (path: string) => `https://calendar.unread.example.org${path}`;

  part("setup");
  is("setup: the weekly call setup reads", typeof setup === "object" && setup.kind === "weekly", true);
  is("setup: on an empty calendar the creator's hour, the early slot and the late slot are offered", [ownHour, freeEarly, afterOutside].map((at) => offered([], at, now0)), [true, true, true]);

  // ---- One outside event with a rule past the per-rule caps --------------------------------------------------
  for (const [label, file] of [["INTERVAL=2000000", wideInterval], ["401 BYDAY items", manyDays]] as const) {
    part(`One outside event (${label}) joins a calendar already added`);
    clock = now0;
    redis.clear();
    advance(0);
    const path = `/outside-${label.replace(/\W+/g, "-")}.ics`;
    served.set(path, { status: 200, body: clean });
    const store = await shopFor(`unread-${label.replace(/\W+/g, "-").toLowerCase()}`);
    const added = await addFeed(store, urlOf(path), clock, hooks);
    is("setup: the clean calendar is added", added.ok, true);
    const first = await calendarBusy(store, clock, hooks);
    is("setup: the creator's hour is not offered", offered(first.busy, ownHour, clock), false);

    served.set(path, { status: 200, body: file });
    let later = step(11 * MINUTE);
    let read = await calendarBusy(store, later, hooks);
    is("11 minutes later: the file is read, not refused (no calendar failing)", read.failing, 0);
    is("11 minutes later: the creator's hour is not offered", offered(read.busy, ownHour, later), false);
    is("11 minutes later: the slot before the outside event's first time is offered", offered(read.busy, freeEarly, later), true);
    is("11 minutes later: a slot after the outside event's first time is not offered (its times are not known)", offered(read.busy, afterOutside, later), false);

    later = step(6 * HOUR + MINUTE);
    read = await calendarBusy(store, later, hooks);
    is("6 h 12 min later: the creator's hour is still not offered", offered(read.busy, ownHour, later), false);
    is("6 h 12 min later: a slot after the outside event's first time is still not offered", offered(read.busy, afterOutside, later), false);
  }

  // ---- A file refused as a whole ---------------------------------------------------------------------------
  part("A calendar that turns too complex blocks its whole window, at once and after STALE_SECONDS");
  clock = now0;
  redis.clear();
  advance(0);
  served.set("/crowded.ics", { status: 200, body: clean });
  const crowdedStore = await shopFor("unread-crowded");
  is("setup: the clean calendar is added", (await addFeed(crowdedStore, urlOf("/crowded.ics"), clock, hooks)).ok, true);
  served.set("/crowded.ics", { status: 200, body: crowded });
  let t = step(11 * MINUTE);
  let fetched = fetches.get("/crowded.ics") ?? 0;
  partsCalls = 0;
  let read = await calendarBusy(crowdedStore, t, hooks);
  const parsedFirst = partsCalls;
  is("11 minutes later: the refusal counts as one failing calendar", read.failing, 1);
  is("11 minutes later: the creator's hour is not offered", offered(read.busy, ownHour, t), false);
  is("11 minutes later: no slot of the window is offered (the busy times are not known)", [freeEarly, afterOutside].map((at) => offered(read.busy, at, t)), [false, false]);
  is("setup: the refused file was fetched once and parsed (formatter work spent)", [(fetches.get("/crowded.ics") ?? 0) - fetched, parsedFirst > 1_000], [1, true]);

  part("A refusal is kept CACHE_SECONDS, as a good reading is");
  fetched = fetches.get("/crowded.ics") ?? 0;
  t = step(121 * 1000);
  read = await calendarBusy(crowdedStore, t, hooks);
  is("121 s later: not fetched again", (fetches.get("/crowded.ics") ?? 0) - fetched, 0);
  is("121 s later: the creator's hour is still not offered", offered(read.busy, ownHour, t), false);

  part("An unchanged refused file is fetched again after CACHE_SECONDS but not parsed again");
  fetched = fetches.get("/crowded.ics") ?? 0;
  t = step(CACHE_SECONDS * 1000);
  partsCalls = 0;
  read = await calendarBusy(crowdedStore, t, hooks);
  is("fetched once", (fetches.get("/crowded.ics") ?? 0) - fetched, 1);
  is("no formatter work: the same file is not parsed again", partsCalls, 0);
  is("still failing, the creator's hour and the window still not offered", [read.failing, offered(read.busy, ownHour, t), offered(read.busy, freeEarly, t)], [1, false, false]);

  part("A file made again with only its DTSTAMP lines changed is not parsed again either");
  served.set("/crowded.ics", { status: 200, body: crowdedAt("20261109T123100Z") });
  fetched = fetches.get("/crowded.ics") ?? 0;
  t = step(CACHE_SECONDS * 1000 + 5_000);
  partsCalls = 0;
  read = await calendarBusy(crowdedStore, t, hooks);
  is("fetched once, with no formatter work", [(fetches.get("/crowded.ics") ?? 0) - fetched, partsCalls], [1, 0]);
  is("still failing, the window still closed", [read.failing, offered(read.busy, ownHour, t), offered(read.busy, freeEarly, t)], [1, false, false]);

  part("A changed file is parsed again");
  served.set("/crowded.ics", { status: 200, body: `${crowded}\r\n` });
  t = step(CACHE_SECONDS * 1000 + 5_000);
  partsCalls = 0;
  read = await calendarBusy(crowdedStore, t, hooks);
  is("formatter work spent: a different file is read", partsCalls > 1_000, true);
  is("and, still too complex, it keeps the window closed", [read.failing, offered(read.busy, ownHour, t)], [1, false]);

  part("6 h 01 min after the last good reading the window is still closed");
  t = step(STALE_SECONDS * 1000 + MINUTE);
  read = await calendarBusy(crowdedStore, t, hooks);
  is("the creator's hour is not offered", offered(read.busy, ownHour, t), false);
  is("no slot of the window is offered", offered(read.busy, freeEarly, t), false);

  part("A calendar that does a good reading again opens its free times again");
  served.set("/crowded.ics", { status: 200, body: clean });
  t = step(CACHE_SECONDS * 1000 + 5_000);
  read = await calendarBusy(crowdedStore, t, hooks);
  is("no calendar failing, the creator's hour closed, the free slot offered", [read.failing, offered(read.busy, ownHour, t), offered(read.busy, freeEarly, t)], [0, false, true]);

  // ---- A calendar that stops answering ---------------------------------------------------------------------
  part("A calendar that stops answering: its last good reading for STALE_SECONDS, then the window closed");
  clock = now0;
  redis.clear();
  advance(0);
  served.set("/broken.ics", { status: 200, body: clean });
  const brokenStore = await shopFor("unread-broken");
  is("setup: the clean calendar is added", (await addFeed(brokenStore, urlOf("/broken.ics"), clock, hooks)).ok, true);
  served.set("/broken.ics", { status: 500, body: "" });
  t = step(11 * MINUTE);
  read = await calendarBusy(brokenStore, t, hooks);
  is("11 minutes later: failing, its last good reading used (the creator's hour closed, the free slot offered)", [read.failing, offered(read.busy, ownHour, t), offered(read.busy, freeEarly, t)], [1, false, true]);
  fetched = fetches.get("/broken.ics") ?? 0;
  t = step(121 * 1000);
  await calendarBusy(brokenStore, t, hooks);
  is("121 s later: not fetched again (a failure is kept CACHE_SECONDS)", (fetches.get("/broken.ics") ?? 0) - fetched, 0);
  t = step(STALE_SECONDS * 1000 + MINUTE);
  read = await calendarBusy(brokenStore, t, hooks);
  is("6 h 01 min later: the creator's hour is not offered", offered(read.busy, ownHour, t), false);
  is("6 h 01 min later: no slot of the window is offered (its busy times are not known)", offered(read.busy, freeEarly, t), false);

  // ---- Zone names ------------------------------------------------------------------------------------------
  part("Spellings of one zone build one formatter, and the zone read is its canonical name");
  {
    const base = "America/New_York";
    const spellings = new Set<string>();
    for (let i = 0; spellings.size < 700; i += 1) {
      spellings.add([...base].map((ch, k) => ((i >> k) & 1 ? ch.toUpperCase() : ch.toLowerCase())).join(""));
    }
    const names = [...spellings];
    const events = (zoneOf: (i: number) => string) => Array.from({ length: 2_000 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 10, 10) + (i % 60) * DAY);
      const ymd = `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}`;
      return vevent([`UID:z${i}@example.com`, `DTSTART;TZID=${zoneOf(i)}:${ymd}T${pad(8 + (i % 9))}0000`, "DURATION:PT20M"]);
    });
    const window = { from: now0 - DAY, to: now0 + 120 * DAY, fallbackTz: "UTC" };
    const canonicalRead = parseIcs(calendar(events(() => base)), window);
    clockFormatters = 0;
    const spelled = parseIcs(`BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:aMeRiCa/nEw_yOrK\r\n${events((i) => names[i % names.length]).join("")}END:VCALENDAR\r\n`, window);
    console.log(`        ${names.length} spellings, formatters built for local times: ${clockFormatters}`);
    is("setup: 700 spellings", names.length, 700);
    is("the same busy times as with the canonical name", spelled.busy, canonicalRead.busy);
    is("at most one formatter built for local times (one zone)", clockFormatters <= 1, true);
    is("the calendar's zone is read as its canonical name", spelled.zone, base);
  }

  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Original;
  Original.prototype.formatToParts = originalParts;
  server.close();
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
