/**
 * Proof only (rule 24 candidate, Claude 6, 06/11/2026): lib/calls.ts
 * heldAndBooked reads the busy hash's HGETALL reply with
 * `Array.isArray(raw) ? raw : []`, so a reply in another shape is taken for
 * "nothing held or booked". This shows, on synthetic records with Stripe and
 * the email service mocked:
 *
 *   (a) what the store's busy times (busyTimes, which is heldAndBooked plus
 *       Stripe's paid list, empty here) read for each unknown shape of the
 *       HGETALL reply, against a healthy hash and a confirmed empty one;
 *   (b) whether the booking page's offer (slotsForProduct) then lists the
 *       time already held;
 *   (c) whether a second buyer can then hold and open a checkout for that
 *       time (holdAndCheckout, whose check inside the lock reads the same
 *       hash the same way) and have it confirmed as a second booking of a
 *       one-seat call (confirmBooking, which checks no time).
 *
 * Every expectation below is the CURRENT behaviour, so the file passes on
 * main and fails once the read is made exact: it is evidence, not a guard.
 * Run: node tests/g-proof-run.mjs held-booked-unknown.proof.ts
 */
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { busyTimes, confirmBooking, holdAndCheckout, slotsForProduct, type CallListing } from "@/lib/calls";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import type { Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const opened: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    const id = `cs_test_hab${String(opened.length + 1).padStart(14, "0")}`;
    opened.push(id);
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  // Stripe's list of paid sessions is empty: a hold is an open, unpaid checkout, known only to the busy hash.
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

const real = redis.pipeline.bind(redis);
let busyHash = "";
/** Answers the busy hash's HGETALL with `shape(healthy reply)`, every other command as Redis would. */
function patch(shape: (healthy: unknown) => unknown, wholePipeline?: (answers: unknown[], commands: Command[]) => unknown): void {
  redis.pipeline = async (commands: Command[]) => {
    const answers = await real(commands);
    if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === busyHash && wholePipeline) return wholePipeline(answers, commands) as never;
    return answers.map((answer, i) => (commands[i][0] === "HGETALL" && commands[i][1] === busyHash ? shape(answer) : answer)) as never;
  };
}
const restore = () => {
  redis.pipeline = real;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_held_booked_proof_only";
  process.env.RESEND_API_KEY = "re_test_held_booked_proof_only";

  const OWNER = "mira@example.com";
  await claimHandle(OWNER, "mira", "Mira Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMira00001", true);
  await setSubscription(OWNER, { customerId: "cus_mira00001", subscriptionId: "sub_mira00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  busyHash = `nl:call:busy:${store.callsId}`;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  const at = weekdayAt(3, 600);
  const offered = async () => {
    const read = await slotsForProduct(store, listing);
    return read === null ? "unreadable" : read.days.some((d) => d.starts.includes(at));
  };
  const hold = () => holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });

  part("Controls");
  is("confirmed empty hash: nothing busy, the time offered", [await busyTimes(store), await offered()], [[], true]);
  const first = await hold();
  if (!first.ok) throw new Error(`no first hold: ${first.reason}`);
  const fieldsAfterFirst = await real([["HKEYS", busyHash]]);
  is("buyer A holds the one seat: one entry in the hash", fieldsAfterFirst[0], [first.session]);
  is("healthy hash with the hold: the time is busy and not offered", [(await busyTimes(store)).map((b) => [b.start, b.session]), await offered()], [[[at, first.session]], false]);
  is("healthy hash: buyer B is refused the held time", await hold(), { ok: false, reason: "taken" });
  is("healthy hash: no second checkout was opened", opened.length, 1);

  part("(a)+(b) Each unknown HGETALL shape, read by busyTimes and by the booking page");
  const shapes: [string, (healthy: unknown) => unknown, ((answers: unknown[]) => unknown)?][] = [
    ["no reply (pipeline answers [])", (h) => h, () => []],
    ["null", () => null],
    ["a text", () => "OK"],
    ["a number", () => 2],
    ["an object {field: value}", (h) => Object.fromEntries([[(h as string[])[0], (h as string[])[1]]])],
    ["odd-length list cut to its field", (h) => [(h as string[])[0]]],
    ["a non-string value (number)", (h) => [(h as string[])[0], 7]],
  ];
  const readings: Record<string, unknown> = {};
  for (const [name, shape, whole] of shapes) {
    patch(shape, whole);
    let busy: unknown;
    try {
      busy = (await busyTimes(store)).length;
    } catch (error) {
      busy = `throws ${(error as Error).name}`;
    }
    const page = await offered();
    restore();
    readings[name] = [busy, page];
    is(`${name}: read as nothing busy (0) and the held time offered again`, [busy, page], [0, true]);
  }
  // Shapes that do not hide the hold, for the record.
  patch((h) => h, (answers) => [...answers, "extra"]);
  const extra = [(await busyTimes(store)).length, await offered()];
  restore();
  is("an extra reply after the hash: ignored, the hold still read (not exact, but not hidden)", extra, [1, false]);
  patch((h) => [...(h as string[]), "orphan"]);
  const orphan = [(await busyTimes(store)).length, await offered()];
  restore();
  is("odd-length list with a trailing orphan: the pair before it still read", orphan, [1, false]);
  patch((h) => [(h as string[])[0], null]);
  let nullValue: unknown;
  try {
    nullValue = (await busyTimes(store)).length;
  } catch (error) {
    nullValue = `throws ${(error as Error).name}`;
  }
  const nullPage = await offered();
  restore();
  is("a null value: TypeError on null.until, so the read fails closed by accident (page: unreadable)", [nullValue, nullPage], ["throws TypeError", "unreadable"]);
  is("the hold is still in the hash after every shape above", (await real([["HKEYS", busyHash]]))[0], [first.session]);

  part("(c) Buyer B books the held time while the reply is unknown");
  patch(() => null);
  const second = await hold();
  restore();
  is("holdAndCheckout's check inside the lock reads the same hash: B is let through", second.ok, true);
  is("a second Stripe checkout is opened for the same one-seat time", opened.length, 2);
  if (!second.ok) throw new Error("no second hold");
  const both = (await busyTimes(store)).filter((b) => b.start === at).map((b) => b.session).sort();
  is("healthy again: two holds on the one seat at the same start", both, [first.session, second.session].sort());
  // Both buyers pay: confirmBooking checks no time, so each becomes a booking.
  for (const session of [first.session, second.session]) {
    await confirmBooking({ store, product: listing, session, start: at, end: at + 30 * 60_000, buyerEmail: `${session.slice(-4)}@example.com`, buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
  }
  const booked = (await busyTimes(store)).filter((b) => b.start === at);
  is("after both pay: two bookings of a one-seat call at the same time (double booking)", booked.length, 2);
  const entries = (await real([["HGETALL", busyHash]]))[0] as string[];
  const untils = entries.filter((_, i) => i % 2 === 1).map((v) => (JSON.parse(v) as { until: number; s: number }).until === 0 && (JSON.parse(v) as { s: number }).s === at);
  is("both entries are now bookings (until 0) at the same start", untils, [true, true]);

  part("(c') A malformed value deletes the real hold for good");
  redis.clear();
  opened.length = 0;
  await claimHandle(OWNER, "mira", "Mira Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMira00001", true);
  await setSubscription(OWNER, { customerId: "cus_mira00001", subscriptionId: "sub_mira00001", active: true, tier: "creator", period: paidPeriod() });
  const again = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!again.ok) throw new Error("no product");
  await setProductCall(OWNER, again.product.id, weekly);
  const store2 = (await storeForEmail(OWNER)) as Store;
  busyHash = `nl:call:busy:${store2.callsId}`;
  const full2 = (await readProduct(store2, again.product.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store: store2, product: full2, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error("no hold");
  patch((h) => [(h as string[])[0], { not: "a string" }]);
  const seen = (await busyTimes(store2)).length;
  restore();
  is("a value that is an object: JSON.parse throws, read as a stale hold (0 busy)", seen, 0);
  is("…and HDEL'd: the real hold is gone from Redis though Redis never lost it", (await real([["HKEYS", busyHash]]))[0], []);
  const after = await holdAndCheckout({ store: store2, product: full2, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });
  is("with every later reply healthy, buyer B now holds the same time", after.ok, true);
  is("two checkouts open for the one seat", opened.length, 2);

  console.log(`\nreadings: ${JSON.stringify(readings)}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
