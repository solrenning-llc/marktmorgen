/**
 * The booking calendar's making room (lib/calendar-sync.ts bookedCalendarFeed,
 * its roomFor) reads the day's counts only in their exact shape: a count is a
 * text of digits (or nothing, for a count not taken yet). Any other answer is
 * unknown, so the making never runs: the copy kept, or nothing (C4-20261105-2000-C3-2,
 * rule 24 audit of Claude 4, HIGH). Before, Number() turned "abc", "-5" or
 * "1.5" into a number below the ceiling and the file was made.
 * Synthetic only.
 */
import { bookedCalendarFeed, calendarAttemptsKey } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "room-shape@example.com";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const t = Date.UTC(2031, 2, 10, 9, 30);
  const day = new Date(t).toISOString().slice(0, 10);

  const tries = async (label: string, statsId: string, counts: Record<string, string>) => {
    const owner = { statsId, handle: `shape${statsId.length}${statsId.slice(-3)}` };
    redis.run(["SET", `nl:store:handle:${owner.handle}`, OWNER]);
    for (const [key, value] of Object.entries(counts)) redis.run(["SET", key, value]);
    let made = 0;
    const make = async () => {
      made += 1;
      return { ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR", listId: null, named: [] };
    };
    const answer = await bookedCalendarFeed(owner, make, t);
    is(label, [made, answer.state === "made"], [0, false]);
  };

  part("A count read in another shape is unknown: nothing is made");
  for (const bad of ["abc", "-5", "1.5", "", " 3", "1e3"]) {
    const statsId = `shape-a-${bad.length}${bad.charCodeAt(0) || 0}x`;
    await tries(`the day's tries answered ${JSON.stringify(bad)}: not made`, statsId, { [calendarAttemptsKey(statsId, day)]: bad });
  }
  for (const bad of ["abc", "-5", "1.5", ""]) {
    const statsId = `shape-b-${bad.length}${bad.charCodeAt(0) || 0}`;
    await tries(`the day's own makings answered ${JSON.stringify(bad)}: not made`, statsId, { [`nl:cal:builds:${statsId}:${day}`]: bad });
  }

  part("Control: counts in their shape still leave room");
  {
    const statsId = "shape-ok";
    const owner = { statsId, handle: "shapeok" };
    redis.run(["SET", `nl:store:handle:${owner.handle}`, OWNER]);
    redis.run(["SET", calendarAttemptsKey(statsId, day), "1"]);
    redis.run(["SET", `nl:cal:builds:${statsId}:${day}`, "0"]);
    let made = 0;
    const answer = await bookedCalendarFeed(owner, async () => {
      made += 1;
      return { ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR", listId: null, named: [] };
    }, t);
    // (The synthetic store behind the handle is not a whole store, so what is made is answered as gone afterwards.)
    is("a count of digits below the ceiling: the making runs once", [made, answer.state !== "none"], [1, true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
