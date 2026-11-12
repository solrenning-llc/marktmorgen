/**
 * Evidence for the LEVE on #3499 (Claude 3, comment 6785942080): a refund already told, whose take-back stays stuck, is later
 * written as "Not sent" (A: once the event's 30-day mark ends; B: an endpoint added after a telling with none).
 *
 * PayPal's refund.issued, when telling it fails (Claude 5's L4 on #3491): the order stays under the refund watch and
 * the telling is tried again an hour later, for a bounded time (REFUND_TELL_RETRY_SECONDS in lib/paypal-sales.ts),
 * never dropped at the first failure. Past that time the store's webhook log says "Not sent" for each endpoint that
 * hears refunds, once, and the event is never sent after it; a refund already told is never told twice, and a telling
 * that works first time writes nothing more. The mark of the first failed try is read in its exact shape (CX-123 rule
 * 24). Synthetic only: PayPal and the sender are stand-ins for fetch, Redis is lib/redis-memory.ts with a clock moved
 * by the test, and the endpoint's name resolves to a private address, so nothing leaves this machine.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import * as sales from "@/lib/paypal-sales";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import * as hooks from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { PAYPAL_REFUND_TELL_RETRY } from "./plan-cost-registry";

const { captureOrder, openOrder } = sales;
const { addEndpoint, recentMessages, setSendHooksForTests, webhooksView } = hooks;
const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
process.env.RESEND_API_KEY = "re_test_paypal_refund_told_retry";
delete process.env.PAYPAL_ENV;

/** The test's clock: Date.now moved forward by `shift`, which lib/redis-memory.ts reads too, so marks expire with it. */
let shift = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + shift;
const hour = () => {
  shift += 3600 * 1000;
};

let made = 0;
const captures = new Map<string, string>();
const payers = new Map<string, string>();
const orderId = (n: number) => `5O190127TN36481${String(n).padStart(2, "0")}`;
let payer = "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ object: "list", data: [], has_more: false });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    payers.set(id, payer);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture) {
    const cap = `3C679366HH9181${capture.slice(-2)}`;
    captures.set(cap, "COMPLETED");
    return json({
      id: capture,
      status: "COMPLETED",
      payer: { email_address: payers.get(capture) },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    }, 201);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });

/** Telling fails while `failing` holds: the deletion print's read gets no answer, as when Redis does not reply. */
let failing = false;
/** Replies the first-failure mark's GET gives instead of the stand-in's, while set (rule 24). */
let oddMark: unknown = undefined;
/** While set, the take-back's read of the import record answers in another shape (unknown), so the order stays watched. */
let stuck = false;
/**
 * How the first-failure mark's write goes, while set (Codex C2's M1 on #3499): "lost" answers "QUEUED" and writes
 * nothing, so its GET finds no mark; "throwOnce" gives the next pipeline that writes it no answer at all, once.
 */
let markWrites: "lost" | "throwOnce" | undefined = undefined;
/** Every command sent, for the counts below. */
const sent: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
const isMarkWrite = (c: (string | number)[]) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:tell:");
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  if (failing && commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:"))) throw new Error("synthetic: the read had no answer");
  if (markWrites === "throwOnce" && commands.some(isMarkWrite)) {
    markWrites = undefined;
    throw new Error("synthetic: the mark's write had no answer");
  }
  const lostWrites = markWrites === "lost";
  const replies = await pipeline(lostWrites ? commands.map((c) => (isMarkWrite(c) ? ["GET", "nl:synthetic:nothing"] : c)) : commands);
  return commands.map((c, i) =>
    stuck && c[0] === "HGET" && String(c[1]).startsWith("nl:imp:buy:") ? 5 :
    oddMark !== undefined && c[0] === "GET" && String(c[1]).startsWith("nl:ppsell:tell:") ? oddMark : lostWrites && isMarkWrite(c) ? "QUEUED" : replies[i]);
}) as typeof redis.pipeline;
const logged = console.error;
console.error = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (text.startsWith("a webhook delivery failed") || text.startsWith("telling of a PayPal refund failed") || text.startsWith("WEBHOOK EVENT LOST")) return;
  logged(...args);
};


