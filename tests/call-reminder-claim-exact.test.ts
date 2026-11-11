/**
 * A call reminder is sent once, however its once-only mark answers (lib/call-reminders.ts, sendCallReminders;
 * CX-123 rule 24, lib/claim-mark.ts). Found by Claude 3 (cloud D)'s audit of main (11 November 2026): the job took
 * the buyer's and the creator's marks with SET NX and read any answer but nil as "ours". A reply lost on the way
 * back (the write landed, the answer did not) on a run that crossed another (the member put back, or two runs at
 * once) sent the same reminder again to the buyer and to the creator. Now each mark is taken with claimMark: an
 * answer that proves nothing is read back; a mark held by another run is never sent on; one still unknown sends
 * nothing and stays queued, so the next run decides.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe and the mail service; synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { HOLD_SECONDS } from "@/lib/stripe-account";

const NY = "America/New_York";

let sessions = 0;
const paidRows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
const reminders: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: unknown; subject?: unknown };
    const subject = String(sent.subject ?? "");
    if (/tomorrow/i.test(subject)) reminders.push(`${String(sent.to)}|${subject}`);
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_claimrem${String(sessions).padStart(10, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// "lost": a reminder mark's SET NX lands but its answer never comes back.
// "gone": the same, and the read back of the mark is lost too.
let marks: "ok" | "lost" | "gone" = "ok";
const reminderMark = (c: (string | number)[]) => String(c[1]).startsWith("nl:call:reminded:") || String(c[1]).startsWith("nl:call:creminded:") || /remind/.test(String(c[1]));
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  const replies = await run(commands);
  if (marks === "ok") return replies;
  if (commands.some((c) => c[0] === "SET" && c.includes("NX") && reminderMark(c))) return [];
  if (marks === "gone" && commands.some((c) => c[0] === "GET" && reminderMark(c))) return [];
  return replies;
};

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0,
  room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

async function callStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  return { store, call: (await readListing(store, made.product.id)) as CallListing };
}

async function main() {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  try {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_claimrem_job";
    process.env.RESEND_API_KEY = "re_test_call_reminder_only";
    const stores = new Map<string, Store>();
    const find = async (handle: string) => stores.get(handle) ?? null;
    const job = () => sendCallReminders(find, clock + 60000, "https://marktmorgen.com");
    const queued = async (member: string) => {
      const [rows] = await run([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
      return Array.isArray(rows) && rows.includes(member);
    };
    const book = async (email: string, handle: string, account: string, days: number) => {
      const { store, call } = await callStore(email, handle, account);
      stores.set(handle, store);
      const start = weekdayAt(days, 600);
      const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
      const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
      if (!held.ok) throw new Error(`no hold: ${held.reason}`);
      paidRows.push({ id: held.session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: `buyer-${handle}@example.com` }, metadata: heldMeta.get(held.session) });
      return { store, start, member: reminderMember(store.callsId!, handle, held.session, "24", start) };
    };
    // Due now: the day-before reminder, put on the queue as the booking's own record would.
    const due = async (member: string) => { await run([["ZADD", REMINDER_QUEUE, clock - 1000, member]]); };

    // 1. Sent once on a healthy run; the same reminder put back, its mark's answer lost: never sent again.
    const a = await book("claimrema@example.com", "claimrema", "acct_1TestClaimRemA1", 9);
    clock += HOLD_SECONDS * 1000 + 120000;
    await due(a.member);
    await job();
    is("a healthy run sends the day-before reminder to the buyer and the creator once", reminders.length, 2);
    await due(a.member);
    marks = "lost";
    await job();
    marks = "ok";
    is("a crossed run whose mark answer is lost sends nothing again", reminders.length, 2);

    // 2. A mark whose answer and read back are both lost: nothing sent, kept queued, sent once by the next run.
    const before = reminders.length;
    const b = await book("claimremb@example.com", "claimremb", "acct_1TestClaimRemB1", 10);
    clock += HOLD_SECONDS * 1000 + 120000;
    // The booking confirmed first, on a healthy run (its confirmation queues the reminders for their own times).
    await job();
    await due(b.member);
    marks = "gone";
    await job();
    marks = "ok";
    is("a mark that cannot be read sends nothing", reminders.length - before, 0);
    is("a mark that cannot be read keeps the reminder queued", await queued(b.member), true);
    await job();
    is("the next healthy run sends it, to the buyer and the creator, once", reminders.length - before, 2);
    is("and takes it off the queue", await queued(b.member), false);
    done();
  } finally {
    marks = "ok";
    Date.now = originalNow;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
