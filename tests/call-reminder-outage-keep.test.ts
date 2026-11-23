/**
 * Codex X2, issue #4812 (MEDIUM): an entry of the call reminder queue that could not be dealt with (the store, the
 * paid calls or one paid call unreadable) was given up on once it was six hours late (GIVE_UP_MS), even when it was a
 * timed reminder still of use: a day-before reminder due six hours and a minute ago is still worth sending for almost
 * eighteen hours, until an hour before the call (stillUseful). A timed reminder is now given up on only once it is no
 * longer of use; the six-hour cut stays for the confirmation ("c"), which is not a timed reminder.
 *
 * Synthetic only: an in-memory Redis, a fetch that answers Stripe with an outage, no email sent.
 */
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE } from "@/lib/call-records";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const SESSION = "cs_test_123456789012345678901234";
const store = { callsId: "calls-o7", handle: "harbor", email: "owner@example.invalid", stripeAccountId: "acct_test_reminders", previousHandles: [] as string[] } as Store;
const member = (mark: "c" | "24" | "1", start: number) => `${store.callsId}|${store.handle}|${SESSION}|${mark}|${start}`;

// "all": every Stripe call answers 503. "one": the list of paid calls answers empty, the session read answers 503.
let outage: "all" | "one" = "all";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const outageReply = () => new Response(JSON.stringify({ error: { message: "synthetic outage", type: "api_error" } }), { status: 503 });
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (outage === "one" && url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return outageReply();
}) as typeof fetch;

async function run(entries: [number, string][], findStore: (handle: string) => Promise<Store | null> = async () => store) {
  redis.clear();
  await redis.pipeline([["ZADD", REMINDER_QUEUE, ...entries.flat()]]);
  const counts = await sendCallReminders(findStore, Date.now() + 60_000, "https://local.example");
  const left = new Map<string, boolean>();
  for (const [, m] of entries) left.set(m, ((await redis.pipeline([["ZSCORE", REMINDER_QUEUE, m]]))[0] ?? null) !== null);
  return { counts, left };
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_call_reminder_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_only";
  const quiet = console.error;
  console.error = () => {};
  try {
    const now = Date.now();
    // Useful until start - 1h, about 17 hours more; due 6h01m ago.
    const usefulStart = now + 17 * HOUR + 59 * 60_000;
    const useful = member("24", usefulStart);
    // Past start - 1h: of no use any more, 23h30m late.
    const spentStart = now + 30 * 60_000;
    const spent = member("24", spentStart);
    // The confirmation, 6h01m late.
    const confirmStart = now + 2 * 24 * HOUR;
    const confirm = member("c", confirmStart);
    const confirmScore = now - 6 * HOUR - 60_000;

    part("Stripe's list of paid calls unreadable for more than six hours");
    outage = "all";
    const listed = await run([[usefulStart - 24 * HOUR, useful], [spentStart - 24 * HOUR, spent], [confirmScore, confirm]]);
    is("a day-before reminder still of use for 17 hours stays queued", listed.left.get(useful), true);
    is("one that is of no use any more is given up on", listed.left.get(spent), false);
    is("the confirmation, six hours late, is given up on as before", listed.left.get(confirm), false);
    is("two dropped, none reminded", [listed.counts.dropped, listed.counts.reminded], [2, 0]);

    part("One paid call unreadable for more than six hours");
    outage = "one";
    const one = await run([[usefulStart - 24 * HOUR, useful], [spentStart - 24 * HOUR, spent]]);
    is("a day-before reminder still of use stays queued", one.left.get(useful), true);
    is("one that is of no use any more is given up on", one.left.get(spent), false);

    part("The store unreadable for more than six hours");
    outage = "all";
    const unread = await run([[usefulStart - 24 * HOUR, useful], [spentStart - 24 * HOUR, spent], [confirmScore, confirm]], async () => {
      throw new Error("synthetic store read failure");
    });
    is("a day-before reminder still of use stays queued", unread.left.get(useful), true);
    is("one that is of no use any more is given up on", unread.left.get(spent), false);
    is("the confirmation, six hours late, is given up on as before", unread.left.get(confirm), false);

    // Claude 1 E's LEVE on #5103 (7075689448), agreed by Claude 4 AC: a timed reminder that keeps failing stayed due at
    // the head of the batch for as long as it was of use, so BATCH of them stuck at once held every other store's
    // reminder back for up to a day. One that could not be dealt with now waits RETRY before it is tried again (never
    // past the last minute it is of use), and the next run reaches the others.
    part("Two hundred stuck reminders no longer hold the head of the queue");
    outage = "all";
    redis.clear();
    const stuck = Array.from({ length: 200 }, (_, i) => `${store.callsId}|${store.handle}|cs_test_stuck${String(i).padStart(19, "0")}|24|${usefulStart + i}`);
    const healthy = `calls-other|meadow|${SESSION}|24|${now + 20 * HOUR}`;
    const nearEnd = member("1", now + 5 * 60_000);
    await redis.pipeline([["ZADD", REMINDER_QUEUE, ...stuck.flatMap((m, i) => [now - 2 * HOUR + i, m]), now - HOUR, healthy]]);
    await sendCallReminders(async () => { throw new Error("synthetic store read failure"); }, Date.now() + 60_000, "https://local.example");
    const due = (await redis.pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, Date.now(), "LIMIT", 0, 200]]))[0] as string[];
    is("the next run's batch reaches the other store's reminder", due.includes(healthy), true);
    is("no stuck reminder is due again before the retry", due.filter((m) => stuck.includes(m)).length, 0);
    const later = Number((await redis.pipeline([["ZSCORE", REMINDER_QUEUE, stuck[0]]]))[0]);
    is("a stuck reminder waits about fifteen minutes, still queued", later > now + 14 * 60_000 && later <= Date.now() + 15 * 60_000, true);

    part("A stuck reminder is never put off past its use, and the confirmation is not put off");
    redis.clear();
    await redis.pipeline([["ZADD", REMINDER_QUEUE, now - 60_000, nearEnd, confirmScore + HOUR, confirm]]);
    await sendCallReminders(async () => { throw new Error("synthetic store read failure"); }, Date.now() + 60_000, "https://local.example");
    const nearScore = Number((await redis.pipeline([["ZSCORE", REMINDER_QUEUE, nearEnd]]))[0]);
    is("one of use for five more minutes is tried again a minute before its end at the latest", nearScore > now && nearScore <= now + 4 * 60_000, true);
    is("the confirmation keeps its score, so its six hours still run out", Number((await redis.pipeline([["ZSCORE", REMINDER_QUEUE, confirm]]))[0]), confirmScore + HOUR);
  } finally {
    console.error = quiet;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
