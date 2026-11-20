/**
 * Claude 6's rule-24 audit, finding B1 (made a permanent test): the paid invoices of an invited store's customer are
 * what proves whether that customer paid us before the invite ("not brought to us by anyone"). A reply that is not
 * Stripe's list, a page that does not say whether more follow, a row that cannot be read, or a list that goes on past
 * the first page must never be read as "these are all the invoices": the older page may hold the payment made before
 * the invite. Each such store fails the run (retried the next day), earns nothing and is not marked. The healthy
 * single-page read and a confirmed empty list are unchanged; a second page is read to its end before anything is
 * decided.
 *
 * Claude 2's money review of #3221 (MEDIUM, the same reader): the fields of a paid invoice that set the money, the
 * "paid before the invite" mark and the share's day and currency are read exactly too. An amount, a credit-note
 * amount, a creation or payment time, a currency or a `parent` in an unknown shape is not 0, "usd" or "not a
 * subscription": the store fails the run, nothing is written or marked, and nothing is posted to Stripe.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription } from "@/lib/store";
import { settleInvites } from "@/lib/creator-invite-credit";
import { ALL_KEY, OWED_KEY, byKey, creditKey } from "@/lib/creator-invites";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";

const DAY = 86_400;
const NOW_MS = Date.UTC(2026, 9, 16, 12);
const NOW = Math.floor(NOW_MS / 1000);
const INVITED_AT = NOW - 60 * DAY;
const CUSTOMER = "cus_Invited01";

type Reply = (startingAfter: string | null, page: number) => unknown;
let invoiceReply: Reply = () => ({ object: "list", data: [], has_more: false });
let invoiceReads: string[] = [];
let posted: string[] = [];

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (method === "GET" && path === "/invoices") {
    invoiceReads.push(url.search);
    return answer(invoiceReply(url.searchParams.get("starting_after"), invoiceReads.length));
  }
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    return answer({ object: "list", data: [], has_more: false });
  }
  if (method === "POST" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    const credit = new URLSearchParams(String(init?.body ?? "")).get("metadata[nimbus_invite_credit]") ?? "";
    posted.push(credit);
    return answer({ id: `cbtxn_${posted.length}abcdef`, object: "customer_balance_transaction" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid subscription invoice. `daysAgo` sets when it was made and paid. */
