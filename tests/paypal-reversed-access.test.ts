/**
 * A PayPal payment taken back by any other way than a refund closes the purchase too (inbox C4-13, owner,
 * 4 November 2026: a dispute closed as lost closes the whole order, whatever its amount).
 *
 * Found by the access audit (aud-paypal-reversal-kept): the refund watch (lib/paypal-sales.ts, watchPayPal) took a
 * purchase back only when PayPal's capture said "REFUNDED", so a capture REVERSED (a chargeback), FAILED or DECLINED
 * kept it, and any status it did not know was read as "kept" and let go after 180 days. Now only COMPLETED (and
 * PENDING, and PARTIALLY_REFUNDED, which keeps access as a partial Stripe refund does, lib/refunds.ts) keep it;
 * REFUNDED, REVERSED, FAILED and DECLINED take it back; a status not known here takes nothing back, is logged, and
 * stays watched past the 180 days until the paid record ends. Same rule for a pending order (rule 30): a status not
 * known here is waited on, never dropped.
 *
 * Pre-review MEDIUM on C4-13: a payment taken back by another way than a refund is also written in its own mark
 * (nl:ppsell:reversed:<stats>) before the refund mark, so the buyer's thanks page never says "refunded" of it
 * (tests/pf1-paypal-thanks-honest.test.ts draws that page). A mark that cannot be written keeps the order watched.
 *
 * Stand-in for PayPal derived from tests/paypal-sales.test.ts (and the audit proof built on it); all the code under
 * test is real.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readFileSync } from "node:fs";
import * as paypalSales from "@/lib/paypal-sales";
import {
  REFUND_WATCH_BATCH,
  captureOrder,
  nextLook,
  openOrder,
  stillPending,
  watchPayPal,
} from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import * as costRegistry from "./plan-cost-registry";
import { NOT_A_COST, PAYPAL_REFUND_WATCH } from "./plan-cost-registry";
import { FAMILIES } from "./store-data-registry";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const BN = "NimbusLabs_SP";
const SELLER = "7KNGBPH2U58GQ";

type Seen = { method: string; path: string; body: Record<string, unknown> | null; headers: Headers };
const seen: Seen[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
/** What each order's capture does: an answer, or a status the stand-in fails with. */
let captureWith: (order: string) => { status: number; body: Record<string, unknown> } = () => ({ status: 500, body: {} });
const orders = new Map<string, Record<string, unknown>>();
const captures = new Map<string, string>();
let made = 0;

