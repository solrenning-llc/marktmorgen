/**
 * A calendar reading cut at its busy-stretch cap must fail closed for booking
 * (follow-up to R27 finding 1, #3339).
 *
 * lib/ics-parse.ts keeps at most `maxIntervals` (2,000) busy stretches. Before
 * this fix it kept the first 2,000 in the order the FILE listed them, dropped
 * the rest and only set `truncated`; lib/calendar-sync.ts (calendarBusy,
 * addFeed) and lib/host-calendar.ts store that reading as a good one. A busy
 * time listed late in the file, even next week, was silently dropped, and the
 * booking page offered a slot the creator's calendar holds busy.
 *
 * Held here, with synthetic files only:
 *   - the cut is by time: every busy stretch before the cutoff is kept, and
 *     everything from the cutoff to the end of the window is one busy stretch,
 *     so no slot whose busy state was not kept is offered;
 *   - a slot before the cutoff that the file shows free is still offered;
 *   - the reading stays at most `maxIntervals` stretches (the stored size);
 *   - stretches are counted after merging, so overlapping copies of one time
 *     are not a cut;
 *   - a file at or under the cap reads exactly as before.
 *
 * Network: none. Names resolve to a public stand-in address and every socket
 * goes to a local plain server (as in tests/ics-file-budget.test.ts).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import "./redis-stub";
import { store as redis } from "./redis-stub";
import { addFeed, calendarBusy, readFeed } from "@/lib/calendar-sync";
import { type CallSetup, isOpenSlot, readSetup } from "@/lib/call-setup";
import { parseIcs } from "@/lib/ics-parse";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
const vevent = (uid: string, start: number, end: number) =>
  `BEGIN:VEVENT\r\nUID:${uid}@example.com\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(end)}\r\nEND:VEVENT\r\n`;
const calendar = (events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//truncated//EN\r\n${events.join("")}END:VCALENDAR\r\n`;

// Monday 9 November 2026, noon UTC.
const now = Date.UTC(2026, 10, 9, 12);
const midnight = (day: number) => Date.UTC(2026, 10, 9 + day);

// 2,000 ten-minute stretches at night (00:00 to 08:00 UTC, every 20 minutes,
// 24 a night) from tomorrow on: days 1 to 84, never touching one another.
const fillers: [number, number][] = [];
for (let i = 0; i < 2_000; i += 1) {
  const start = midnight(1 + Math.floor(i / 24)) + (i % 24) * 20 * MINUTE;
  fillers.push([start, start + 10 * MINUTE]);
}
// Two busy hours inside working hours, listed AFTER the fillers in the file:
// one in two days (early in time), one on day 86 (after the last filler).
const earlyBusy = midnight(2) + 15 * HOUR;
const lateBusy = midnight(86) + 15 * HOUR;
const freeBefore = midnight(5) + 10 * HOUR;
const freeAfter = midnight(87) + 10 * HOUR;
const crowded = calendar([
  ...fillers.map(([s, e], i) => vevent(`filler-${i}`, s, e)),
  vevent("late", lateBusy, lateBusy + HOUR),
  vevent("early", earlyBusy, earlyBusy + HOUR),
]);

// Every day 9:00 to 17:00 UTC, one-hour slots, 90 days ahead.
const EVERY_DAY: [number, number][][] = Array.from({ length: 7 }, () => [[540, 1020]]);
const setup = readSetup({ kind: "weekly", minutes: 60, tz: "UTC", weekly: EVERY_DAY, noticeHours: 1, horizonDays: 90, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;

let served = crowded;
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
const window = { from: now - DAY, to: now + 120 * DAY, fallbackTz: "UTC" };
const covered = (busy: { start: number; end: number }[], at: number) => busy.some((b) => b.start <= at && at < b.end);

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) };

  part("setup");
  is("setup: the weekly call setup reads", typeof setup === "object" && setup.kind === "weekly", true);
  is("setup: the four slots are offered on an empty calendar", [earlyBusy, lateBusy, freeBefore, freeAfter].map((at) => isOpenSlot(setup, now, [], at)), [true, true, true, true]);

  part("parseIcs: a file with 2,002 separate busy stretches, two busy hours listed last");
  const parsed = parseIcs(crowded, window);
  is("it says the reading was cut", parsed.truncated, true);
  is("it keeps at most 2,000 stretches (the stored size is unchanged)", parsed.busy.length <= 2_000, true);
  is("the busy hour in two days, listed last in the file, is kept (the cut is by time, not by file order)", covered(parsed.busy, earlyBusy), true);
  is("the busy hour on day 86, past the cut, is still busy", covered(parsed.busy, lateBusy), true);
  is("a time past the cut that was not kept is busy, not free (its state is unknown)", covered(parsed.busy, freeAfter), true);
  is("a free time before the cut stays free", covered(parsed.busy, freeBefore), false);
  is("every stretch before the cut is kept exactly", fillers.slice(0, 1_900).every(([s, e]) => parsed.busy.some((b) => b.start === s && b.end === e)), true);
  const last = parsed.busy[parsed.busy.length - 1];
  is("the last stretch runs from the cutoff to the end of the window", last ? [last.end >= window.to, last.start > fillers[1_990][0], last.start <= fillers[1_999][0]] : null, [true, true, true]);

  part("readFeed and the booking page (calendarBusy, isOpenSlot)");
  const reading = await readFeed("https://calendar.truncated.example.org/cal.ics", "UTC", now, hooks);
  is("readFeed: the busy hour in two days is in the reading", reading.busy.some(([s, e]) => s <= earlyBusy && earlyBusy < e), true);
  is("readFeed: the busy hour on day 86 is in the reading", reading.busy.some(([s, e]) => s <= lateBusy && lateBusy < e), true);
  const claimed = await claimHandle("ics-truncated-owner@example.com", "ics-truncated", "ICS truncated", "");
  is("setup: a store was made", claimed.ok, true);
  const store = await ensureStatsId("ics-truncated-owner@example.com");
  const added = await addFeed(store!, "https://calendar.truncated.example.org/cal.ics", now, hooks);
  is("addFeed: the calendar is added", added.ok, true);
  const { busy, failing } = await calendarBusy(store!, now, hooks);
  is("calendarBusy: no calendar failing", failing, 0);
  is("the slot in two days that the calendar holds busy is not offered", isOpenSlot(setup, now, busy, earlyBusy), false);
  is("the slot on day 86 that the calendar holds busy is not offered", isOpenSlot(setup, now, busy, lateBusy), false);
  is("a slot past the cut, whose state was not kept, is not offered", isOpenSlot(setup, now, busy, freeAfter), false);
  is("a free slot before the cut is still offered", isOpenSlot(setup, now, busy, freeBefore), true);

  part("Controls");
  const small = parseIcs(calendar([...fillers.slice(0, 5).map(([s, e], i) => vevent(`f${i}`, s, e)), vevent("early", earlyBusy, earlyBusy + HOUR)]), { ...window, maxIntervals: 4 });
  is("with a cap of 4 and 6 stretches: the 3 earliest kept, then one from the 4th to the end of the window", small.busy.map((b) => [b.start, b.end]), [...fillers.slice(0, 3), [fillers[3][0], window.to]]);
  is("and it says so", small.truncated, true);
  const under = calendar(fillers.slice(0, 1_999).map(([s, e], i) => vevent(`u${i}`, s, e)).concat(vevent("early", earlyBusy, earlyBusy + HOUR)));
  const underRead = parseIcs(under, window);
  is("2,000 stretches exactly: not cut, every one kept as it is", [underRead.truncated, underRead.busy.length, underRead.busy[underRead.busy.length - 1]?.end === fillers[1_998][1]], [false, 2_000, true]);
  const copies = calendar(Array.from({ length: 2_100 }, (_, i) => vevent(`copy-${i}`, earlyBusy, earlyBusy + HOUR)));
  const copiesRead = parseIcs(copies, window);
  is("2,100 copies of one busy hour merge into one stretch and are not a cut", [copiesRead.truncated, copiesRead.busy], [false, [{ start: earlyBusy, end: earlyBusy + HOUR }]]);
  served = calendar([]);
  is("an empty calendar reads empty", (await readFeed("https://calendar.truncated.example.org/cal.ics", "UTC", now, hooks)).busy, []);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
