/**
 * #4748 (Codex X8, transcribed by Claude 2): the PayPal refund watch (lib/paypal-sales.ts, watchPayPal) took an
 * EXPIRE reply of 0 as a written mark. The marks are a ZADD then an EXPIRE in one pipeline, which is not atomic: when
 * the key goes between the two (a TTL running out, a store erased), the EXPIRE answers 0, nothing is kept, and yet the
 * refund was told, the purchase taken back and the order taken off the watch, with no mark for the affiliate book, the
 * store's numbers or the hand-over retry (lib/paypal-delivery.ts) to read. The same holds for the taken-back mark of a
 * chargeback (nl:ppsell:reversed). Now the ZADD may answer 0 or 1 (added, or already there) and the EXPIRE must answer
 * 1 (the key's expiry set): anything else is not known written, so nothing is told or taken back and the order is
 * looked at again in an hour, when the mark is written whole (CX-123 rule 24).
 *
 * Stand-in for PayPal and setup from tests/paypal-reversed-access.test.ts; all the code under test is real.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

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
  process.env.RESEND_API_KEY = "re_test_paypal_expire";
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

  /** The mark's key goes between its ZADD and its EXPIRE, as when its TTL runs out right then: the EXPIRE answers 0. */
  const dropBetween = async (key: string, run: () => Promise<Awaited<ReturnType<typeof watchPayPal>>>) => {
    const real = redis.pipeline.bind(redis);
    let dropped = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const [add, expire] = commands;
      if (commands.length === 2 && add[0] === "ZADD" && add[1] === key && expire[0] === "EXPIRE" && expire[1] === key) {
        const [added] = await real([add]);
        await real([["DEL", key]]);
        dropped++;
        return [added, ...(await real([expire]))];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const logged = console.error;
    console.error = () => undefined;
    try {
      return { result: await run(), dropped };
    } finally {
      redis.pipeline = real;
      console.error = logged;
    }
  };

  for (const [status, key] of [["REFUNDED", refundedKey], ["REVERSED", reversedKey]] as const) {
    part(`Capture ${status}: its mark's key gone before its EXPIRE (EXPIRE answers 0)`);
    const email = `expire-${status.toLowerCase()}@example.com`;
    const bought = await buy(email);
    captures.set(bought.capture, status);
    await dueNow(bought.order);
    const told = refunds.length;
    const { result, dropped } = await dropBetween(key, () => watchPayPal(store, Date.now() + 10_000, on));
    is("control: the key went between the ZADD and the EXPIRE", dropped, 1);
    is("the order stays watched", await watched(bought.order), true);
    is("nothing is taken back", [result.revoked, await held(email)], [0, 1]);
    is("no refund is told", refunds.length, told);
    is("no refund mark is left", (await redis.pipeline([["ZSCORE", refundedKey, bought.order]]))[0], null);
    // The watch's scores are in seconds: an hour from now, not due at once.
    is("looked at again in about an hour", Number((await redis.pipeline([["ZSCORE", watchKey, bought.order]]))[0]) >= Math.floor(Date.now() / 1000) + 3500, true);

    part(`Capture ${status}: at the next look the mark is written whole`);
    await dueNow(bought.order);
    const again = await watchPayPal(store, Date.now() + 10_000, on);
    const [mark, ttl] = await redis.pipeline([["ZSCORE", key, bought.order], ["TTL", key]]);
    is("taken back, off the watch", [again.revoked, await held(email), await watched(bought.order)], [1, 0, false]);
    is("its mark is kept, with its expiry", [mark !== null, Number(ttl) > 399 * 86_400], [true, true]);
    is("a refund is told only for REFUNDED", refunds.length, told + (status === "REFUNDED" ? 1 : 0));
  }

  done();
}

void main();
