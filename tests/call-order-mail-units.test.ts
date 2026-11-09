/**
 * A booked call is priced as CALL_ORDER_UNITS orders (lib/order-rules.ts), each order two emails
 * (tests/plan-cost-registry.ts, ORDER_COST): four emails, its two confirmations and the buyer's two reminders. The
 * Claude 5 email audit (MÉDIO 2, 9 November 2026) found that the reminder job (lib/call-reminders.ts) sent six with
 * that same meter, the host's two reminders as well, and up to ten after the two moves a buyer may make (each move
 * plans the reminders again, and the day-before one may already be out). Every email past the four is now taken from
 * the store's own emails as it goes, as the move notices always were (lib/calls.ts, tellMoved), and one the store's
 * figure no longer has room for is not sent and not tried again every five minutes.
 *
 * Against the real code (holdAndCheckout, the five-minute job, moveBooking) with an in-memory Redis and a stand-in for
 * Stripe and Resend; synthetic only. An email the store's figure did not count is one the order's price must cover.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, MAX_MOVES, zonedToUtc } from "@/lib/call-setup";
import { CALL_ORDER_UNITS } from "@/lib/order-rules";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const ORIGIN = "https://marktmorgen.com";
const PRICED = CALL_ORDER_UNITS * 2;

let sessions = 0;
const paidRows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
const stripe = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_callmail${String(sessions).padStart(10, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
};
const mail = installSesMailFixture({ fallback: stripe });
const sent = () => mail.sent.flatMap((m) => m.to);

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

let clock = Date.now();

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(clock + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

type Booking = { store: Store; call: CallListing; session: string; buyer: string; start: number };

const stores = new Map<string, Store>();
const find = async (handle: string) => stores.get(handle) ?? null;
const job = () => sendCallReminders(find, clock + MINUTE, ORIGIN);

/** A Store-plan store (the "creator" tier) with one weekly call, and one booking of it paid at `start`. */
async function book(handle: string, start: (now: number) => number): Promise<Booking> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(9, "0").slice(0, 9)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod(clock, { behind: 2, ahead: 28 }) });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  stores.set(handle, store);
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const at = start(clock);
  const held = await holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: ORIGIN });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  const buyer = `buyer-${handle}@example.com`;
  paidRows.push({ id: held.session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: buyer }, metadata: heldMeta.get(held.session) });
  return { store, call, session: held.session, buyer, start: at };
}

/** Emails one booking's store sent: to its buyer and to its host (the store's own address). */
const mailOf = (b: Booking) => sent().filter((to) => to === b.buyer || to === b.store.email).length;
const hostMail = (b: Booking) => sent().filter((to) => to === b.store.email).length;
const buyerMail = (b: Booking) => sent().filter((to) => to === b.buyer).length;
const takenOf = (b: Booking) => allowanceUsed(b.store, "email", clock);
const queued = async (member: string) => {
  const [rows] = await redis.pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
  return Array.isArray(rows) && rows.includes(member);
};

async function move(b: Booking, from: number, to: number): Promise<void> {
  const moved = await moveBooking({ store: b.store, product: b.call, session: b.session, booked: { start: from, end: from + HOUR, email: b.buyer, buyerTz: NY }, start: to, origin: ORIGIN });
  if (!moved.ok) throw new Error(`no move: ${moved.reason}`);
}

async function main() {
  const originalNow = Date.now;
  Date.now = () => clock;
  try {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_c5_callmail";
    process.env.RESEND_API_KEY = "re_test_c5_callmail";
    mail.configure();
    await mail.setReady(true, { max24: 50_000, rate: 100 });

    // Three stores booked at once: one never moved, one whose store emails are used up, and one moved MAX_MOVES times.
    const still = await book("cmstill", () => weekdayAt(3, 600));
    const spent = await book("cmspent", () => weekdayAt(3, 660));
    const moved = await book("cmmoved", () => weekdayAt(5, 600));
    clock += HOLD_SECONDS * 1000 + 2 * MINUTE;
    const confirmed = await job();
    is("the job confirms the three bookings: two emails each, both inside the order's price", [confirmed.confirmed, mailOf(still), mailOf(spent), mailOf(moved), await takenOf(still)], [3, 2, 2, 2, 0]);

    part("a booking never moved: six emails, the store's figure counts every one past the order's four");
    clock = still.start - DAY + MINUTE;
    await forceAllowance(spent.store, "email", allowanceFor(spent.store, "email", clock / 1000), clock);
    await job();
    clock = still.start - HOUR + MINUTE;
    await job();
    const stillSent = mailOf(still);
    const stillTaken = await takenOf(still);
    console.log(`  never moved: ${stillSent} emails, ${stillTaken} taken from the store's emails; priced ${PRICED}`);
    is("the code sends the two confirmations and four reminders (buyer and host, a day and an hour before)", [stillSent, buyerMail(still), hostMail(still)], [6, 3, 3]);
    is("the emails the store's figure did not count fit the order's price", stillSent - stillTaken <= PRICED, true);
    is("exactly the host's two reminders were taken from the store's emails", stillTaken, 2);

    part("a store whose emails are used up: the buyer is still reminded, the host's reminder waits for nothing");
    clock = spent.start - HOUR + MINUTE;
    await job();
    const spentHost = hostMail(spent);
    is("the buyer's reminders went out, inside the order's price", buyerMail(spent), 3);
    is("the host's reminders were not sent past the store's figure", spentHost, 1);
    is("nor was the figure taken past itself", await takenOf(spent), allowanceFor(spent.store, "email", clock / 1000));
    const spentMarks = (["24", "1"] as const).map((mark) => reminderMember(spent.store.callsId!, spent.store.handle, spent.session, mark, spent.start));
    is("a reminder refused for a used-up figure leaves the queue, never tried again every five minutes", [await queued(spentMarks[0]), await queued(spentMarks[1])], [false, false]);

    part(`a booking moved ${MAX_MOVES} times, each after its day-before reminder went`);
    const first = moved.start;
    clock = first - DAY + MINUTE;
    await job();
    const second = weekdayAt(2, 600);
    await move(moved, first, second);
    clock = second - DAY + MINUTE;
    await job();
    const third = weekdayAt(2, 600);
    await move(moved, second, third);
    clock = third - DAY + MINUTE;
    await job();
    clock = third - HOUR + MINUTE;
    await job();
    const movedSent = mailOf(moved);
    const movedTaken = await takenOf(moved);
    console.log(`  moved ${MAX_MOVES} times: ${movedSent} emails, ${movedTaken} taken from the store's emails; priced ${PRICED}`);
    // 2 confirmations, a day-before pair at each of three times, an hour-before pair at the last, and a move notice pair at each move.
    is("the code sends fourteen: confirmations, eight reminders and four move notices", movedSent, 2 + 2 * 3 + 2 + 2 * MAX_MOVES);
    is("the emails the store's figure did not count fit the order's price", movedSent - movedTaken <= PRICED, true);
    done();
  } finally {
    Date.now = originalNow;
    mail.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
