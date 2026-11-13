/**
 * The private booking calendar (lib/calendar-sync.ts, bookedCalendarFeed)
 * answers from its kept copy until a booking changed since that copy. The
 * "changed" mark is read in its own shape: digits, or nothing for none yet.
 * A mark in any other shape is unknown, never "nothing changed", so a young
 * copy is not answered as current over it: the file is made again within the
 * day's ceilings (issue #4287; Codex X2, hidden #3958). Synthetic only.
 */
import { bookedCalendarFeed, newFeedToken } from "@/lib/calendar-sync";
import { bookingsChangedKey } from "@/lib/call-records";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "changed-mark@example.com";
const CALLS = "e".repeat(32);
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_changed_mark_stand_in";
  await claimHandle(OWNER, "changedmark", "Changed Mark Calls", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestChanged0001", true);
  await setSubscription(OWNER, { customerId: "cus_Changed00001", subscriptionId: "sub_Changed00001", active: true, tier: "pro", period: paidPeriod() });
  await newFeedToken((await storeForEmail(OWNER))!);
  const store = (await storeForEmail(OWNER))!;
  const owner = { statsId: store.statsId as string, handle: store.handle, callsId: CALLS };
  let makings = 0;
  const make = async () => {
    makings += 1;
    return { ics: `BEGIN:VCALENDAR\r\nX-MADE:${makings}\r\nEND:VCALENDAR`, listId: null, named: [] };
  };
  const t = Date.UTC(2031, 3, 1, 9, 0);
  const at = async (now: number, mark: string | null) => {
    redis.run(["DEL", `nl:cal:pace:${owner.statsId}`]);
    if (mark === null) redis.run(["DEL", bookingsChangedKey(CALLS)]);
    else redis.run(["SET", bookingsChangedKey(CALLS), mark]);
    return (await bookedCalendarFeed(owner, make, now)).state;
  };

  part("Controls: the mark in its own shape decides as before");
  is("the first answer makes the file", await at(t, null), "made");
  is("nothing changed and the copy young: the copy", await at(t + 60_000, null), "copy");
  is("a mark older than the copy: the copy", await at(t + 120_000, String(t - 60_000)), "copy");
  is("a booking changed after the copy: made again", await at(t + 180_000, String(t + 150_000)), "made");

  for (const bad of ["abc", "-5", "1.5", " 3"]) {
    part(`The changed mark reads ${JSON.stringify(bad)}`);
    is("unknown, never \"nothing changed\": the young copy is not answered as current", await at(t + 240_000 + bad.length * 1_000, bad), "made");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
