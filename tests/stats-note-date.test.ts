import { addNote, noteDay, readNotes } from "@/lib/stats-notes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
async function main() {
  part("Chart notes describe UTC dates that have already started");
  for (const date of ["2026-10-31", "2026-12-31", "2028-02-28", "2028-02-29", "2028-04-30"]) {
    const midnight = Date.parse(date + "T00:00:00Z");
    const tomorrow = new Date(midnight + DAY).toISOString().slice(0, 10);
    for (const offset of [0, DAY / 2, DAY - 1]) {
      const now = midnight + offset;
      is(date + "/" + offset + ": today is valid", noteDay(date, now), date);
      is(date + "/" + offset + ": tomorrow is future", noteDay(tomorrow, now), "");
    }
    is(date + ": tomorrow becomes valid at its own midnight", noteDay(tomorrow, midnight + DAY), tomorrow);
  }
  const now = Date.UTC(2026, 10, 4, 12);
  for (const clock of [NaN, Infinity, -Infinity]) is("unknown clock cannot certify a past date", noteDay("2026-11-04", clock), "");
  for (const date of ["2026-02-30", "2026-11-31", "2026-1-04", "2999-01-01", "1999-01-01"]) is("invalid or out-of-window day stays refused", noteDay(date, now), "");
  is("yesterday remains valid", noteDay("2026-11-03", now), "2026-11-03");
  is("existing exact retention boundary preserved", noteDay("2026-11-04", now + 400 * DAY - DAY / 2), "2026-11-04");
  is("older than retention stays refused", noteDay("2026-11-04", now + 400 * DAY), "");

  part("Real writes refuse future annotations before changing the stored notes");
  redis.clear();
  const stats = "d".repeat(32);
  is("future note is not recorded", await addNote(stats, "2026-11-05", "A launch that has not happened", now), null);
  is("future note creates no data", await redis.pipeline([["HGETALL", `nl:stats:${stats}:notes`]]), [[]]);
  const recorded = await addNote(stats, "2026-11-04", "Posted the launch", now);
  is("today is recorded as before", recorded?.map(n => [n.day, n.text]), [["2026-11-04", "Posted the launch"]]);
  is("future note beside existing history is refused", await addNote(stats, "2026-11-05", "Future launch", now), null);
  is("existing note remains byte-for-byte in the reading", await readNotes(stats), recorded);
  is("invalid clock cannot authorize a write", await addNote(stats, "2026-11-04", "Unknown time", NaN), null);
  is("unknown clock preserves existing history", await readNotes(stats), recorded);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
