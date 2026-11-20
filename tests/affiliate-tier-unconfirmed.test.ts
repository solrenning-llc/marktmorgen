/**
 * A second tier waiting as "buyer not confirmed" (owner, through Claude 1, 9 November 2026, 15h42), part (a): the order
 * is read again by the five-minute job and decided by itself when its buyer's address can be read. Bounded: at most
 * UNCONFIRMED_BATCH orders a run, each read again no sooner than UNCONFIRMED_READ_AGAIN after a read that found no
 * address, an hour after one that failed, and none after UNCONFIRMED_DAYS. Nothing personal is kept: the sale is
 * rewritten with tierOff (or with neither mark), never with an address.
 */
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteCharge, noteSession, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_unconfirmed";
process.env.RESEND_API_KEY = "re_test_tier_unconfirmed";

const OWNER = "chef@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

type Settle = (store: unknown, now?: number, deadline?: number) => Promise<{ decided: number; waiting: number; failed: number }>;
const settle: Settle = (affiliates as unknown as { settleUnconfirmed?: Settle }).settleUnconfirmed ?? (async () => ({ decided: -1, waiting: -1, failed: -1 }));
const BATCH = (affiliates as unknown as { UNCONFIRMED_BATCH?: number }).UNCONFIRMED_BATCH ?? 0;
const AGAIN = (affiliates as unknown as { UNCONFIRMED_READ_AGAIN?: number }).UNCONFIRMED_READ_AGAIN ?? 0;
const DAYS = (affiliates as unknown as { UNCONFIRMED_DAYS?: number }).UNCONFIRMED_DAYS ?? 0;

// What Stripe answers for each order read again, and what was asked.
let sessions: Record<string, unknown> = {};
let intents: Record<string, unknown> = {};
let down = false;
let asked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const one = url.pathname.match(/^\/v1\/(checkout\/sessions|payment_intents)\/([A-Za-z0-9_]+)$/);
  if (one) {
    asked.push(`${one[1]}/${one[2]}`);
    if (down) return answer({ error: { message: "down" } }, 500);
    const found = (one[1] === "payment_intents" ? intents : sessions)[one[2]];
    return found ? answer(found) : answer({ error: { message: "no such" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

async function setup() {
  redis.clear();
  sessions = {};
  intents = {};
  down = false;
  asked = [];
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierUncf1", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  return { store, statsId };
}

const order = (id: string, email: string | null, at = NOW - 600) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: at,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" },
  customer_details: { email },
});

const kept = async (statsId: string, ref: string) => {
  const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]])) as [string | null];
  return raw ? (JSON.parse(raw) as { tierOff?: number; buyerUnknown?: number }) : null;
};
const tier = async (store: Awaited<ReturnType<typeof setup>>["store"], ref: string) => (await readBook(store)).lines.find((l) => l.ref === `tier2:${ref}`);

