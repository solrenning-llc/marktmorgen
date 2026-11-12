/**
 * #2514 / review 6750502912: unknown room evidence must leave both
 * confirmation and reminder attempts available for a healthy retry.
 * Real callers, in-memory Redis and synthetic Stripe/Resend only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Product, type Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { confirmBooking, holdAndCheckout, isConfirmed, slotsForProduct, type CallListing } from "@/lib/calls";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

const HOUR = 3_600_000;
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;
process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_stand_in";
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
const paidRows: Record<string, unknown>[] = [];
const metadata = new Map<string, Record<string, string>>();
const emails: string[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => Response.json(body);
  if (url.hostname === "api.resend.com" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    emails.push(...[body.to].flat());
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected synthetic request: " + url.origin);
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    const id = "cs_test_roomretry" + String(++sessions).padStart(12, "0");
    const body = new URLSearchParams(String(init?.body));
    metadata.set(id, Object.fromEntries([...body].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value])));
    return answer({ id, url: "https://checkout.stripe.com/c/pay/" + id });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find(row => row.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let fault: "none" | "shape" | "transport" = "none";
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = async commands => {
  if (fault !== "none" && commands.some(command => command[0] === "GET" && String(command[1]).startsWith("nl:call:room:"))) {
    if (fault === "transport") throw new Error("Synthetic room read unavailable");
    return [null, null, null] as never;
  }
  return pipeline(commands);
};
const setup = {
  kind: "weekly", minutes: 60, tz: "UTC",
  weekly: Array.from({ length: 7 }, () => [[540, 1020]]),
  noticeHours: 1, horizonDays: 30, bufferMinutes: 0,
  room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as CallSetup;

async function main() {
  try {
    for (const mode of ["shape", "transport"] as const) {
      fault = "none";
      redis.clear(); paidRows.length = 0; emails.length = 0;
      const owner = mode + ".owner@example.com";
      const handle = "roomretry" + mode;
      await claimHandle(owner, handle, "Room retry", "");
      await ensureStatsId(owner);
      await setStripeAccount(owner, "acct_1TestHarbor0001", true);
      await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
      const made = await addProduct(owner, "Coaching call", "", "120", null);
      if (!made.ok) throw new Error("No synthetic product");
      await setProductCall(owner, made.product.id, setup);
      const store = (await storeForEmail(owner)) as Store;
      const product = (await readListing(store, made.product.id)) as CallListing;
      const offered = await slotsForProduct(store, product);
      const start = offered?.days.flatMap(day => day.starts).find(value => value - clock > 26 * HOUR);
      if (!start) throw new Error("No synthetic time");
      const full = (await readProduct(store, product.id)) as Product & { call: CallSetup };
      const held = await holdAndCheckout({ store, product: full, start, buyerTz: "UTC", origin: "https://example.test" });
      if (!held.ok) throw new Error("No synthetic hold: " + held.reason);
      const session = held.session;
      const buyer = mode + ".buyer@example.com";
      paidRows.push({ id: session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: buyer }, metadata: metadata.get(session) });
      const input = { store, product, session, start, end: start + HOUR, buyerEmail: buyer, buyerTz: "UTC", amountCents: 12000, due: null, cancel: null, origin: "https://example.test" };
      fault = mode;
      const rejected = await confirmBooking(input).then(() => false, () => true);
      fault = "none";
      is(mode + ": unknown room throws before confirmed mark and any email", [rejected, await isConfirmed(session), emails.length], [true, false, 0]);
      await confirmBooking(input);
      is(mode + ": healthy retry confirms and sends both emails", [await isConfirmed(session), [...emails].sort()], [true, [buyer, owner].sort()]);
      const seenCommands: (string | number)[][] = [];
      const counting = redis.pipeline;
      redis.pipeline = async commands => { seenCommands.push(...commands); return counting(commands); };
      try { await confirmBooking(input); } finally { redis.pipeline = counting; }
      is(mode + ": a repeated confirmation sends neither again", emails.length, 2);
      // Claude 1 (C3) on #2514: a reload of the thanks page for a booking already confirmed reads the mark and stops,
      // never preparing the meeting or the room again (a meeting record, the meet queue, a studio problem).
      is(mode + ": a repeated confirmation only reads the confirmed mark", seenCommands.map(c => String(c[0])), ["EXISTS"]);

      clock = start - 24 * HOUR + 60_000;
      const member = reminderMember(store.callsId!, handle, session, "24", start);
      const queued = async () => {
        const [rows] = await pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
        return Array.isArray(rows) && rows.includes(member);
      };
      const job = () => sendCallReminders(async key => key === handle ? store : null, clock + 60_000, "https://example.test");
      is(mode + ": day reminder is queued", await queued(), true);
      fault = mode;
      const failed = await job();
      fault = "none";
      const marks = await pipeline([
        ["GET", `nl:call:reminded:${session}:${start}:24`],
        ["GET", `nl:call:creator-reminded:${store.callsId}:${product.id}:${start}:24`],
      ]);
      is(mode + ": failed room leaves both reminder marks free and queue intact", [failed.reminded, marks, await queued(), emails.length], [0, [null, null], true, 2]);
      const retried = await job();
      is(mode + ": healthy reminder retry sends each side once and consumes queue", [retried.reminded, await queued(), emails.length], [1, false, 4]);
      is(mode + ": both recipient counts are exactly two", [emails.filter(email => email === buyer).length, emails.filter(email => email === owner).length], [2, 2]);
      await job();
      is(mode + ": no repeated reminders", emails.length, 4);
    }
    done();
  } finally {
    fault = "none"; redis.pipeline = pipeline; Date.now = originalNow;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
