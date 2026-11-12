/**
 * A date that is not on any calendar (lib/call-setup.ts, zonedToUtc): 31
 * February, 31 April, month 13. JavaScript's Date.UTC rolls them over, so 31
 * February 2027 was read as 3 March and month 13 as next January; a live
 * call's session or a community event sent with such a date was put, without
 * a word, on another day. Now no instant shows it, as for a time the clocks
 * skip, and each form says the time does not exist. Found with the date and
 * time tests asked for in ALL-154. Synthetic, no Redis.
 */
import { readSetup, zonedToUtc } from "@/lib/call-setup";
import { readEventInput } from "@/lib/community-events";
import { done, is, part } from "./check";

const NY = "America/New_York";
const now = Date.UTC(2026, 10, 12, 12);

function main(): void {
  part("No instant shows a date that does not exist");
  for (const [y, m, d] of [[2027, 2, 29], [2027, 2, 31], [2027, 4, 31], [2027, 13, 1], [2027, 0, 10], [2027, 6, 0]] as const) {
    is(`${y}-${m}-${d}`, zonedToUtc(y, m, d, 600, NY), null);
  }
  is("a leap day that exists does", zonedToUtc(2028, 2, 29, 600, NY), Date.UTC(2028, 1, 29, 15));
  is("so do the last days of months", [zonedToUtc(2027, 4, 30, 600, NY) !== null, zonedToUtc(2027, 12, 31, 600, NY) !== null], [true, true]);
  is("a minute past the day's end still reads as the next day's clock", zonedToUtc(2027, 1, 31, 24 * 60 + 60, NY), Date.UTC(2027, 1, 1, 6));

  part("A live call's session on such a date is refused, not moved");
  const live = (date: string) => readSetup({ kind: "live", tz: NY, noticeHours: 1, sessions: [{ id: "s1", date, time: "10:00", minutes: 60, seats: 6 }] });
  is("31 February", live("2027-02-31"), "session_time");
  is("31 April", live("2027-04-31"), "session_time");
  const real = live("2027-04-30");
  is("30 April is read as 30 April", typeof real === "string" ? real : real.kind === "live" ? real.sessions[0].start : null, Date.UTC(2027, 3, 30, 14));

  part("A community event on such a date is refused, not moved");
  const event = (date: string) => readEventInput({ title: "Q&A", about: "", tz: NY, date, time: "18:00", minutes: 60, where: "room" }, { access: [] } as never, now);
  is("31 February", event("2027-02-31"), "no_such_time");
  is("month 13", event("2026-13-01"), "no_such_time");
  const kept = event("2027-02-28");
  is("28 February is read as 28 February", typeof kept === "string" ? kept : kept.start, Date.UTC(2027, 2, 0, 23));
  done();
}

main();
