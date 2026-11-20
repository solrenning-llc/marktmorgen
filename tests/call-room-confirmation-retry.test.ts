/**
 * #2514 / review 6750502912: unknown room evidence must leave both
 * confirmation and reminder attempts available for a healthy retry. With
 * main's staged confirmation the mark is written first and stays owed, and
 * the retry resumes it at the time the diary keeps.
 * Real callers, in-memory Redis and synthetic Stripe/Resend only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Product, type Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { confirmBooking, confirmedKey, holdAndCheckout, isConfirmed, slotsForProduct, type CallListing } from "@/lib/calls";
import { icsTime } from "@/lib/ics-write";
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
const sent: { to: string; subject: string; ics: string }[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => Response.json(body);
  if (url.hostname === "api.resend.com" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject?: string; attachments?: { content: string }[] };
    emails.push(...[body.to].flat());
    for (const to of [body.to].flat()) {
      sent.push({ to, subject: body.subject ?? "", ics: body.attachments?.[0] ? Buffer.from(body.attachments[0].content, "base64").toString("utf8") : "" });
    }
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

const OWED = ["sending", "booked", "buyer", "moved"];
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
      // Main's staged confirmation (lib/calls.ts, ConfirmStage): the mark and the time kept for good are written first,
      // and the room is read after them, so an unknown room leaves the mark owed, never done, with no email sent.
      const [heldMark] = await pipeline([["GET", confirmedKey(session)]]);
      is(mode + ": unknown room throws with the confirmation left owed and no email", [rejected, OWED.includes(String(heldMark)), emails.length], [true, true, 0]);
      await confirmBooking(input);
      is(mode + ": healthy retry confirms and sends both emails", [await isConfirmed(session), (await pipeline([["GET", confirmedKey(session)]]))[0], [...emails].sort()], [true, "done", [buyer, owner].sort()]);
      const seenCommands: (string | number)[][] = [];
      const counting = redis.pipeline;
      redis.pipeline = async commands => { seenCommands.push(...commands); return counting(commands); };
      try { await confirmBooking(input); } finally { redis.pipeline = counting; }
      is(mode + ": a repeated confirmation sends neither again", emails.length, 2);
      // Claude 1 (C3) on #2514: a reload of the thanks page for a booking already confirmed stops at the mark, never
      // preparing the meeting or reading the room again (a meeting record, the meet queue, a studio problem).
      is(mode + ": a repeated confirmation reads no room and no meeting", seenCommands.filter(c => c.some(a => /^nl:(call:room|meet):/.test(String(a)))), []);

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

      // An owed confirmation whose room read is unknown stays owed, and resumes later at the time the diary keeps now
      // (here a move whose step of the mark was lost: the entry is at a new time, the mark still owed), never at the
      // time the page or the job read before it: the room is read for the moved time and both emails carry it.
      const later = (await slotsForProduct(store, product))?.days.flatMap(day => day.starts).filter(value => value - clock > 26 * HOUR) ?? [];
      const start2 = later[0];
      const moved = later.find(value => value >= start2 + 2 * HOUR);
      if (!start2 || !moved) throw new Error("No synthetic times for the move");
      const held2 = await holdAndCheckout({ store, product: full, start: start2, buyerTz: "UTC", origin: "https://example.test" });
      if (!held2.ok) throw new Error("No synthetic hold: " + held2.reason);
      const session2 = held2.session;
      const buyer2 = mode + ".moved@example.com";
      paidRows.push({ id: session2, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: buyer2 }, metadata: metadata.get(session2) });
      const input2 = { ...input, session: session2, start: start2, end: start2 + HOUR, buyerEmail: buyer2 };
      emails.length = 0; sent.length = 0;
      fault = mode;
      const rejected2 = await confirmBooking(input2).then(() => false, () => true);
      fault = "none";
      const owed = async () => {
        const [mark] = await pipeline([["GET", confirmedKey(session2)]]);
        return mark === null || OWED.includes(String(mark));
      };
      is(mode + ": an unknown room leaves the confirmation owed, with no email", [rejected2, await owed(), emails.length], [true, true, 0]);
      const busy = `nl:call:busy:${store.callsId}`;
      const [kept] = await pipeline([["HGET", busy, session2]]);
      if (typeof kept !== "string") throw new Error("No synthetic diary entry");
      await pipeline([["HSET", busy, session2, JSON.stringify({ ...(JSON.parse(kept) as Record<string, unknown>), s: moved, e: moved + HOUR, until: 0 })]]);
      const roomTimes: string[] = [];
      const reading = redis.pipeline;
      redis.pipeline = async commands => {
        for (const command of commands) if (command[0] === "GET" && String(command[1]).startsWith(`nl:call:room:${store.callsId}:t:`)) roomTimes.push(String(command[1]).split(":").at(-1)!);
        return reading(commands);
      };
      try { await confirmBooking(input2); } finally { redis.pipeline = reading; }
      is(mode + ": the owed confirmation resumes: done, both emails once", [await owed(), [...emails].sort()], [false, [buyer2, owner].sort()]);
      is(mode + ": its room is read for the moved time, never the old one", roomTimes, [String(moved)]);
      is(mode + ": both calendar files carry the moved time", sent.map(mail => mail.ics.includes(`DTSTART:${icsTime(moved)}`) && !mail.ics.includes(`DTSTART:${icsTime(start2)}`)), [true, true]);
    }
    done();
  } finally {
    fault = "none"; redis.pipeline = pipeline; Date.now = originalNow;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
