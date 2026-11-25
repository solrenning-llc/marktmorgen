/**
 * Issue #3958 (Codex X2, agenda): the booking calendar feed (lib/calendar-sync.ts, bookedCalendarFeed) read an
 * unreadable "bookings changed" mark (lib/call-records.ts, bookingsChangedKey) as 0, "no booking changed", so a copy
 * made before a booking was made or moved was answered as fresh for up to CALENDAR_REFRESH_SECONDS.
 *
 * An unreadable mark is not "no change": the feed is made again when the day's makings allow it, and when they do not,
 * nothing is answered (the app asks again) rather than a copy that may miss a booking. A readable mark older than the
 * copy still answers the copy, with nothing made.
 *
 * Synthetic store and Redis stub only; no real calendar, booking or request leaves the test.
 */
import { bookingsChangedKey } from "@/lib/call-records";
import { CALENDAR_BUILDS_PER_DAY, bookedCalendarFeed, ensureFeedToken } from "@/lib/calendar-sync";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const OWNER = "changedmark@example.com";
const HANDLE = "changedmark";
const CALLS = "f".repeat(16);
const feed = (name: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//EN\r\nX-WR-CALNAME:${name}\r\nEND:VCALENDAR\r\n`;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Changed Mark", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  await ensureFeedToken({ ...store, callsId: CALLS });
  const owner = { statsId: store.statsId!, handle: HANDLE, callsId: CALLS };
  // Today's 00:00 UTC, then one step past each hour's pace window, all inside the same UTC day's makings: the steps
  // below run to (CALENDAR_BUILDS_PER_DAY + 1) steps past the start, which must stay before the next midnight
  // (Claude 5 ibuF's LEVE on #5417).
  const today = new Date();
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0);
  const step = 61 * 60_000;
  is("(setup) every step of this test falls inside one UTC day", (CALENDAR_BUILDS_PER_DAY + 1) * step < 86_400_000, true);
  let made = 0;
  const make = (name: string) => async () => {
    made += 1;
    return { ics: feed(name), listId: null, named: [] };
  };
  const setMark = (value: string) => redis.pipeline([["SET", bookingsChangedKey(CALLS), value]]);

  part("control: a readable mark older than the copy answers the copy, nothing made");
  is("(setup) the first answer is made", (await bookedCalendarFeed(owner, make("first"), t0)).state, "made");
  await setMark(String(t0 - 1_000));
  const before = made;
  const control = await bookedCalendarFeed(owner, make("second"), t0 + step);
  is("the copy is answered", control.state === "copy" && control.ics === feed("first"), true);
  is("and nothing is made", made - before, 0);

  part("an unreadable mark is not 'no change'");
  is(`(setup) one of the day's ${CALENDAR_BUILDS_PER_DAY} makings is left`, CALENDAR_BUILDS_PER_DAY >= 2, true);
  await setMark("not-a-count");
  const remade = await bookedCalendarFeed(owner, make("after-booking"), t0 + 2 * step);
  is("with a making left, the feed is made again, never the old copy answered", remade.state === "made" && remade.ics === feed("after-booking"), true);

  part("an unreadable mark with no making left answers nothing, never a copy as if it were current");
  // Two of the day's makings are spent above; spend the rest from the constant, so the case does not lean on its value
  // (Claude 7 HHH's LEVE on #5417, AC (n)).
  let at = t0 + 2 * step;
  for (let left = CALENDAR_BUILDS_PER_DAY - 2; left > 0; left -= 1) {
    at += step;
    await setMark("not-a-count");
    is(`(setup) a remaining making is spent (${left} left before it)`, (await bookedCalendarFeed(owner, make(`spend-${left}`), at)).state, "made");
  }
  await setMark("not-a-count");
  const madeBefore = made;
  const spent = await bookedCalendarFeed(owner, make("none-left"), at + step);
  is("no copy is answered on a mark that cannot be read", spent.state, "none");
  is("and nothing is made past the day's makings", made - madeBefore, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