async function main(): Promise<void> {
  redis.clear();
  const OWNER = "paypal-told@example.com";
  await claimHandle(OWNER, "paypal-told-shop", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PayPalTold1", subscriptionId: "sub_PayPalTold1", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");
  await setPayPalSeller(OWNER, SELLER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const watch = `nl:ppsell:watch:${statsId}`;
  const product = (await readListing(store, added.product.id))!;
  const paidThenRefunded = async (email: string) => {
    payer = email;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    const paid = await captureOrder(store, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    await handOverPayPal(store, paid.paid);
    captures.set(paid.paid.capture, "REFUNDED");
    await redis.pipeline([["ZADD", watch, "0", opened.order]]);
    return { order: opened.order, capture: paid.paid.capture, email };
  };
  const told = async (capture: string) => (await recentMessages(store, "refund.issued", 50)).filter((m) => (m.data as Record<string, unknown>).paypal_capture === capture).length;
  const notSent = async () => (await webhooksView(store)).log.filter((d) => d.type === "refund.issued" && d.givenUp === true);
  const watchedAt = async (order: string) => {
    const [score] = await redis.pipeline([["ZSCORE", watch, order]]);
    return score === null ? null : Number(score);
  };
  const sweep = () => sweepPayPal(store, Date.now() + 10_000);
  const tries = () => sent.filter((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:")).length;

  part("A: told at the first look, the take-back stuck on an unknown read, then the event's 30-day mark ends");
  is("an endpoint listening for refunds is kept", (await addEndpoint(store, "https://hooks.example.net/in", ["refund.issued"])).ok, true);
  const a = await paidThenRefunded("pp-told-stuck@example.com");
  stuck = true;
  await sweep();
  is("A: told once at the first look", await told(a.capture), 1);
  is("A: still watched (take-back unknown)", (await watchedAt(a.order)) !== null, true);
  hour();
  await sweep();
  for (let i = 0; i < 8; i += 1) { hour(); await sweep(); }
  is("A: no Not-sent line while the event's mark lives", (await notSent()).length, 0);
  // Jump to just past the event's mark (30 days after the first look), before the tell mark set an hour later ends.
  shift += (30 * 86_400 - 9 * 3600 + 1800) * 1000;
  await sweep();
  const linesA = await notSent();
  is("A: an event that WAS sent is never said not sent (VR)", linesA.length, 0);
  console.log("   A: lines now", linesA.length, "told count", await told(a.capture), linesA[0]?.lastError ?? "");
  stuck = false;

  part("B: told with no endpoint, take-back stuck, an endpoint added seven hours later");
  const OWNER2 = "paypal-told-b@example.com";
  await claimHandle(OWNER2, "paypal-told-b", "Harbor Bakery", "");
  await ensureStatsId(OWNER2);
  await ensureListId(OWNER2);
  await setSubscription(OWNER2, { customerId: "cus_PayPalToldB", subscriptionId: "sub_PayPalToldB", active: true, period: paidPeriod() });
  const added2 = await addProduct(OWNER2, "Rye Guide", "", "49", null);
  if (!added2.ok) throw new Error("no product");
  await setProductLink(OWNER2, added2.product.id, "https://example.com/rye");
  await setPayPalSeller(OWNER2, SELLER);
  const store2 = (await storeForEmail(OWNER2))!;
  const watch2 = `nl:ppsell:watch:${store2.statsId}`;
  const product2 = (await readListing(store2, added2.product.id))!;
  payer = "pp-b@example.com";
  const opened = await openOrder(store2, product2, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error("no order");
  const paid = await captureOrder(store2, opened.order);
  if (!paid.ok) throw new Error("not paid");
  await handOverPayPal(store2, paid.paid);
  captures.set(paid.paid.capture, "REFUNDED");
  await redis.pipeline([["ZADD", watch2, "0", opened.order]]);
  const sweep2 = () => sweepPayPal(store2, Date.now() + 10_000);
  stuck = true;
  const triesBefore = tries();
  for (let i = 0; i < 8; i += 1) { await sweep2(); hour(); }
  is("B: the telling never failed (no erased-read threw)", failing, false);
  is("B: an endpoint for refunds added now", (await addEndpoint(store2, "https://hooks.example.net/b", ["refund.issued"])).ok, true);
  await sweep2();
  const linesB = (await webhooksView(store2)).log.filter((d) => d.type === "refund.issued");
  console.log("   B: lines", JSON.stringify(linesB.map((d) => ({ state: d.state, givenUp: d.givenUp, err: d.lastError }))), "tries", tries() - triesBefore);
  is("B: no line claims tries failed when none did (VR)", linesB.filter((d) => d.givenUp === true).length, 0);
  stuck = false;
}

void main().then(() => done()).catch((error) => {
  console.error(error);
  process.exit(1);
});
