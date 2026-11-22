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
  } finally {
    console.error = quiet;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
