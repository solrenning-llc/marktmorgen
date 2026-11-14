/**
 * A paid call moved before its confirmation finished is still confirmed (rules 24 and 30; Claude 5, 9 November 2026).
 *
 * moveBooking (lib/calls.ts) wrote the booking's confirmation mark as "1", which reads as done. When the confirmation
 * had failed before its mark (Redis slow for a moment) and the buyer moved the booking from the thanks page before
 * the mail job's next run, that "1" closed it for good: the orders were never counted in the store's window, the
 * affiliate's lead, the team's hosts, the call.booked webhook and the creator's phone alert never happened. And a
 * confirmation left short of done after its mark ("sending", "booked", "buyer") was later finished with the
 * "Booked" emails at the new time, after the move's own emails had told both people.
 *
 * Checked here, against the real hold, confirmation, move and mail job, with an in-memory Redis and stand-ins for
 * Stripe and Resend (Resend keeps one email per Idempotency-Key):
 *
 *   - a move before any confirmation leaves the confirmation owed ("moved"), and the next try counts the orders and
 *     does the rest of what a booking does, without the two "Booked" emails the move's emails stand in for;
 *   - a move after a confirmation that stopped short of done never lets a "Booked" email follow the move's;
 *   - a move while a confirmation is under way never lets that try write the mark on past the move.
 *
 * Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, confirmationOwed, confirmedKey, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { sendCallReminders } from "@/lib/call-reminders";
import { CALL_ORDER_UNITS } from "@/lib/order-rules";
import { storeOrdersThisMonth } from "@/lib/orders";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const OWNER = "quay@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";

let sessions = 0;
const paidRows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
/** Every POST Resend was sent, and what it kept: one email per Idempotency-Key. */
const posts: { to: string; subject: string; key: string }[] = [];
const kept = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    const to = String([body.to].flat()[0]);
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? `none:${posts.length}`;
    posts.push({ to, subject: String(body.subject ?? ""), key });
    if (!kept.has(key)) kept.set(key, to);
    return answer({ id: `email_${kept.size}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_confirmmoved${String(sessions).padStart(8, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

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

/** Distinct free hours, 9:00 to 16:00 on the weekdays from two days on. */
function slots(now: number): number[] {
  const out: number[] = [];
  for (let d = 2; d < 28; d += 1) {
    const day = new Date(now + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    for (let h = 0; h < 8; h += 1) out.push(zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), 540 + h * 60, NY) as number);
  }
  return out;
}


/**
 * How Redis fails around one booking's mark, once:
 *  - "write": the script that would first write the mark never reaches Redis;
 *  - "to": the request that would move the mark on to `to` never reaches Redis;
 *  - "race": just before the request that would move the mark on to `to`, the buyer's move runs, then the request.
 * The mark's own requests are found by its key and the stage named in them, whatever command carries them.
 */
type Fault = { kind: "write"; session: string } | { kind: "to"; session: string; to: string } | { kind: "race"; session: string; to: string; move: () => Promise<unknown> };
let fault: Fault | null = null;
const run = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const now = fault;
  if (now) {
    const key = confirmedKey(now.session);
    const touches = commands.some((c) => c.includes(key));
    const writes = commands.some((c) => c[0] === "EVAL" && c.includes(key) && String(c[1]).startsWith("-- marktmorgen:order-write-once:v1\n"));
    const movesOnTo = (to: string) => touches && !writes && commands.some((c) => c.includes(key) && c.map(String).includes(to)) && !commands.some((c) => c.map(String).includes("moved"));
    if (now.kind === "write" && writes) {
      fault = null;
      throw new Error("Synthetic: Redis timed out");
    }
    if (now.kind === "to" && movesOnTo(now.to)) {
      fault = null;
      throw new Error("Synthetic: Redis timed out");
    }
    if (now.kind === "race" && movesOnTo(now.to)) {
      fault = null;
      await now.move();
    }
  }
  return run(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const quiet = console.error;
  try {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_confirm_moved_only";
    process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
    await claimHandle(OWNER, "quay", "Quay Studio", "");
    await ensureStatsId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestQuay00001", true);
    await setSubscription(OWNER, { customerId: "cus_quay00001", subscriptionId: "sub_quay00001", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(OWNER, "Strategy call", "", "120", null);
    if (!made.ok) throw new Error("no product");
    await setProductCall(OWNER, made.product.id, weekly);
    const store = (await storeForEmail(OWNER)) as Store;
    const call = (await readListing(store, made.product.id)) as CallListing;
    const free = slots(clock);
    let next = 0;
    const orders = async () => (await storeOrdersThisMonth(store)) ?? 0;
    const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
    const mark = async (session: string) => (await run([["GET", confirmedKey(session)]]))[0];
    const subjects = (from: number, start: string) => posts.slice(from).filter((p) => p.subject.startsWith(start)).map((p) => p.to);

    /** A paid hold at a free time, its row in Stripe's list, and what is needed to confirm and move it. */
    async function paid() {
      const at = free[next];
      next += 4;
      const held = await holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: ORIGIN });
      if (!held.ok) throw new Error(`no hold: ${held.reason}`);
      const session = held.session;
      paidRows.push({ id: session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: BUYER }, metadata: heldMeta.get(session) });
      const to = free[next - 1];
      return {
        session,
        at,
        to,
        confirm: (start = at) =>
          confirmBooking({ store, product: call, session, start, end: start + HOUR, buyerEmail: BUYER, buyerTz: NY, amountCents: 12000, currency: "usd", origin: ORIGIN }),
        move: () => moveBooking({ store, product: call, session, booked: { start: at, end: at + HOUR, email: BUYER, buyerTz: NY }, start: to, origin: ORIGIN }),
      };
    }
    /** The mail job's next run, once the checkout has closed. */
    async function job() {
      clock += HOLD_SECONDS * 1000 + 120_000;
      console.error = () => {};
      await sendCallReminders(async (handle) => (handle === store.handle ? store : null), clock + 60_000, ORIGIN).catch(() => {});
      console.error = quiet;
    }
    async function attempt(p: Promise<unknown>) {
      console.error = () => {};
      await p.catch(() => {});
      console.error = quiet;
    }

    part("Moved before the confirmation wrote its mark (pre-review, point 5): the next try still confirms it");
    {
      const one = await paid();
      const before = await orders();
      const sent = posts.length;
      fault = { kind: "write", session: one.session };
      await attempt(one.confirm());
      is("the first try wrote no mark (Redis failed on its script)", (await run([["EXISTS", confirmedKey(one.session)]]))[0], 0);
      const moved = await one.move();
      is("the move went through", moved.ok, true);
      is("the move leaves the confirmation owed, never done", await mark(one.session), "moved");
      is("the mail job reads it as owed", await confirmationOwed(one.session), true);
      await job();
      is("the paid call's orders are counted in the store's window, once", (await orders()) - before, CALL_ORDER_UNITS);
      is("the confirmation is done", await mark(one.session), "done");
      is("both people were told by the move's emails", [subjects(sent, "Moved: ").length, subjects(sent, "Moved: ").includes(BUYER)], [2, true]);
      is("no Booked email, to either, ever follows the move's", [subjects(sent, "Booked: "), subjects(sent, "New booking: ")], [[], []]);
      await attempt(one.confirm(one.to));
      await job();
      is("a refreshed thanks page and the next run count and send nothing more", [(await orders()) - before, posts.length - sent], [CALL_ORDER_UNITS, 2]);
    }

    part("Moved after a confirmation stopped at \"sending\": no Booked email at the new time follows the move's");
    {
      const two = await paid();
      const before = await orders();
      const sent = posts.length;
      fault = { kind: "to", session: two.session, to: "booked" };
      await attempt(two.confirm());
      is("the try stopped after counting the orders, before any email", [(await orders()) - before, posts.length - sent, await mark(two.session)], [CALL_ORDER_UNITS, 0, "sending"]);
      is("the move went through", (await two.move()).ok, true);
      is("what the try owed is left for the next one, without its emails", await mark(two.session), "moved");
      await job();
      is("the next run finishes it: done, the orders still counted once", [await mark(two.session), (await orders()) - before], ["done", CALL_ORDER_UNITS]);
      is("only the move's emails went", [subjects(sent, "Booked: "), subjects(sent, "New booking: "), subjects(sent, "Moved: ").length], [[], [], 2]);
    }

    part("Moved after the buyer's Booked email went and the creator's did not: the move's email tells the creator");
    {
      const three = await paid();
      const sent = posts.length;
      fault = { kind: "to", session: three.session, to: "buyer" };
      await attempt(three.confirm());
      is("the try stopped after the buyer's email", [subjects(sent, "Booked: "), await mark(three.session)], [[BUYER], "booked"]);
      is("the move went through", (await three.move()).ok, true);
      is("the move's emails stand in for what was owed: done", await mark(three.session), "done");
      const moved = posts.length;
      await job();
      is("nothing is sent after the move's emails", [subjects(moved, "Booked: "), subjects(moved, "New booking: ")], [[], []]);
      is("no New booking email at the new time, ever", subjects(sent, "New booking: "), []);
    }

    part("Moved while a confirmation is under way: the try never writes its mark on past the move");
    {
      const four = await paid();
      const before = await orders();
      const sent = posts.length;
      let movedOk: boolean | null = null;
      fault = { kind: "race", session: four.session, to: "booked", move: async () => (movedOk = (await four.move()).ok) };
      await attempt(four.confirm());
      is("the move went through in the middle of the try", movedOk, true);
      is("the try left the mark at the move's, owed", await mark(four.session), "moved");
      is("no Booked email at the old time after the move's", [subjects(sent, "Booked: "), subjects(sent, "New booking: ")], [[], []]);
      await job();
      is("the next run finishes it, the orders counted once", [await mark(four.session), (await orders()) - before], ["done", CALL_ORDER_UNITS]);
      is("only the move's emails went", [subjects(sent, "Booked: "), subjects(sent, "New booking: "), subjects(sent, "Moved: ").length], [[], [], 2]);
    }
    done();
  } finally {
    console.error = quiet;
    Date.now = realNow;
  }
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