const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, status = "COMPLETED", email = "Buyer@Example.com"): Record<string, unknown> {
  const cap = `3C679366HH9087${order.slice(-2)}${status === "PENDING" ? "P" : ""}`;
  captures.set(cap, status === "PENDING" ? "PENDING" : "COMPLETED");
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [
      {
        reference_id: "x",
        payee: { merchant_id: SELLER },
        payments: { captures: [{ id: cap, status, amount: { currency_code: "USD", value } }] },
      },
    ],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: "e" });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") {
    const basic = Buffer.from(`${PARTNER_CLIENT}:${PARTNER_SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AApartner") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  seen.push({ method, path: url.pathname + url.search, body, headers });

  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const answer = captureWith(capture);
    if (answer.status < 300) orders.set(capture, answer.body);
    return json(answer.body, answer.status);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;


async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_paypal_reversed";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = BN;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const watchKey = `nl:ppsell:watch:${store.statsId}`;
  const refundedKey = `nl:ppsell:refunded:${store.statsId}`;
  const reversedKey = `nl:ppsell:reversed:${store.statsId}`;

  const refunds: string[] = [];
  const on = {
    handOver: async (p: { email: string; order: string }) => void p,
    dropStart: async () => undefined,
    refunded: async (p: { order: string }) => void refunds.push(p.order),
  };
  /** One buyer pays for the guide and has it handed over: the order, its capture. */
  const buy = async (email: string) => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "COMPLETED", email) });
    const paid = await captureOrder(store, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    await handOverPayPal(store, paid.paid);
    return { order: opened.order, capture: paid.paid.capture };
  };
  const dueNow = async (order: string) => void (await redis.pipeline([["ZADD", watchKey, "0", order]]));
  // Read on the store as it stands now (its imports are kept on it), as tests/paypal-sales.test.ts does.
  const held = async (email: string) => (await importedFor((await storeForEmail("owner@example.com"))!, email)).length;
  const watched = async (order: string) => (await redis.pipeline([["ZSCORE", watchKey, order]]))[0] !== null;

  part("Statuses that keep the purchase");
  const keeper = await buy("keeper@example.com");
  for (const status of ["COMPLETED", "PENDING", "PARTIALLY_REFUNDED"]) {
    captures.set(keeper.capture, status);
    await dueNow(keeper.order);
    const run = await watchPayPal(store, Date.now() + 10_000, on);
    is(`capture ${status}: kept, still watched`, [run.revoked, await held("keeper@example.com"), await watched(keeper.order)], [0, 1, true]);
  }

  part("A payment taken back by PayPal closes the purchase, whatever way (C4-13)");
  for (const status of ["REVERSED", "FAILED", "DECLINED", "REFUNDED"]) {
    const email = `${status.toLowerCase()}@example.com`;
    const bought = await buy(email);
    is(`${status}: held before`, await held(email), 1);
    captures.set(bought.capture, status);
    await dueNow(bought.order);
    const run = await watchPayPal(store, Date.now() + 10_000, on);
    const marked = (await redis.pipeline([["ZSCORE", refundedKey, bought.order]]))[0] !== null;
    is(`capture ${status}: taken back, marked as given back, off the watch`, [run.revoked, await held(email), marked, await watched(bought.order)], [1, 0, true, false]);
    // Its own mark says it was not a refund, so nothing tells the buyer it was refunded; a refund has none.
    const [reversedAt, ttl] = await redis.pipeline([["ZSCORE", reversedKey, bought.order], ["TTL", reversedKey]]);
    is(`capture ${status}: ${status === "REFUNDED" ? "no taken-back mark" : "its taken-back mark, kept as long as the refund mark"}`, [reversedAt !== null, status === "REFUNDED" || Number(ttl) > 399 * 86_400], [status !== "REFUNDED", true]);
  }

  part("The taken-back mark cannot be written: nothing marked as given back, still watched");
  {
    const stuck = await buy("stuck@example.com");
    captures.set(stuck.capture, "REVERSED");
    await dueNow(stuck.order);
    const real = redis.pipeline.bind(redis);
    // The mark's writes answer out of their shape, as a reply that cannot be read does: never "written".
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((c) => c[1] === reversedKey && c[0] !== "ZSCORE") ? commands.map(() => "OK") : real(commands)) as typeof redis.pipeline;
    const logged = console.error;
    console.error = () => undefined;
    let run: Awaited<ReturnType<typeof watchPayPal>>;
    try {
      run = await watchPayPal(store, Date.now() + 10_000, on);
    } finally {
      redis.pipeline = real;
      console.error = logged;
    }
    const marked = (await redis.pipeline([["ZSCORE", refundedKey, stuck.order]]))[0] !== null;
    is("not written: nothing taken back, no refund mark, still watched", [run.revoked, await held("stuck@example.com"), marked, await watched(stuck.order)], [0, 1, false, true]);
    await dueNow(stuck.order);
    run = await watchPayPal(store, Date.now() + 10_000, on);
    is("written at the next look: taken back with both marks", [run.revoked, await held("stuck@example.com"), (await redis.pipeline([["ZSCORE", reversedKey, stuck.order]]))[0] !== null], [1, 0, true]);
  }
  // Only a refund is told as one: "refund.issued" says fully_refunded, which a chargeback or a failed payment is not.
  is("only the REFUNDED capture is told as a refund", refunds.length, 1);

  part("A second payment that was reversed does not keep the purchase");
  const first = await buy("twice@example.com");
  const second = await buy("twice@example.com");
  captures.set(second.capture, "REVERSED");
  await dueNow(second.order);
  await watchPayPal(store, Date.now() + 10_000, on);
  captures.set(first.capture, "REFUNDED");
  await dueNow(first.order);
  const both = await watchPayPal(store, Date.now() + 10_000, on);
  is("one refunded, the other reversed: taken back", [both.revoked, await held("twice@example.com")], [1, 0]);

  part("A status not known here takes nothing back and is never let go");
  const odd = await buy("odd@example.com");
  captures.set(odd.capture, "SOMETHING_NEW");
  await dueNow(odd.order);
  const errors: unknown[][] = [];
  const logged = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  let run = await watchPayPal(store, Date.now() + 10_000, on);
  console.error = logged;
  is("unknown status: nothing taken back, still watched", [run.revoked, await held("odd@example.com"), await watched(odd.order)], [0, 1, true]);
  is("and it is logged with the status", errors.some((args) => args.some((a) => String(a).includes("SOMETHING_NEW"))), true);
  // 181 days on: a known "kept" status leaves the watch (PayPal's 180 days), an unknown one stays watched.
  const realNow = Date.now;
  const later = realNow() + 181 * 86_400_000;
  Date.now = () => later;
  try {
    captures.set(keeper.capture, "COMPLETED");
    await dueNow(keeper.order);
    await dueNow(odd.order);
    console.error = () => undefined;
    run = await watchPayPal(store, later + 10_000, on);
    console.error = logged;
    is("after 180 days: COMPLETED leaves the watch, the unknown one stays", [await watched(keeper.order), await watched(odd.order), await held("odd@example.com")], [false, true, 1]);
    captures.set(odd.capture, "REVERSED");
    await dueNow(odd.order);
    run = await watchPayPal(store, later + 10_000, on);
    is("and once PayPal says REVERSED, it is taken back even then", [run.revoked, await held("odd@example.com"), await watched(odd.order)], [1, 0, false]);
  } finally {
    Date.now = realNow;
    console.error = logged;
  }

  part("The refund watch's cost line (tests/plan-cost-registry.ts) says what the watch does");
  {
    is("NOT_A_COST says why the batch is bounded, naming watchPayPal", typeof NOT_A_COST.REFUND_WATCH_BATCH === "string" && NOT_A_COST.REFUND_WATCH_BATCH.includes("watchPayPal"), true);
    is("the line's batch is the code's", PAYPAL_REFUND_WATCH.ordersPerStoreRun, REFUND_WATCH_BATCH);
    const t0 = 1_800_000_000;
    is("looks a day at the most: hourly the first week", 86_400 / ((nextLook(t0, t0) ?? 0) - t0), PAYPAL_REFUND_WATCH.looksPerOrderPerDayAtMost);
    is("daily past day 30", 86_400 / ((nextLook(t0, t0 + 31 * 86_400) ?? 0) - (t0 + 31 * 86_400)), PAYPAL_REFUND_WATCH.looksPerOrderPerDayAfter30Days);
    is("let go at PayPal's 180 days when known", nextLook(t0, t0 + 180 * 86_400), null);
    is("an unknown status is watched until the paid record ends", PAYPAL_REFUND_WATCH.daysWatchedAtMost, 400);
    // One run looks at no more than the batch: one more due order than it is left for the next run.
    const many = Array.from({ length: REFUND_WATCH_BATCH + 1 }, (_, i) => `9Z${String(i).padStart(15, "0")}`);
    await redis.pipeline(many.map((order) => ["ZADD", watchKey, "0", order]));
    await watchPayPal(store, Date.now() + 10_000, on);
    const left = (await redis.pipeline([["ZRANGEBYSCORE", watchKey, "0", "0"]]))[0] as string[];
    is("one run looks at the batch, the rest waits for the next run", left.filter((order) => many.includes(order)).length, 1);
    await redis.pipeline([["ZREM", watchKey, ...many]]);
  }

  part("A pending order with a status not known here is waited on (rule 30)");
  const waitOpen = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!waitOpen.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "PENDING", "slow@example.com") });
  is("pending", (await captureOrder(store, waitOpen.order)).ok, false);
  const pendingBody = completed(waitOpen.order, "49.00", "PENDING", "slow@example.com");
  const unit = (pendingBody.purchase_units as { payments: { captures: { status: string }[] } }[])[0];
  unit.payments.captures[0].status = "SOMETHING_NEW";
  orders.set(waitOpen.order, pendingBody);
  console.error = () => undefined;
  await watchPayPal(store, Date.now() + 10_000, on);
  console.error = logged;
  is("unknown status on a pending order: still waited on", await stillPending(store, waitOpen.order), true);
  unit.payments.captures[0].status = "DECLINED";
  await watchPayPal(store, Date.now() + 10_000, on);
  is("DECLINED: dropped, nothing handed over", [await stillPending(store, waitOpen.order), await held("slow@example.com")], [false, 0]);

  // Claude 6's second money review of #3392, LEVE 2 (rule 30): the first door, captureOrder, answered "declined" for
  // any status other than PENDING or COMPLETED and did not watch the order, although a status not known here is
  // never "declined" in the sweep.
  part("At the capture itself, a status not known here is waited on, never declined");
  {
    const odd = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!odd.ok) throw new Error("no order");
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "SOMETHING_NEW", "door@example.com") });
    console.error = () => undefined;
    const answer = await captureOrder(store, odd.order);
    console.error = logged;
    is("unknown status at capture: not declined, and asked again by the sweep", [answer.ok ? "paid" : answer.reason, await stillPending(store, odd.order)], ["pending", true]);
    const gone = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!gone.ok) throw new Error("no order");
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "DECLINED", "door@example.com") });
    const declined = await captureOrder(store, gone.order);
    is("DECLINED at capture: declined, not watched", [declined.ok ? "paid" : declined.reason, await stillPending(store, gone.order)], ["declined", false]);
    await redis.pipeline([["ZREM", `nl:ppsell:pending:${store.statsId}`, odd.order]]);
  }

  // LEVE 3: a pending payment PayPal has since completed and then refunded in part keeps the purchase (CAPTURE_KEEPS),
  // so it is written down and handed over, never dropped with the money taken.
  part("A pending order now refunded in part is paid: handed over, not dropped");
  {
    const part3 = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!part3.ok) throw new Error("no order");
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "PENDING", "partly@example.com") });
    await captureOrder(store, part3.order);
    orders.set(part3.order, completed(part3.order, "49.00", "PARTIALLY_REFUNDED", "partly@example.com"));
    const run = await watchPayPal(store, Date.now() + 10_000, on);
    is("PARTIALLY_REFUNDED after pending: handed over once, out of the pending list, watched for refunds", [run.cleared, await stillPending(store, part3.order), await watched(part3.order)], [1, false, true]);
  }

  // LEVE 1 (Claude 2's first review and Claude 6's second): the sweep always read the 25 oldest pending orders and
  // skipped them without moving them, so 25 orders PayPal never settles held back a newer one already paid until
  // their 30-day records ended. A skipped order now goes to the back of the list.
  part("Pending orders PayPal does not settle never hold back a newer one that is paid");
  {
    const pendingKey = `nl:ppsell:pending:${store.statsId}`;
    const fresh = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!fresh.ok) throw new Error("no order");
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "PENDING", "late@example.com") });
    await captureOrder(store, fresh.order);
    const [record] = await redis.pipeline([["GET", `nl:ppsell:o:${fresh.order}`]]);
    const blockers = Array.from({ length: 25 }, (_, i) => `8P${String(i).padStart(15, "0")}`);
    const firstSeen = Math.floor(Date.now() / 1000) - 3600;
    for (const [i, order] of blockers.entries()) {
      await redis.pipeline([["SET", `nl:ppsell:o:${order}`, String(record)], ["ZADD", pendingKey, String(firstSeen + i), order]]);
      orders.set(order, completed(order, "49.00", i % 2 ? "PENDING" : "SOMETHING_NEW", `wait${i}@example.com`));
    }
    orders.set(fresh.order, completed(fresh.order, "49.00", "COMPLETED", "late@example.com"));
    const realNow = Date.now;
    let cleared = 0;
    try {
      console.error = () => undefined;
      for (let sweep = 1; sweep <= 2; sweep++) {
        const at = realNow() + sweep * 300_000;
        Date.now = () => at;
        cleared += (await watchPayPal(store, at + 10_000, on)).cleared;
      }
    } finally {
      Date.now = realNow;
      console.error = logged;
    }
    is("the newer paid order is handed over within two sweeps; the 25 still waited on", [cleared, await stillPending(store, fresh.order), (await Promise.all(blockers.map((o) => stillPending(store, o)))).every(Boolean)], [1, false, true]);
    await redis.pipeline([["ZREM", pendingKey, ...blockers]]);
  }

  // LEVE 5: the watch keeps an order whose status is not known here until its paid record ends, so the storage
  // registry's days for the watch list are the cost line's, not PayPal's 180.
  part("The storage registry keeps the watch list as long as the watch does");
  {
    const family = FAMILIES["nl:ppsell:watch:@lib/paypal-sales.ts"];
    const days = family?.parts?.map((p) => ("days" in p ? p.days : 0)) ?? [];
    is("the watch list's days are the cost line's", days, [PAYPAL_REFUND_WATCH.daysWatchedAtMost]);
  }

  // LEVE 6: the sweep's pending half had no cost line; it now has one, held to the code.
  part("The pending sweep's cost line says what it does");
  {
    is("NOT_A_COST names the pending batch", typeof NOT_A_COST.PENDING_SWEEP_BATCH === "string" && NOT_A_COST.PENDING_SWEEP_BATCH.includes("watchPayPal"), true);
    // Read by name, so the check runs (and fails) before the line exists.
    const line = (costRegistry as Record<string, unknown>).PAYPAL_PENDING_SWEEP as { ordersPerStoreRun?: unknown } | undefined;
    const batch = (paypalSales as Record<string, unknown>).PENDING_SWEEP_BATCH;
    is("the line's batch is the code's", [typeof batch, line?.ordersPerStoreRun], ["number", batch]);
  }

  // Claude 6's second money review, MEDIUM 1 and 2 (VR 2): the studio's PayPal box and the kept-by-currency note
  // promised that a chargeback PayPal reverses is taken back and counted, and that the webhooks hear of it. PayPal's
  // published capture statuses have no REVERSED (a chargeback comes as a webhook event or a dispute, neither read in
  // the product), and no webhook event is sent for a payment taken back without a refund.
  part("The studio and the numbers promise only what the watch does");
  {
    const studio = readFileSync("app/studio/page.tsx", "utf8");
    const box = studio.slice(studio.indexOf('id="paypal"'), studio.indexOf("{store.paypalSeller ?", studio.indexOf('id="paypal"')));
    const note = readFileSync("components/kept-by-currency.tsx", "utf8");
    is("the PayPal box is found", box.includes("Sell with PayPal too"), true);
    is("no promise that a reversal or chargeback is taken back or counted", [/revers/i.test(box), /revers/i.test(note)], [false, false]);
    is("it says a chargeback is not read here", /chargeback[^<]*not read here/i.test(box), true);
    is("the webhooks are said to get refund.issued only for a refund in full", /webhooks[^<]*refund\.issued/i.test(box), true);
  }

  done();
}

void main();
