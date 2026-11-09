/**
 * A paid order whose count is not confirmed keeps the room its checkout was
 * admitted with (lib/orders.ts, countOrder answers "unknown"; Claude 2's and
 * Claude 3's money reviews of #3398, CX-123 rule 24).
 *
 * An admitted checkout holds one place in its store's figure
 * (lib/order-admission.ts) until its order is counted, and only then is the
 * place given back (settleAdmitted). Given back while the count is unknown,
 * the paid order is in neither the count nor the held room, and the store can
 * take one order more than its figure. What is checked, for a paid checkout
 * (lib/purchase-email.ts, confirmPurchase) and for a paid one-click offer
 * (lib/upsell.ts, takeUpsell, and its confirmation, confirmOffer):
 *
 *   - control: a healthy order is counted once and its place given back;
 *   - a count that keeps failing, or a count key that is not a whole number:
 *     the place stays held, so count + held still covers the order;
 *   - a paid offer whose confirmation email the sender refused is still one
 *     of the month's orders: counted, then its place given back;
 *   - a paid offer settled later (the bank asked the buyer to confirm) is
 *     counted whether or not its email went.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { readListing } from "@/lib/catalog";
import { allowanceWindow } from "@/lib/allowance-window";
import { ADMITTED_FIELD, admitOrders } from "@/lib/order-admission";
import { ordersIn } from "@/lib/orders";
import { confirmPurchase } from "@/lib/purchase-email";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { newUpsellKey, readUpsell, settleUpsells, takeUpsell } from "@/lib/upsell";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_count_unknown_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

type Commands = (string | number)[][];
const OWNER = "count-unknown@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestCountUnk01";
const NOW = Math.floor(Date.now() / 1000);

/** Whether the sender refuses the next emails (a 422 from Resend: not accepted). */
let senderRefuses = false;
let emailsAccepted = 0;
/** What the next one-click charge answers. */
let nextCharge: "succeeded" | "requires_action" = "succeeded";
/** Run once a one-click charge is made (after its checkout was admitted), then cleared. */
let onCharge: (() => Promise<void>) | null = null;
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (senderRefuses) return answer({ name: "validation_error", message: "refused" }, 422);
    emailsAccepted += 1;
    return answer({ id: `email_${emailsAccepted}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const pi = {
      id: `pi_TestOffer${String(made.length + 1).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: nextCharge,
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      ...(nextCharge === "requires_action" ? { next_action: { redirect_to_url: { url: "https://hooks.stripe.com/3ds/confirm" } } } : {}),
    };
    made.push(pi);
    const then = onCharge;
    onCharge = null;
    if (then) await then();
    return answer(pi);
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: made, has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  await claimHandle(OWNER, "countunknown", "Count Unknown", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_CountUnk0001", subscriptionId: "sub_CountUnk0001", active: true, tier: "creator", period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const offer = await add("Starter Kit Guide", "29");
  const funnel = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: offer, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("set up: the offer after paying is accepted", funnel.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, front))!;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store);
  is("set up: a paying store with a known billing window", Boolean(window), true);
  const windowId = window!.id;

  const plain = redis.pipeline.bind(redis);
  const isCount = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:orders-count:"));
  /** Every round trip of an order's count fails, whatever else goes through. */
  const countFails = () => {
    redis.pipeline = async (commands: Commands) => {
      if (isCount(commands)) throw new Error("connection lost");
      return plain(commands);
    };
  };
  const healthy = () => {
    redis.pipeline = plain;
  };
  const counted = () => ordersIn(folder, windowId);
  /** What every hour still holds for the store's admitted checkouts. */
  const held = async () => {
    const all = (await plain([["HGETALL", `nl:orders:open:${folder}`]]))[0];
    const values = Array.isArray(all) ? all.filter((_, i) => i % 2 === 1) : Object.values((all ?? {}) as Record<string, unknown>);
    return values.reduce((sum: number, v) => sum + (Number(v) || 0), 0);
  };
  const countKey = `nl:orders:n:${folder}:${windowId}`;

  let serial = 0;
  const sessionId = () => `cs_test_countunk${String((serial += 1)).padStart(12, "0")}`;
  const paidCheckout = async () => {
    const admitted = await admitOrders(store, 1);
    if (!admitted.ok || admitted.hour === null) throw new Error("not admitted");
    const id = sessionId();
    const session = {
      id,
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      created: NOW - 60,
      amount_total: 4900,
      currency: "usd",
      payment_intent: `pi_${id.slice(-12)}`,
      metadata: { store: store.handle, product: product.id, [ADMITTED_FIELD]: String(admitted.hour) },
      customer_details: { email: BUYER },
    };
    return { id, session: session as never };
  };

  part("A paid checkout (confirmPurchase): control");
  {
    const before = [await counted(), await held()];
    const { id, session } = await paidCheckout();
    is("admitted: one place held", (await held()) - before[1], 1);
    is("confirmed", await confirmPurchase(store, id, session), "sent");
    is("counted once, and its place given back", [(await counted()) - before[0], (await held()) - before[1]], [1, 0]);
  }

  part("A paid checkout whose count keeps failing keeps its place held");
  {
    const before = [await counted(), await held()];
    const { id, session } = await paidCheckout();
    countFails();
    const outcome = await confirmPurchase(store, id, session).catch(() => "threw");
    healthy();
    is("the buyer still has their email", outcome, "sent");
    is("not counted", (await counted()) - before[0], 0);
    is("its place stays held, so the paid order is still in count + held", (await held()) - before[1], 1);
  }

  part("A paid checkout whose count is not a whole number keeps its place held");
  {
    const kept = (await plain([["GET", countKey]]))[0];
    const before = await held();
    const { id, session } = await paidCheckout();
    await plain([["SET", countKey, "not-a-count"]]);
    const outcome = await confirmPurchase(store, id, session).catch(() => "threw");
    is("the buyer still has their email", outcome, "sent");
    is("the count is left as it was", (await plain([["GET", countKey]]))[0], "not-a-count");
    is("its place stays held", (await held()) - before, 1);
    await plain([["SET", countKey, String(kept)], ["EXPIRE", countKey, 400 * 86_400]]);
  }

  const browser = newUpsellKey();
  const offerCheckout = () => {
    const id = sessionId();
    sessions[id] = {
      id,
      status: "complete",
      payment_status: "paid",
      created: NOW - 60,
      customer: "cus_TestBuyer01",
      currency: "usd",
      metadata: { store: store.handle, product: front, upsell_key: browser.fingerprint },
      customer_details: { email: BUYER },
      payment_intent: { id: `pi_test_front${String(serial).padStart(5, "0")}`, payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    };
    return id;
  };
  const take = (session: string) => takeUpsell({ store, session, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });

  part("A paid one-click offer (takeUpsell): control");
  {
    const before = [await counted(), await held(), emailsAccepted];
    const session = offerCheckout();
    is("taken", (await take(session)).kind, "done");
    is("its confirmation went", emailsAccepted - before[2], 1);
    is("counted once, and its place given back", [(await counted()) - before[0], (await held()) - before[1]], [1, 0]);
  }

  part("A paid offer whose count keeps failing keeps its place held");
  {
    const before = [await counted(), await held()];
    const session = offerCheckout();
    countFails();
    const kind = (await take(session).catch(() => ({ kind: "threw" }))).kind;
    healthy();
    is("taken: it was paid", kind, "done");
    is("not counted", (await counted()) - before[0], 0);
    is("its place stays held, so the paid offer is still in count + held", (await held()) - before[1], 1);
  }

  part("A paid offer whose count is not a whole number keeps its place held");
  {
    const kept = (await plain([["GET", countKey]]))[0];
    const before = await held();
    const session = offerCheckout();
    // Written once its checkout is admitted (admission reads the count too), before the offer is counted.
    onCharge = async () => {
      await plain([["SET", countKey, "not-a-count"]]);
    };
    is("taken: it was paid", (await take(session)).kind, "done");
    is("the count is left as it was", (await plain([["GET", countKey]]))[0], "not-a-count");
    is("its place stays held", (await held()) - before, 1);
    await plain([["SET", countKey, String(kept)], ["EXPIRE", countKey, 400 * 86_400]]);
  }

  part("A paid offer whose confirmation the sender refused is still one of the month's orders");
  {
    const before = [await counted(), await held(), emailsAccepted];
    const session = offerCheckout();
    senderRefuses = true;
    const kind = (await take(session)).kind;
    senderRefuses = false;
    is("taken: it was paid", kind, "done");
    is("no email went", emailsAccepted - before[2], 0);
    is("counted once, and only then its place given back", [(await counted()) - before[0], (await held()) - before[1]], [1, 0]);
  }

  part("A paid offer settled later (the bank asked to confirm) is counted, whether or not its email went");
  for (const refused of [false, true]) {
    const before = await counted();
    const session = offerCheckout();
    nextCharge = "requires_action";
    is(`sent to the bank (email ${refused ? "refused" : "accepted"})`, (await take(session)).kind, "confirm");
    nextCharge = "succeeded";
    made[made.length - 1].status = "succeeded";
    senderRefuses = refused;
    await settleUpsells(store, session);
    senderRefuses = false;
    is(`settled as paid (email ${refused ? "refused" : "accepted"})`, (await readUpsell(session))?.state, "paid");
    is(`counted once (email ${refused ? "refused" : "accepted"})`, (await counted()) - before, 1);
    await settleUpsells(store, session);
    is(`settled again: not counted twice (email ${refused ? "refused" : "accepted"})`, (await counted()) - before, 1);
  }

  console.error = realError;
  done();
}

void main();
