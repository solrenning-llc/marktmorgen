/**
 * Issue #4287, item 6 (Codex X2, hidden #3958; rule 24): the public booking calendar (lib/calendar-sync.ts
 * bookedCalendarFeed) reads the store's "bookings changed" mark (nl:cal:chg:<callsId>, written as the time in digits
 * by lib/call-records.ts) to know whether its kept copy is stale. A mark in any other shape read as 0, "nothing
 * changed", and the old copy was served as fresh although a booking may have been made, moved or let go since. Now
 * such a mark is unknown: no copy is served, as when the whole read is unknown ({ state: "none" }).
 *
 * Synthetic only: the in-memory Redis and a made-up store.
 */
import { bookedCalendarFeed } from "@/lib/calendar-sync";
import { bookingsChangedKey } from "@/lib/call-records";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "changed-mark@example.com";
const NOW = Date.UTC(2031, 2, 10, 9, 30);
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

let n = 0;
async function feed(mark: string | null): Promise<{ state: string; made: number }> {
  n += 1;
  const owner = { statsId: `changed-mark-${n}`, handle: `changedmark${n}`, callsId: `calls${String(n).padStart(8, "0")}` };
  redis.run(["SET", `nl:store:handle:${owner.handle}`, OWNER]);
  // A copy made a minute ago, for this store and the handle as it leads now: fresh, unless a booking changed since.
  redis.run(["SET", `nl:cal:out:${owner.statsId}`, JSON.stringify({ at: NOW - 60_000, ics: ICS, ref: OWNER, sid: owner.statsId })]);
  if (mark !== null) redis.run(["SET", bookingsChangedKey(owner.callsId), mark]);
  let made = 0;
  const answer = await bookedCalendarFeed(owner, async () => {
    made += 1;
    return { ics: ICS, listId: null, named: [] };
  }, NOW);
  return { state: answer.state, made };
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("Controls: a mark in its own shape");
  is("no mark: the fresh copy is served", (await feed(null)).state, "copy");
  is("a booking changed before the copy: the copy is served", (await feed(String(NOW - 120_000))).state, "copy");
  is("a booking changed after the copy: not served as fresh", (await feed(String(NOW - 1_000))).state !== "copy", true);

  part("A mark in another shape is unknown: no copy is served as fresh");
  for (const bad of ["abc", "-5", "1.5", "", " 3", "1e3"]) {
    const answer = await feed(bad);
    is(`the mark answered ${JSON.stringify(bad)}: nothing served, nothing made`, [answer.state, answer.made], ["none", 0]);
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