async function main(): Promise<void> {
  part("U0: the bounds are named");
  is("a batch, a wait and a span, all positive", [BATCH > 0, AGAIN > 0, DAYS > 0], [true, true, true]);

  part("U1: an order whose address can be read now is decided by itself: somebody else's, the tier is paid");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_later1", null));
    is("written waiting", (await kept(statsId, "cs_later1"))?.buyerUnknown, 1);
    is("shown waiting", (await tier(store, "cs_later1"))?.status, "buyer not confirmed");
    sessions.cs_later1 = { id: "cs_later1", customer_details: { email: "kai@example.com" } };
    const ran = await settle(store, NOW + 60);
    is("decided, nothing waiting, nothing failed", [ran.decided, ran.waiting, ran.failed], [1, 0, 0]);
    is("one request to Stripe, for that order", asked, ["checkout/sessions/cs_later1"]);
    const sale = await kept(statsId, "cs_later1");
    is("the sale no longer waits and has no tierOff", [sale?.buyerUnknown, sale?.tierOff], [undefined, undefined]);
    is("its address is kept nowhere in the sale", JSON.stringify(sale).includes("kai@"), false);
    const line = await tier(store, "cs_later1");
    is("the tier is earned", [line?.status, line?.commission], ["earned", 500]);
    const book = await readBook(store);
    is("payable now, and none is counted as waiting", [book.rows.find((r) => r.affiliate.id === ANA)?.payable, book.unconfirmed], [500, 0]);
  }

  part("U2: an order whose address turns out to be the inviter's: decided as tierOff, never paid");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_later2", null));
    sessions.cs_later2 = { id: "cs_later2", customer_details: { email: "Ana+x@Example.com" } };
    await settle(store, NOW + 60);
    const sale = await kept(statsId, "cs_later2");
    is("tierOff, no longer waiting", [sale?.tierOff, sale?.buyerUnknown], [1, undefined]);
    is("no second tier at all", await tier(store, "cs_later2"), undefined);
    is("nothing waiting", (await readBook(store)).unconfirmed, 0);
  }

  part("U3: an order with still no address waits and is not read again at once; a payment intent is read by its receipt or charge");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_none", null));
    sessions.cs_none = { id: "cs_none", customer_details: { email: null } };
    await noteCharge(store, { id: "pi_up1", status: "succeeded", amount: 1_000, currency: "usd", created: NOW - 60, metadata: { store: "harbor", product: "prod01", title: "Jam", kind: "upsell", parent: "cs_x", via: BEA, via_rate: "30" } });
    intents.pi_up1 = { id: "pi_up1", receipt_email: null, latest_charge: { billing_details: { email: "kai@example.com" } } };
    const first = await settle(store, NOW + 60);
    is("one decided from the charge's billing address, one still waiting", [first.decided, first.waiting, first.failed], [1, 1, 0]);
    is("each asked once", asked.sort(), ["checkout/sessions/cs_none", "payment_intents/pi_up1"]);
    is("the one without an address still waits", (await kept(statsId, "cs_none"))?.buyerUnknown, 1);
    asked = [];
    const again = await settle(store, NOW + 120);
    is("a minute later nothing is read again", [again.decided, again.waiting, again.failed, asked.length], [0, 0, 0, 0]);
    sessions.cs_none = { id: "cs_none", customer_details: { email: "kai@example.com" } };
    const later = await settle(store, NOW + 60 + AGAIN + 1);
    is("after the wait it is read again, and decided", [later.decided, asked], [1, ["checkout/sessions/cs_none"]]);
    is("both are paid now", [(await tier(store, "cs_none"))?.status, (await tier(store, "pi_up1"))?.status], ["earned", "earned"]);
  }

  part("U4: Stripe not answering is not an address: the order waits, is counted failed, and is tried again within the hour");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_down", null));
    sessions.cs_down = { id: "cs_down", customer_details: { email: "ana@example.com" } };
    down = true;
    const failed = await settle(store, NOW + 60);
    is("failed, not decided, not denied", [failed.decided, failed.failed], [0, 1]);
    is("still waiting, never tierOff on a guess", [(await kept(statsId, "cs_down"))?.buyerUnknown, (await kept(statsId, "cs_down"))?.tierOff], [1, undefined]);
    down = false;
    asked = [];
    const soon = await settle(store, NOW + 60 + 30 * 60);
    is("half an hour later: not read yet", asked.length, 0);
    const hour = await settle(store, NOW + 60 + 3_700);
    is("an hour later: read, and the inviter's own purchase is decided", [hour.decided, (await kept(statsId, "cs_down"))?.tierOff], [1, 1]);
    void soon;
  }

  part("U5: an answer for another order is not this order's address");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_mix", null));
    sessions.cs_mix = { id: "cs_other", customer_details: { email: "kai@example.com" } };
    const ran = await settle(store, NOW + 60);
    is("failed, still waiting", [ran.decided, ran.failed, (await kept(statsId, "cs_mix"))?.buyerUnknown], [0, 1, 1]);
  }

  part("U6: at most UNCONFIRMED_BATCH orders a run, and none older than UNCONFIRMED_DAYS");
  {
    const { store, statsId } = await setup();
    for (let i = 0; i < BATCH + 3; i += 1) {
      await noteSession(store, order(`cs_many${i}`, null));
      sessions[`cs_many${i}`] = { id: `cs_many${i}`, customer_details: { email: "kai@example.com" } };
    }
    const first = await settle(store, NOW + 60);
    is("one run decides a batch, no more", [first.decided, asked.length], [BATCH, BATCH]);
    const second = await settle(store, NOW + 61);
    is("the next run takes the rest", second.decided, 3);
    is("none waits", (await readBook(store)).unconfirmed, 0);

    await noteSession(store, order("cs_old", null, NOW - (DAYS + 1) * DAY));
    sessions.cs_old = { id: "cs_old", customer_details: { email: "kai@example.com" } };
    asked = [];
    const old = await settle(store, NOW + 62);
    is("an order past the span is not read", [old.decided, asked.length], [0, 0]);
    is("it still waits for the creator", [(await kept(statsId, "cs_old"))?.buyerUnknown, (await readBook(store)).unconfirmed], [1, 1]);
  }

  part("U7: a sale the creator or the job already decided is dropped from the list without a read");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_gone", null));
    const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, "cs_gone"]])) as [string];
    const decided = JSON.parse(raw) as Record<string, unknown>;
    delete decided.buyerUnknown;
    await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_gone", JSON.stringify(decided)]]);
    asked = [];
    const ran = await settle(store, NOW + 60);
    is("nothing read, nothing counted", [ran.decided, ran.waiting, ran.failed, asked.length], [0, 0, 0, 0]);
  }
  done();
}

void main();
