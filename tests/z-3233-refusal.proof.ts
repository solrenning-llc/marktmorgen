/** Z independent additional scenarios; fixture helpers copied from author calls-busy-shape. */
/**
 * The taken times of a call, read in their exact shape (CX-123 rules 24 and
 * 30; Claude 6, audit round 4).
 *
 * What makes a time unavailable (lib/calls.ts, readBusy) comes from two
 * readings: the paid bookings Stripe lists on the creator's account
 * (readCallSessions) and the holds and bookings kept in Redis
 * (heldAndBooked, HGETALL). Either one answering in another shape was read
 * as "nothing taken", so a paid or held time was offered again and could be
 * sold to a second buyer. Now:
 *
 *   - a Stripe page that is not an object with its own `data` list and a
 *     true-or-false `has_more`, a row that cannot be read, or a page that says
 *     there is more without a row to go on from refuses to offer or sell any
 *     time (slotsForProduct gives null, holdAndCheckout "error"), and no
 *     checkout is opened;
 *   - an HGETALL of the holds that is not a list of strings does the same,
 *     and deletes nothing;
 *   - the healthy readings and the confirmed-empty ones are unchanged.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";

/** What Stripe lists as the account's completed checkouts, per account; a function gives a page in another shape. */
const listed = new Map<string, () => unknown>();
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_busyshape${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    const account = new Headers(init?.headers).get("Stripe-Account") ?? "";
    const page = listed.get(account);
    if (page) return answer(page());
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The HGETALL of a store's holds answers `busyReply` while it is set; every other command runs as it does.
let busyReply: { value: unknown } | null = null;
const deletes: string[] = [];
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  for (const c of commands) if (c[0] === "HDEL" && String(c[1]).startsWith("nl:call:busy:")) deletes.push(String(c[1]));
  const replies = await run(commands);
  if (!busyReply) return replies;
  return commands.map((c, i) => (c[0] === "HGETALL" && String(c[1]).startsWith("nl:call:busy:") ? busyReply?.value : replies[i]));
};

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

async function callStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing; full: Product & { call: CallSetup } }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full };
}

/** The times on offer, or null when none may be offered. */
async function offered(store: Store, call: CallListing): Promise<number[] | null> {
  const slots = await slotsForProduct(store, call);
  return slots ? slots.days.flatMap((d) => d.starts) : null;
}

async function sell(store: Store, full: Product & { call: CallSetup }, start: number): Promise<string> {
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  return held.ok ? "opened" : held.reason;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_busy_shape_only";
  process.env.RESEND_API_KEY = "re_test_busy_shape_only";
  const ACCOUNT = "acct_1ZBusyReview";
  const paid = await callStore("paidshape@example.com", "paidshape", ACCOUNT);
  const T = weekdayAt(9, 600);
  const row = {
    id: "cs_test_paidshape0000000001",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    metadata: { kind: "call", store: "paidshape", start: String(T), end: String(T + HOUR), product: paid.call.id, tz: NY },
    customer_details: { email: "first@example.com", name: "First Buyer" },
    amount_total: 12000,
    currency: "usd",
    payment_intent: { id: "pi_test_paidshape0001", object: "payment_intent", latest_charge: { id: "ch_test_paidshape0001", object: "charge", disputed: false, refunded: false, amount: 12000, amount_refunded: 0 } },
  };
  part("Independent Z cases, using the author's synthetic fixture helpers");
  listed.set(ACCOUNT, () => ({ object: "list", data: [row], has_more: false }));
  is("healthy paid time remains unavailable", (await offered(paid.store, paid.call))?.includes(T), false);
  for (const metadata of [null, undefined]) {
    listed.set(ACCOUNT, () => ({ object: "list", data: [{ ...row, metadata }], has_more: false }));
    const count = opened;
    is(`metadata ${String(metadata)} refuses listing`, await offered(paid.store, paid.call), null);
    is(`metadata ${String(metadata)} refuses a second checkout`, [await sell(paid.store, paid.full, T), opened - count], ["error", 0]);
    await run([["DEL", `nl:call:busy:${paid.store.callsId}`]]);
  }
  listed.set(ACCOUNT, () => ({ object: "list", data: [], has_more: false }));
  is("confirmed empty Stripe list and diary offer time", (await offered(paid.store, paid.call))?.includes(T), true);
  busyReply = { value: [String(T)] };
  let count = opened, removed = deletes.length;
  is("odd HGETALL pairs refuse listing", await offered(paid.store, paid.call), null);
  is("odd HGETALL pairs refuse checkout and cleanup", [await sell(paid.store, paid.full, T), opened-count, deletes.length-removed], ["error",0,0]);
  busyReply = null;
  const pipeline = redis.pipeline;
  redis.pipeline = async commands => {
    const reply = await pipeline.call(redis, commands);
    return commands.some(c => c[0] === "HGETALL" && String(c[1]).startsWith("nl:call:busy:")) ? [...reply, []] : reply;
  };
  try {
    count = opened; removed = deletes.length;
    is("extra outer diary reply refuses listing", await offered(paid.store, paid.call), null);
    is("extra outer diary reply refuses checkout and cleanup", [await sell(paid.store, paid.full, T), opened-count, deletes.length-removed], ["error",0,0]);
  } finally { redis.pipeline = pipeline; }
  // The OLD module may have opened a real synthetic checkout in a bad case.
  // This control explicitly restores an empty diary, rather than mistaking
  // that resulting valid hold for an unreadable reply.
  await run([["DEL", `nl:call:busy:${paid.store.callsId}`]]);
  is("restoring the exact empty envelope restores listing", (await offered(paid.store, paid.call))?.includes(T), true);
  done();
}
void main();
