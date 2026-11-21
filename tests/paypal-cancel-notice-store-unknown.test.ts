/**
 * A canceled PayPal order's waiting notices survive a store read that does not come back (Claude 6's MEDIUM on
 * #3924, rule 24): retryPayPalCancelNotices reads the store by its handle exactly (storeForHandleExactly). A reply
 * out of shape is not "no store": both notices stay on the queue for the next run instead of being dropped for good,
 * and are sent once the store reads. A store that is really gone still leaves nobody to send from.
 *
 * Synthetic only: a PayPal stand-in, a Resend stand-in and the Redis stub, whose one GET of the store's handle is cut
 * short once.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, disconnectPayPalSeller, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder } from "@/lib/paypal-sales";
import { retryPayPalCancelNotices } from "@/lib/paypal-delivery";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string }[] = [];
let made = 0;
const orderId = (n: number) => `7E190127TN36472${String(n).padStart(2, "0")}`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: `e${emails.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = {
      id: capture,
      status: "COMPLETED",
      payer: { email_address: "buyer@example.com" },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `5C679366HH9088${capture.slice(-2)}`, status: "PENDING", amount: { currency_code: "USD", value: "49.00" } }] } }],
    };
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const HANDLE_KEY = "nl:store:handle:harbor";
const pipeline = redis.pipeline.bind(redis);
let cutHandleReads = 0;
let handleReadsCut = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await pipeline(commands);
  if (cutHandleReads <= 0) return replies;
  return replies.map((reply: unknown, i: number) => {
    const [name, key] = commands[i] ?? [];
    if (cutHandleReads > 0 && String(name).toUpperCase() === "GET" && key === HANDLE_KEY) {
      cutHandleReads -= 1;
      handleReadsCut += 1;
      return undefined;
    }
    return reply;
  });
}) as typeof redis.pipeline;

const KEY = "re_test_paypal_sales";
const to = (address: string) => emails.filter((e) => e.to.includes(address));
const queued = async (member: string): Promise<boolean> => (await pipeline([["ZSCORE", "nl:ppsell:tell", member]]))[0] !== null;
const makeDue = (members: string[]) => pipeline([["ZADD", "nl:ppsell:tell", "XX", ...members.flatMap((m) => ["1", m])]]);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  const order = opened.order;
  await captureOrder(store, order);
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  const key = `nl:ppsell:o:${order}`;
  const [raw] = await pipeline([["GET", key]]);
  const record = JSON.parse(String(raw)) as { at: number };
  record.at = Math.floor(Date.now() / 1000) - 30 * 86_400;
  await pipeline([["SET", key, JSON.stringify(record), "EX", 86_400]]);

  part("The sender refuses at the cancellation: both notices wait");
  delete process.env.RESEND_API_KEY;
  await sweepCheckouts(Date.now() + 20_000);
  is("the buyer's and the creator's notices wait on the queue", [await queued(order), await queued(`c:${order}`)], [true, true]);
  is("nobody emailed yet", emails.length, 0);

  part("Due, and the store's one read does not come back: nothing is dropped");
  process.env.RESEND_API_KEY = KEY;
  await makeDue([order, `c:${order}`]);
  cutHandleReads = 2;
  await retryPayPalCancelNotices(Date.now() + 20_000);
  is("control: the store's handle read was cut short", handleReadsCut > 0, true);
  cutHandleReads = 0;
  is("the buyer's notice is still waiting after an unknown store read", await queued(order), true);
  is("the creator's notice is still waiting after an unknown store read", await queued(`c:${order}`), true);
  is("and nobody was emailed meanwhile", emails.length, 0);

  part("The next run, the store reads: each told once");
  await makeDue([order, `c:${order}`]);
  await retryPayPalCancelNotices(Date.now() + 20_000);
  is("buyer told once the store reads", to("buyer@example.com").length, 1);
  is("creator told once the store reads", to("owner@example.com").length, 1);
  is("nothing left on the queue", [await queued(order), await queued(`c:${order}`)], [false, false]);

  part("A store that is really gone still leaves nobody to send from");
  const second = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  is("control: no order opens on a store without PayPal", second.ok, false);
  await pipeline([["ZADD", "nl:ppsell:tell", "1", order], ["DEL", HANDLE_KEY]]);
  await retryPayPalCancelNotices(Date.now() + 20_000);
  is("a handle that leads nowhere drops the notice (no store to send from)", await queued(order), false);
  is("and sends nothing more", to("buyer@example.com").length, 1);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
