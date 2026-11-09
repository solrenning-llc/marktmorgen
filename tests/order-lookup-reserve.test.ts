/**
 * Made-up order numbers must not spend the part of a store's window kept for its buyers (09/11/2026, audit of the
 * checkout and the thanks page; same principle as C4-2720 and #3478).
 *
 * Public pages rest at 95% of the window (publicVisitLimit); the last 5% is kept for what buyers already have (courses,
 * community, podcast, downloads, the calendar file, the thanks page itself). lib/order-lookup.ts counts an id that is not
 * of an order's form not at all, the lookup of one that is on the PUBLIC side, and only a paid order on the buyers' side.
 *
 * Changed from the audit's proof (rule 23): the proof called withinStore(..., "buyer") itself, which is the defect, so
 * its two "DESIRED" checks now drive readOrderAdmitted with the same steps the page, the download and the calendar file
 * pass; its static check (the form is tested before anything is counted) is now a behavioural one (no fetch, no count).
 * Synthetic store; Stripe is a stub; no request leaves the machine.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { withinStoreWhy } from "@/lib/metered-limits";
import { readOrderAdmitted, takeBuyerRequest, takeLookupRequest } from "@/lib/order-lookup";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PAID = `cs_test_${"p".repeat(24)}`;
let productId = "";
let lookups = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/checkout/sessions/")) {
    lookups += 1;
    if (path.endsWith(PAID)) {
      return new Response(JSON.stringify({ id: PAID, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000), currency: "usd", amount_total: 4900, metadata: { store: "harbor", product: productId }, customer_details: { email: "ann@example.com" }, payment_intent: { id: "pi_Paid00001", latest_charge: { refunded: false, amount: 4900, amount_refunded: 0 } } }));
    }
    return new Response(JSON.stringify({ error: { message: "No such checkout.session", type: "invalid_request_error" } }), { status: 404 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_order_lookup_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Bread Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink("owner@example.com", productId, "https://example.com/bread");
  const store = (await storeForEmail("owner@example.com"))!;
  const now = Date.now();
  // The steps the thanks page passes (app/[handle]/thanks/page.tsx).
  const thanksSteps = (who: string) => ({
    lookup: () => withinStoreWhy("thanks-view", who, 60, 600, store, "lookup"),
    paid: () => takeBuyerRequest(store),
  });

  part("The pages count after they know what the id is");
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("the thanks page asks through readOrderAdmitted, the lookup on the public side and a paid order on the buyers'", [/readOrderAdmitted\(store, sessionId/.test(page), /withinStoreWhy\("thanks-view", who, VIEWS_PER_TEN_MINUTES, 600, store, "lookup"\)/.test(page), /paid: \(\) => takeBuyerRequest\(store\)/.test(page), !/withinStore\("thanks-view"[^)]*"buyer"\)/.test(page)], [true, true, true, true]);
  is("the download counts a link by session id the same way, and the calendar file", [/readOrderAdmitted\(store, sessionId/.test(readFileSync("app/api/store/download/route.ts", "utf8")), /readOrderAdmitted\(store, sessionId/.test(readFileSync("app/api/store/ics/route.ts", "utf8"))], [true, true]);

  part("Public pages have used their 95%");
  const whole = requestLimitFor(store, now / 1000);
  const pub = publicVisitLimit(whole);
  is("control: the public side takes its 95%", await takePublicRequest(store, "public", now, pub), true);
  is("control: and rests there", await takePublicRequest(store, "public", now), false);
  is("control: a paying student's course still opens (buyers' side)", await isResting(store, now, "buyer"), false);

  part("An anonymous visitor opens /@harbor/thanks?session_id=<made up> from many addresses");
  let spentOnBuyers = 0;
  let stripeAsked = 0;
  const before = lookups;
  for (let ip = 1; ip <= 200; ip += 1) {
    for (let n = 0; n < 60; n += 1) {
      // Not an order's form: nothing is counted, and nobody is asked.
      const bad = await readOrderAdmitted(store, `made-up-${ip}-${n}`, thanksSteps(`203.0.113.${ip}|harbor`));
      if (bad.state !== "invalid") spentOnBuyers += 1;
      // An order's form, never paid: the lookup counts on the public side, which is full, so it is refused there.
      const invented = await readOrderAdmitted(store, `cs_test_${String(ip).padStart(3, "0")}${String(n).padStart(3, "0")}${"x".repeat(18)}`, thanksSteps(`203.0.113.${ip}|harbor`));
      if (invented.state !== "resting") spentOnBuyers += 1;
    }
  }
  stripeAsked = lookups - before;
  is("12,000 made-up ids (half not of an order's form, half of it) took nothing from the buyers' reserve", spentOnBuyers, 0);
  is("and none reached Stripe (the first is never asked, the second is refused at the public side)", stripeAsked, 0);
  is("the paying student's course still opens afterwards", await isResting(store, now, "buyer"), false);
  is("the buyers' side still has its whole reserve to give", await takeBuyerRequest(store), true);

  part("The reason is told: the connection's short window or the store's own");
  is("the store's window is 'window', never the connection's", await withinStoreWhy("thanks-view", "198.51.100.9|harbor", 60, 600, store, "lookup"), "window");
  is("a connection past its 60 in ten minutes is 'tries'", await (async () => { let last: string | null = null; for (let n = 0; n < 61; n += 1) last = await withinStoreWhy("thanks-view", "198.51.100.10|harbor", 60, 600, store, "buyer"); return last; })(), "tries");
  const slow = await readOrderAdmitted(store, PAID, { lookup: async () => "tries", paid: async () => true });
  const resting = await readOrderAdmitted(store, PAID, { lookup: takeLookupRequest.bind(null, store), paid: async () => true });
  is("a short-window refusal reads 'slow' and the window's reads 'resting'", [slow.state, resting.state], ["slow", "resting"]);
  is("the 'resting' notice promises no minutes in any language", ["en", "es", "fr", "de", "it", "nl", "pt"].map((l) => /minut|minuto|minuten|min\b/i.test(thanksWords(l).notices.resting.body)), [false, false, false, false, false, false, false]);
  is("the 'slow' notice still names the minutes: it is the connection's", /a few minutes/.test(thanksWords("en").notices.slow.body), true);

  part("A real order, with room on the public side, is read once and takes the buyers' side once");
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made2 = await addProduct("owner@example.com", "Bread Course", "", "49", null);
  if (!made2.ok) throw new Error("no product");
  productId = made2.product.id;
  await setProductLink("owner@example.com", productId, "https://example.com/bread");
  const fresh = (await storeForEmail("owner@example.com"))!;
  const steps = { lookup: () => withinStoreWhy("thanks-view", "192.0.2.1|harbor", 60, 600, fresh, "lookup"), paid: () => takeBuyerRequest(fresh) };
  const real = await readOrderAdmitted(fresh, PAID, steps);
  is("it is paid, with its amount", [real.state, real.state === "paid" ? real.amount : null], ["paid", 4900]);
  const total = requestLimitFor(fresh, now / 1000);
  const reserve = total - publicVisitLimit(total);
  let taken = 0;
  // Fill the public side to its 95% and count how many buyers' requests remain: the paid order took exactly one of the reserve.
  await takePublicRequest(fresh, "public", now, publicVisitLimit(total) - 1);
  while (await takePublicRequest(fresh, "buyer", now)) taken += 1;
  is("the buyers' reserve gave one request less than it holds", taken, reserve - 1);
  done();
}

void main();
