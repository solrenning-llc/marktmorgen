/**
 * The checkout lookup of a call's refund, read exactly (rules 24 and 30): Claude 3's M1 and Claude 4's MEDIUM on #3462 at
 * 19dab86962 and 1b3ea21d23. A 200 reply that is not an exact list of at most one session of that very payment is
 * unknown: the refund is not marked as read, it is held for the next pass and looked up again, inside the run's
 * REFUND_LOOKUPS ceiling, and the meeting ends once a lookup reads. Only an exact empty list, or an exact session that
 * is not a call of this store, marks it read.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { syncMeetings } from "@/lib/call-meetings";
import { callScope, readRecord, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_lookup_m1";
const OWNER = "spinner@example.com";
const ACCOUNT = "acct_1TestLookupM1x";
const NOW = Math.floor(Date.now() / 1000);
/** What the checkout lookup answers, per payment, in turn; the last one stays. */
const replies: Record<string, unknown[]> = {};
const lookedUp: Record<string, number> = {};
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent") ?? "";
    lookedUp[pi] = (lookedUp[pi] ?? 0) + 1;
    const queue = replies[pi] ?? [{ object: "list", data: [], has_more: false }];
    return answer(queue.length > 1 ? queue.shift() : queue[0]);
  }
  if (path === "/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    let rows = refunds.filter((r) => (r.created as number) >= gte).sort((a, b) => (b.created as number) - (a.created as number));
    if (after) rows = rows.slice(rows.findIndex((r) => r.id === after) + 1);
    return answer({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string) => ({ object: "charge", id, amount: 4900, amount_refunded: 4900, refunded: true });
const refund = (id: string, pi: string, chargeId: string, created: number) => ({ id, object: "refund", created, status: "succeeded", amount: 4900, payment_intent: pi, charge: charge(chargeId) });
const list = (data: unknown, more = false) => ({ object: "list", data, has_more: more });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "spinhouse", "Spin House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00010", subscriptionId: "sub_Owner00010", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Spinning call", "", "49", null);
  if (!guide.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const callsId = "e".repeat(16);
  const callStore: Store = { ...store, callsId };
  const callStart = Date.now() + 86_400_000;
  await redis.pipeline([["ZADD", MEET_STORES, callStart, `${callsId}|spinhouse`]]);
  await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(NOW - 2 * 86_400), "EX", 60 * 86_400]]);
  const sessionOf = (pi: string) => `cs_test_${pi.slice(3)}`;
  const scopeOf = (pi: string) => callScope(callsId, { group: false, session: sessionOf(pi), product: guide.product.id, start: callStart });
  const meeting = (pi: string): MeetRecord => ({
    provider: "google", scope: scopeOf(pi), statsId: store.statsId!, handle: "spinhouse", callsId, product: guide.product.id, session: sessionOf(pi), group: false,
    id: "", account: "", link: "https://marktmorgen.com/call", made: false, start: callStart, end: callStart + 3_600_000, tz: "UTC", title: "Spinning call",
    guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
  });
  const run = () => syncMeetings(async (handle) => (handle === "spinhouse" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  const gone = async (pi: string) => (await readRecord(scopeOf(pi)))?.gone === true;
  const seen = async (id: string) => Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, id]]))[0]);
  const session = (pi: string, over: Record<string, unknown> = {}) => ({
    id: sessionOf(pi), object: "checkout.session", payment_intent: pi,
    metadata: { kind: "call", store: "spinhouse", product: guide.product.id, start: String(callStart) },
    customer_details: { email: "buyer@example.com" }, ...over,
  });
  /** One call, refunded in full and succeeded; its lookup answers `odd` first, then its own session. */
  const oddThenRight = async (tag: string, odd: unknown, created: number) => {
    const pi = `pi_TestLookup${tag}`;
    await writeRecord(meeting(pi));
    replies[pi] = [odd, list([session(pi)])];
    refunds = [refund(`re_TestLookup${tag}`, pi, `ch_TestLookup${tag}`, created)];
    return pi;
  };

  const odd: [string, string, unknown][] = [
    ["Data", "data is not a list: { data: \"x\" }", list("x")],
    ["Row", "a row in another shape", list(["x"])],
    ["NoId", "a row with no id", list([{ object: "checkout.session", payment_intent: "pi_TestLookupNoId", metadata: { kind: "call", store: "spinhouse" } }])],
    ["Other", "a session for another payment", list([session("pi_TestLookupElse", { payment_intent: "pi_TestLookupElse" })])],
    ["NoPi", "a session that names no payment", list([session("pi_TestLookupNoPi", { payment_intent: null })])],
    ["Two", "two rows for one payment", list([session("pi_TestLookupTwo"), session("pi_TestLookupTwo", { id: "cs_test_TestLookupTwoB" })])],
    ["More", "more than one page for one payment", list([session("pi_TestLookupMore")], true)],
    ["Meta", "metadata in another shape", list([session("pi_TestLookupMeta", { metadata: "call" })])],
    ["Body", "a body that is not an object", "\"x\""],
    ["Null", "a null body", "null"],
    ["Flag", "no has_more", { object: "list", data: [] }],
  ];
  let at = NOW - 3600;
  for (const [tag, what, reply] of odd) {
    part(`M1: the checkout lookup answers ${what}: unknown, not read, held and looked up again`);
    const pi = await oddThenRight(tag, reply, (at += 10));
    await run();
    is(`${tag}: not marked as read after the odd reply`, await seen(`re_TestLookup${tag}`), 0);
    is(`${tag}: the meeting is not ended on it`, await gone(pi), false);
    for (let i = 0; i < 3 && !(await gone(pi)); i += 1) await run();
    is(`${tag}: once the lookup reads, the meeting ends`, await gone(pi), true);
    is(`${tag}: and the refund is read`, await seen(`re_TestLookup${tag}`), 1);
  }

  part("Exact answers still mark the refund read: an empty list, a session that is not a call of this store");
  const empty = "pi_TestLookupEmpty";
  replies[empty] = [list([])];
  refunds = [refund("re_TestLookupEmpty", empty, "ch_TestLookupEmpty", (at += 10))];
  await run();
  is("an exact empty list: read, looked up once", [await seen("re_TestLookupEmpty"), lookedUp[empty]], [1, 1]);
  await run();
  is("and never looked up again", lookedUp[empty], 1);
  const sale = "pi_TestLookupSale";
  replies[sale] = [list([session(sale, { metadata: { kind: "product", store: "spinhouse" } })])];
  refunds = [refund("re_TestLookupSale", sale, "ch_TestLookupSale", (at += 10))];
  await run();
  is("an exact session that is not a call: read", await seen("re_TestLookupSale"), 1);
  const elsewhere = "pi_TestLookupAway";
  replies[elsewhere] = [list([session(elsewhere, { metadata: { kind: "call", store: "someoneelse" } })])];
  refunds = [refund("re_TestLookupAway", elsewhere, "ch_TestLookupAway", (at += 10))];
  await run();
  is("an exact call session of another store: read", await seen("re_TestLookupAway"), 1);

  part("Ceiling: lookups that never read are tried again every run, never more than REFUND_LOOKUPS (10) a run");
  refunds = [];
  for (let i = 0; i < 14; i += 1) {
    const pi = `pi_TestLookupCap${String(i).padStart(2, "0")}`;
    replies[pi] = [list("x")];
    refunds.push(refund(`re_TestLookupCap${String(i).padStart(2, "0")}`, pi, `ch_TestLookupCap${String(i).padStart(2, "0")}`, (at += 10)));
  }
  const capped = () => Object.entries(lookedUp).filter(([pi]) => pi.startsWith("pi_TestLookupCap")).reduce((sum, [, n]) => sum + n, 0);
  await run();
  is("first run: at most 10 lookups", capped(), 10);
  await run();
  is("second run: tried again, at most 10 more", capped(), 20);
  is("none of them is ever marked read", (await Promise.all(refunds.map((r) => seen(r.id as string)))).every((n) => n === 0), true);
  const anchor = Number((await redis.pipeline([["GET", `nl:meet:rf:${callsId}:since`]]))[0]);
  is("the anchor stays at or below the oldest one held", anchor <= (refunds[0].created as number), true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
