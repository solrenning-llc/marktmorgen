/**
 * An offer after paying whose bank payment is still "processing" after two days (lib/upsell.ts,
 * settlePendingOffers): a follow-up to DISC-B-4.
 *
 * The five-minute job let a pending offer go after two days. A bank debit Stripe still answers "processing"
 * can clear later; once it succeeded, nothing settled it unless the buyer came back to the thanks page, so the
 * creator's confirmation email, count and affiliate commission (afterPaid) never ran for a buyer who paid.
 *
 *   - still "processing" after two days: kept on the job's list, looked at again a day later;
 *   - a success on the fifth day: settled by the job, paid once with no second charge, confirmation sent;
 *   - an offer whose payment is not processing (waiting on the buyer's bank page) is still let go after two days;
 *   - nothing is watched for more than seven days, inside the offer record's own eight;
 *   - one Stripe read that fails (an error status) past the second day is unknown, not "not processing" (rule 24):
 *     the offer stays on the list, looked at a day later, and a later success is still settled by the job; a
 *     read that keeps failing stays inside the same looks and the same seven days; an answer that was read and
 *     is about another offer is still let go.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, storeForHandle, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readUpsell, settlePendingOffers, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { COMMAND, OFFER_WATCH_LOOK_COMMANDS_MOST, OFFER_WATCH_LOOKS_MOST, OFFER_WATCH_SHARE_OF_ORDER_COMPUTE, ORDER_COMPUTE } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_settle_late_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
/** What the next POST /payment_intents answers. */
let nextCharge: "succeeded" | "requires_action" | "declined" | "lost" | "processing" | "requires_payment_method" = "succeeded";
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};
const emails: string[] = [];
const stripeReads: string[] = [];
/** Payments whose GET Stripe answers with an error, as a 500 or a timeout would. */
const unreadable = new Set<string>();
/** The clock the job reads: moved forward to stand for days passing. */
const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const DAY = 24 * 60 * 60 * 1000;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(String(init?.body ?? ""));
    return answer({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    charges.push({ body, key });
    if (nextCharge === "declined") return answer({ error: { code: "card_declined", message: "Your card was declined." } }, 402);
    const pi = {
      id: `pi_Test${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: nextCharge === "requires_action" || nextCharge === "processing" || nextCharge === "requires_payment_method" ? nextCharge : "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      ...(nextCharge === "requires_action" ? { next_action: { redirect_to_url: { url: "https://hooks.stripe.com/3ds/confirm" } } } : {}),
    };
    made.push(pi);
    // Charged, and the answer never reached us.
    if (nextCharge === "lost") throw new TypeError("fetch failed");
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    return answer({ object: "list", data: url.searchParams.get("customer") === "cus_TestBuyer01" ? made : [], has_more: false });
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    stripeReads.push(path);
    if (unreadable.has(one[1])) return answer({ error: { message: "stand-in for a Stripe error" } }, 500);
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the browser key it carried. */
function paidCheckout(id: string, product: string, fingerprint: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "harbor", product, upsell_key: fingerprint },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    ...over,
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const upsell = await add("Starter Kit Guide", "29");
  const downsell = await add("Starter Checklist", "15");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [
      { id: "kit001", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: "list01", no: null },
      { id: "list01", productId: downsell, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();
  const take = async (session: string, step: string, answer: "yes" | "no") =>
    takeUpsell({ store, session, secret: browser.secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });

  const job = () => settlePendingOffers(async (handle) => (handle === "harbor" ? store : null), Date.now() + 60_000);
  const listed = async (session: string) => (await redis.pipeline([["ZSCORE", "nl:upsell:pending", `harbor|${session}|`]]))[0];

  part("RED: a bank payment still processing after two days stays on the job's list");
  nextCharge = "processing";
  sessions.cs_test_settlelate000001 = paidCheckout("cs_test_settlelate000001", front, browser.fingerprint);
  is("checking for the buyer", (await take("cs_test_settlelate000001", "kit001", "yes")).kind, "checking");
  ahead = 2 * DAY + 60_000;
  await job();
  is("RED: still listed after the second day", (await listed("cs_test_settlelate000001")) !== null, true);
  is("looked at again a day later, not on every pass", Number(await listed("cs_test_settlelate000001")) - Date.now() > 23 * 60 * 60 * 1000, true);
  is("still pending, nothing more charged", [(await readUpsell("cs_test_settlelate000001"))?.state, charges.length], ["pending", 1]);

  part("RED: it clears on the fifth day: the job hands it over in full");
  made[0].status = "succeeded";
  const before = emails.length;
  ahead = 5 * DAY;
  const counts = await job();
  is("RED: settled by the job: paid, with no second charge", [(await readUpsell("cs_test_settlelate000001"))?.state, charges.length, counts.settled], ["paid", 1, 1]);
  is("RED: the confirmation is sent (afterPaid ran)", emails.length > before, true);
  is("and off the job's list", await listed("cs_test_settlelate000001"), null);

  part("What one late look costs");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000004 = paidCheckout("cs_test_settlelate000004", front, browser.fingerprint);
  await take("cs_test_settlelate000004", "kit001", "yes");
  ahead = 3 * DAY;
  const plain = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = async (list: (string | number)[][]) => {
    commands += list.length;
    return plain(list);
  };
  await settlePendingOffers(storeForHandle, Date.now() + 60_000);
  redis.pipeline = plain;
  is("one late look, with the store's record read and the run's read of the list, is within its declared commands", commands <= OFFER_WATCH_LOOK_COMMANDS_MOST, true);
  const id = String(made[made.length - 1].id);
  const looksBefore = stripeReads.filter((path) => path.endsWith(id)).length;
  for (ahead = 3 * DAY; ahead <= 8 * DAY; ahead += 60 * 60 * 1000) await job();
  const looks = stripeReads.filter((path) => path.endsWith(id)).length - looksBefore + 1;
  is("still processing all week: looked at no more than its declared number of times after the second day", looks <= OFFER_WATCH_LOOKS_MOST, true);
  is("and let go by the eighth day", await listed("cs_test_settlelate000004"), null);

  part("RED: every look at one waiting offer, from its first minute to its last day, inside a declared cost");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000005 = paidCheckout("cs_test_settlelate000005", front, browser.fingerprint);
  const plainTake = redis.pipeline.bind(redis);
  let taking = 0;
  redis.pipeline = async (list: (string | number)[][]) => {
    taking += list.length;
    return plainTake(list);
  };
  is("taken: checking", (await take("cs_test_settlelate000005", "kit001", "yes")).kind, "checking");
  redis.pipeline = plainTake;
  const watched = String(made[made.length - 1].id);
  const lookedAt = () => stripeReads.filter((path) => path.endsWith(watched)).length;
  let watchCommands = 0;
  for (ahead = 60_000; ahead <= 8 * DAY; ahead += 5 * 60_000) {
    const seen = lookedAt();
    let run = 0;
    redis.pipeline = async (list: (string | number)[][]) => {
      run += list.length;
      return plainTake(list);
    };
    await job();
    redis.pipeline = plainTake;
    if (lookedAt() > seen) watchCommands += run;
  }
  const watchLooks = lookedAt();
  is("let go by the eighth day", await listed("cs_test_settlelate000005"), null);
  is("RED: looked at no more than its declared number of times in all", [watchLooks, watchLooks <= OFFER_WATCH_LOOKS_MOST], [watchLooks, true]);
  is("RED: its looks' commands within the declared figure", watchCommands <= OFFER_WATCH_LOOKS_MOST * OFFER_WATCH_LOOK_COMMANDS_MOST, true);
  is(
    "every look of one offer inside its declared share of an order's compute",
    OFFER_WATCH_LOOKS_MOST * OFFER_WATCH_LOOK_COMMANDS_MOST * COMMAND <= OFFER_WATCH_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE,
    true,
  );
  is(
    "and the offer's own answer fits in what is left of an order's compute",
    taking * COMMAND <= (1 - OFFER_WATCH_SHARE_OF_ORDER_COMPUTE) * ORDER_COMPUTE,
    true,
  );

  part("Not processing: an offer waiting on the buyer's bank page is still let go after two days");
  ahead = 0;
  nextCharge = "requires_action";
  sessions.cs_test_settlelate000002 = paidCheckout("cs_test_settlelate000002", front, browser.fingerprint);
  is("sent to confirm", (await take("cs_test_settlelate000002", "kit001", "yes")).kind, "confirm");
  ahead = 2 * DAY + 60_000;
  await job();
  is("off the list after two days", await listed("cs_test_settlelate000002"), null);

  part("Nothing is watched for more than seven days");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000003 = paidCheckout("cs_test_settlelate000003", front, browser.fingerprint);
  is("checking", (await take("cs_test_settlelate000003", "kit001", "yes")).kind, "checking");
  ahead = 7 * DAY + 60_000;
  await job();
  is("still processing after the seventh day: let go", await listed("cs_test_settlelate000003"), null);

  part("RED: one Stripe read that fails past the second day does not end the watch of a payment still processing");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000006 = paidCheckout("cs_test_settlelate000006", front, browser.fingerprint);
  is("checking for the buyer", (await take("cs_test_settlelate000006", "kit001", "yes")).kind, "checking");
  const late = made[made.length - 1];
  for (ahead = 60_000; ahead <= 2 * DAY; ahead += 30 * 60_000) await job();
  is("still listed, still processing, through the second day", [(await listed("cs_test_settlelate000006")) !== null, late.status], [true, "processing"]);
  unreadable.add(String(late.id));
  ahead = 2 * DAY + 2 * 60_000;
  const readsBefore = stripeReads.filter((path) => path.endsWith(String(late.id))).length;
  await job();
  is("the job did ask Stripe, and was not answered", stripeReads.filter((path) => path.endsWith(String(late.id))).length, readsBefore + 1);
  is("RED: still listed after an unread Stripe answer", (await listed("cs_test_settlelate000006")) !== null, true);
  is("looked at again a day later, not on every pass", Number(await listed("cs_test_settlelate000006")) - Date.now() > 23 * 60 * 60 * 1000, true);
  is("still pending, still checking, nothing more charged", [(await readUpsell("cs_test_settlelate000006"))?.state, (await readUpsell("cs_test_settlelate000006"))?.waiting, charges.length], ["pending", "processing", charges.length]);
  unreadable.delete(String(late.id));
  late.status = "succeeded";
  const mailed = emails.length;
  const charged = charges.length;
  ahead = 4 * DAY;
  const settledLate = await job();
  is("RED: the late success is settled by the job: paid, with no second charge", [(await readUpsell("cs_test_settlelate000006"))?.state, charges.length, settledLate.settled], ["paid", charged, 1]);
  is("RED: the confirmation is sent (afterPaid ran)", emails.length > mailed, true);
  is("and off the job's list", await listed("cs_test_settlelate000006"), null);

  part("A Stripe read that keeps failing: the same daily looks, still let go by the eighth day");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000007 = paidCheckout("cs_test_settlelate000007", front, browser.fingerprint);
  await take("cs_test_settlelate000007", "kit001", "yes");
  const down = String(made[made.length - 1].id);
  unreadable.add(down);
  for (ahead = 60_000; ahead <= 6 * DAY + 12 * 60 * 60 * 1000; ahead += 30 * 60_000) await job();
  is("still listed on its sixth day, left pending: never marked paid or failed on an unknown", [(await listed("cs_test_settlelate000007")) !== null, (await readUpsell("cs_test_settlelate000007"))?.state], [true, "pending"]);
  for (; ahead <= 9 * DAY; ahead += 30 * 60_000) await job();
  const downLooks = stripeReads.filter((path) => path.endsWith(down)).length;
  is("looked at no more than its declared number of times in all", [downLooks, downLooks <= OFFER_WATCH_LOOKS_MOST], [downLooks, true]);
  is("let go once its seven days are over", await listed("cs_test_settlelate000007"), null);
  unreadable.delete(down);

  part("RED: an offer waiting on the buyer's bank page whose read fails on the second day is not let go on the unknown");
  ahead = 0;
  nextCharge = "requires_action";
  sessions.cs_test_settlelate000008 = paidCheckout("cs_test_settlelate000008", front, browser.fingerprint);
  is("sent to confirm", (await take("cs_test_settlelate000008", "kit001", "yes")).kind, "confirm");
  const asked = String(made[made.length - 1].id);
  unreadable.add(asked);
  ahead = 2 * DAY + 2 * 60_000;
  await job();
  is("RED: still listed after an unread Stripe answer", (await listed("cs_test_settlelate000008")) !== null, true);
  unreadable.delete(asked);
  ahead = 3 * DAY + 5 * 60_000;
  await job();
  is("read again, still waiting on the buyer: let go", await listed("cs_test_settlelate000008"), null);

  part("An answer that was read and is about another offer is still let go after two days");
  ahead = 0;
  nextCharge = "processing";
  sessions.cs_test_settlelate000009 = paidCheckout("cs_test_settlelate000009", front, browser.fingerprint);
  await take("cs_test_settlelate000009", "kit001", "yes");
  const other = made[made.length - 1];
  other.metadata = { ...(other.metadata as Record<string, string>), step: "other1" };
  ahead = 2 * DAY + 2 * 60_000;
  await job();
  is("off the list: read, and not about this offer", await listed("cs_test_settlelate000009"), null);

  done();
}

void main();