function invoice(id: string, daysAgo: number): Record<string, unknown> {
  const at = NOW - daysAgo * DAY;
  return {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: 2_900,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: at,
    status_transitions: { paid_at: at },
    parent: { type: "subscription_details" },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id.slice(3)}` } }], has_more: false },
  };
}

/** Paid after the invite and past the refund window: it would earn the inviter a share. */
const RIPE = (id: string) => invoice(id, INVITE_HOLD_DAYS + 4);
/** Paid long before the invite: the store was not brought to us. */
const BEFORE = (id: string) => invoice(id, 400);

type Outcome = { failed: number; complete: boolean; credit: unknown; back: boolean; posted: string[]; reads: string[]; credits: string[] };

async function runCase(handle: string, reply: Reply, watch: string): Promise<Outcome> {
  redis.clear();
  invoiceReply = reply;
  invoiceReads = [];
  posted = [];
  const inviter = await claimHandle("inviter@example.com", "inviter-b1", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter@example.com", { customerId: "cus_Inviter01", subscriptionId: "sub_Inviter01", active: true });
  const made = await claimHandle(`${handle}@example.com`, handle, handle, "");
  if (!made.ok) throw new Error(`fixture failed: ${handle}`);
  await setSubscription(`${handle}@example.com`, { customerId: CUSTOMER, subscriptionId: "sub_Invited01", active: true });
  redis.run(["SET", byKey(made.store.sid), JSON.stringify({ r: inviter.store.sid, at: INVITED_AT, terms: { version: 1, sharePercent: 50, bonusCents: 0 } })]);
  redis.run(["ZADD", ALL_KEY, INVITED_AT, made.store.sid]);
  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const by = JSON.parse(String(redis.run(["GET", byKey(made.store.sid)]))) as { back?: boolean };
  const owed = redis.run(["SMEMBERS", OWED_KEY]);
  const credits = [...redis.keys().filter((key) => key.startsWith(creditKey(""))), ...(Array.isArray(owed) ? owed.map((id) => `owed:${String(id)}`) : [`owed:${String(owed)}`])];
  return { failed: run.failed, complete: run.complete, credit: redis.run(["GET", creditKey(watch)]), back: by.back === true, posted, reads: invoiceReads, credits };
}

const refused = (o: Outcome) => [o.failed >= 1, o.complete, o.credit, o.back, o.posted];
const REFUSED = [true, false, null, false, []];
/** Refused with nothing at all written: no share, no bonus, nothing owed. */
const refusedWhole = (o: Outcome) => [o.failed >= 1, o.complete, o.credits, o.back, o.posted];
const REFUSED_WHOLE = [true, false, [], false, []];

/** The invoice without one of its fields. */
function without(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...row };
  delete copy[field];
  return copy;
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_b1_invite_invoice_list_only";

  part("Controls: a whole single page and a confirmed empty list read as before");
  const healthy = await runCase("healthy-one", () => ({ object: "list", data: [RIPE("in_Healthy01")], has_more: false }), "in_Healthy01");
  is("a ripe invoice after the invite earns its share once and is posted", [healthy.failed, healthy.complete, healthy.back, healthy.posted], [0, true, false, ["in_Healthy01"]]);
  is("with one read of the invoices, asked exactly as before", healthy.reads, [`?${new URLSearchParams({ customer: CUSTOMER, status: "paid", limit: "100", "expand[]": "data.payments" })}`]);
  const empty = await runCase("empty-one", () => ({ object: "list", data: [], has_more: false }), "in_Nothing01");
  is("a confirmed empty list earns nothing and the run is complete", [empty.failed, empty.complete, empty.back, empty.posted], [0, true, false, []]);
  const before = await runCase("before-one", () => ({ object: "list", data: [RIPE("in_Before02"), BEFORE("in_Before01")], has_more: false }), "in_Before02");
  is("a payment before the invite on the whole page marks the store and earns nothing", [before.failed, before.complete, before.back, before.credit, before.posted], [0, true, true, null, []]);

  part("A reply in another shape is not \"no invoices\" (B1 a)");
  const shapes: [string, Reply][] = [
    ["no-object", () => ({ data: [RIPE("in_Shape0001")], has_more: false })],
    ["no-has-more", () => ({ object: "list", data: [RIPE("in_Shape0001")] })],
    ["odd-has-more", () => ({ object: "list", data: [RIPE("in_Shape0001")], has_more: "no" })],
    ["no-data", () => ({ object: "list", has_more: false })],
    ["data-object", () => ({ object: "list", data: { 0: RIPE("in_Shape0001") }, has_more: false })],
    ["too-many", () => ({ object: "list", data: Array.from({ length: 101 }, (_, i) => RIPE(`in_Many${String(i).padStart(4, "0")}`)), has_more: false })],
    ["odd-row", () => ({ object: "list", data: [RIPE("in_Shape0001"), { ...BEFORE("in_x"), id: 42 }], has_more: false })],
    ["null-row", () => ({ object: "list", data: [RIPE("in_Shape0001"), null], has_more: false })],
    ["unpaid-row", () => ({ object: "list", data: [RIPE("in_Shape0001"), { ...BEFORE("in_Unpaid001"), status: "open" }], has_more: false })],
  ];
  for (const [name, reply] of shapes) {
    const o = await runCase(name, reply, "in_Shape0001");
    is(`${name}: the store fails the run, earns nothing, is not marked, nothing is posted`, refused(o), REFUSED);
  }

  part("More than one page: the older invoices are read before anything is decided (B1 b)");
  const paged = await runCase("paged-before", (after) => (after === null
    ? { object: "list", data: [RIPE("in_Paged0002")], has_more: true }
    : after === "in_Paged0002"
      ? { object: "list", data: [BEFORE("in_Paged0001")], has_more: false }
      : { object: "list", data: [], has_more: false }), "in_Paged0002");
  is("the payment before the invite on the second page marks the store and earns nothing", [paged.failed, paged.complete, paged.back, paged.credit, paged.posted], [0, true, true, null, []]);
  is("the second page is read after the first one's last invoice", paged.reads.map((q) => new URLSearchParams(q).get("starting_after")), [null, "in_Paged0002"]);
  const pagedRipe = await runCase("paged-ripe", (after) => (after === null
    ? { object: "list", data: [RIPE("in_Ripe00002")], has_more: true }
    : { object: "list", data: [RIPE("in_Ripe00001")], has_more: false }), "in_Ripe00001");
  is("two whole pages after the invite: the oldest invoice earns its share", [pagedRipe.failed, pagedRipe.complete, pagedRipe.back, pagedRipe.posted.sort()], [0, true, false, ["in_Ripe00001", "in_Ripe00002"]]);
  const hollow = await runCase("more-but-empty", () => ({ object: "list", data: [], has_more: true }), "in_Nothing01");
  is("a page that says there is more but has no rows is unknown", refused(hollow), REFUSED);
  const endless = await runCase("endless", (_after, page) => ({ object: "list", data: [RIPE(`in_Endless${String(page).padStart(4, "0")}`)], has_more: true }), "in_Endless0001");
  is("a list still going on after the last page read is unknown: nothing earned or marked", refused(endless), REFUSED);
  is("and it is read a bounded number of times", endless.reads.length <= 10, true);
  const brokenSecond = await runCase("broken-second", (after) => (after === null
    ? { object: "list", data: [RIPE("in_Broken002")], has_more: true }
    : { object: "list", has_more: false }), "in_Broken002");
  is("a second page in another shape is unknown", refused(brokenSecond), REFUSED);

  part("The fields that set the money are read exactly (Claude 2's review of #3221)");
  const ripe = RIPE("in_Field0001");
  const at = ripe.created as number;
  const fields: [string, Record<string, unknown>[]][] = [
    ["notes-as-text", [{ ...ripe, post_payment_credit_notes_amount: "2900" }]],
    ["notes-negative", [{ ...ripe, post_payment_credit_notes_amount: -1 }]],
    ["notes-missing", [without(ripe, "post_payment_credit_notes_amount")]],
    ["created-as-text-on-an-older-row", [ripe, { ...BEFORE("in_FieldOld01"), created: String(NOW - 400 * DAY) }]],
    ["created-zero", [{ ...ripe, created: 0 }]],
    ["created-missing", [without(ripe, "created")]],
    ["amount-as-text", [{ ...ripe, amount_paid: "2900" }]],
    ["amount-fraction", [{ ...ripe, amount_paid: 2_900.5 }]],
    ["amount-negative", [{ ...ripe, amount_paid: -2_900 }]],
    ["currency-number", [{ ...ripe, currency: 978 }]],
    ["currency-uppercase", [{ ...ripe, currency: "USD" }]],
    ["currency-odd-text", [{ ...ripe, currency: "us dollars" }]],
    ["currency-missing", [without(ripe, "currency")]],
    ["paid-at-missing", [{ ...ripe, status_transitions: {} }]],
    ["paid-at-as-text", [{ ...ripe, status_transitions: { paid_at: String(at) } }]],
    ["paid-at-zero", [{ ...ripe, status_transitions: { paid_at: 0 } }]],
    ["status-transitions-null", [{ ...ripe, status_transitions: null }]],
    ["parent-as-text", [{ ...ripe, parent: "subscription_details" }]],
    ["parent-list", [{ ...ripe, parent: [] }]],
    ["parent-missing", [without(ripe, "parent")]],
  ];
  for (const [n, [name, rows]] of fields.entries()) {
    const o = await runCase(`field-${String(n).padStart(2, "0")}`, () => ({ object: "list", data: rows, has_more: false }), "in_Field0001");
    is(`${name}: the store fails the run, nothing is written or marked, nothing is posted`, refusedWhole(o), REFUSED_WHOLE);
  }
  const parentNull = await runCase("parent-null", () => ({ object: "list", data: [RIPE("in_Field0002"), { ...RIPE("in_Field0003"), parent: null }], has_more: false }), "in_Field0002");
  is("control: a paid invoice with no parent is known (not a plan's), earns nothing, the plan's invoice earns", [parentNull.failed, parentNull.complete, parentNull.back, parentNull.posted], [0, true, false, ["in_Field0002"]]);
  const zeroPaid = await runCase("zero-paid", () => ({ object: "list", data: [RIPE("in_Field0004"), { ...BEFORE("in_FieldOld02"), amount_paid: 0 }], has_more: false }), "in_Field0004");
  is("control: an older invoice that paid nothing does not mark the store; the ripe one earns", [zeroPaid.failed, zeroPaid.complete, zeroPaid.back, zeroPaid.posted], [0, true, false, ["in_Field0004"]]);
  const healthyShare = JSON.parse(String(healthy.credit)) as { cents?: unknown; cur?: unknown; at?: unknown };
  is("control: the healthy share keeps its amount, currency and day", [healthyShare.cents, healthyShare.cur, healthyShare.at], [1_450, "usd", NOW - (INVITE_HOLD_DAYS + 4) * DAY]);
  done();
}

void main();
