/**
 * PayPal's refund.issued names nobody the store deleted at or after the payment (R38, rule 30; review of #3491): the
 * same deletion print as the Stripe events (lib/suppression.ts, nl:erased:), read by emitEvent only for an event about
 * to be kept for a live endpoint. A person deleted before they paid, or never deleted, is named as before; the rest
 * of the refund is unchanged. A print that does not read when the refund is seen leaves the refund owed, never lost:
 * the order stays on the watch and the refund is told when it is looked at again, once (review of #3491, MEDIUM).
 * Synthetic only: PayPal and the sender are stand-ins for fetch, Redis is
 * lib/redis-memory.ts, and the endpoint's name resolves to a private address, so nothing leaves this machine.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import * as paypalSales from "@/lib/paypal-sales";
import { captureOrder, openOrder, ownKey, refundedKey } from "@/lib/paypal-sales";
import { importedKey } from "@/lib/imported-purchases";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { PAYPAL_REFUND_TOLD, PAYPAL_REFUND_WATCH } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
process.env.RESEND_API_KEY = "re_test_paypal_refund_erased";
delete process.env.PAYPAL_ENV;

let made = 0;
const captures = new Map<string, string>();
const payers = new Map<string, string>();
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;
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
    const cap = `3C679366HH9088${capture.slice(-2)}`;
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
const logged = console.error;
console.error = (...args: unknown[]) => {
  if (args.map(String).join(" ").startsWith("a webhook delivery failed")) return;
  logged(...args);
};

/** The replies of a pipeline, as an array (a stand-in's answer). */
const repliesOf = (replies: unknown) => (Array.isArray(replies) ? replies : null);

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "paypal-erased@example.com";
  await claimHandle(OWNER, "paypal-erased-shop", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PayPalErased1", subscriptionId: "sub_PayPalErased1", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");
  await setPayPalSeller(OWNER, SELLER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  is("an endpoint listening for refunds is kept", (await addEndpoint(store, "https://hooks.example.net/in", ["refund.issued"])).ok, true);
  const product = (await readListing(store, added.product.id))!;

  /** Pays an order as `email`, hands it over, writes their deletion print `erasedAfter` seconds after the payment (none when null), and refunds it in full on PayPal. */
  const refunded = async (email: string, erasedAfter: number | null) => {
    payer = email;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    const paid = await captureOrder(store, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    await handOverPayPal(store, paid.paid);
    if (erasedAfter !== null) await redis.pipeline([suppressCommand(listId, email, paid.paid.at + erasedAfter)]);
    captures.set(paid.paid.capture, "REFUNDED");
    await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", opened.order]]);
    await sweepPayPal(store, Date.now() + 10_000);
    const message = (await recentMessages(store, "refund.issued", 50)).find((m) => (m.data as Record<string, unknown>).paypal_capture === paid.paid.capture);
    return message ? (message.data as Record<string, unknown>) : null;
  };

  part("PayPal's refund.issued: no address for a person deleted at or after the payment");
  const gone = await refunded("pp-gone@example.com", 100);
  is("deleted after paying: sent, with no address and no name", gone?.buyer, { email: null, name: null });
  is("the rest of the refund is unchanged", [gone?.paid_with, gone?.amount_refunded_cents, gone?.fully_refunded], ["paypal", 4900, true]);
  const same = await refunded("pp-same@example.com", 0);
  is("deleted in the second of the payment: the same", same?.buyer, { email: null, name: null });
  const before = await refunded("pp-before@example.com", -100);
  is("deleted before they paid: named as before", before?.buyer, { email: "pp-before@example.com", name: null });
  const kept = await refunded("pp-kept@example.com", null);
  is("never deleted: named as before", kept?.buyer, { email: "pp-kept@example.com", name: null });
  is("the address appears nowhere in what is kept for the endpoint", JSON.stringify(await recentMessages(store, "refund.issued", 50)).includes("pp-gone@example.com"), false);

  part("A deletion print with no answer when the refund is seen: the refund is owed, told at the next look, once");
  // Claude 7's MEDIUM 1 and Claude 1's review on #3491: emitEvent's read of the print throws UnknownReplyError and takes
  // the event's mark back; the watch used to only log it and let the order go, so the refund was never told.
  const UNREAD = "pp-unread@example.com";
  const statsId = store.statsId as string;
  const watch = `nl:ppsell:watch:${statsId}`;
  payer = UNREAD;
  const openedU = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!openedU.ok) throw new Error("no order");
  const paidU = await captureOrder(store, openedU.order);
  if (!paidU.ok) throw new Error(`not paid: ${paidU.reason}`);
  await handOverPayPal(store, paidU.paid);
  captures.set(paidU.paid.capture, "REFUNDED");
  await redis.pipeline([["ZADD", watch, "0", openedU.order]]);
  const toldU = async () => (await recentMessages(store, "refund.issued", 50)).filter((m) => (m.data as Record<string, unknown>).paypal_capture === paidU.paid.capture);
  // The print's HGET (lib/webhooks.ts erasedSincePaid) answered with nothing while `unread`; every command recorded.
  const field = suppressionPrint(listId, UNREAD);
  const realPipeline = redis.pipeline.bind(redis);
  let unread = true;
  let printReads = 0;
  let seen: (string | number)[][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    seen.push(...commands);
    if (commands.some((c) => c[0] === "HGET" && c[1] === suppressedKey(listId) && c[2] === field)) {
      printReads += 1;
      if (unread) return [];
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  const hourLater = () => {
    shift += (PAYPAL_REFUND_TOLD.tellAgainAfterSeconds + 1) * 1000;
    redis.advance((PAYPAL_REFUND_TOLD.tellAgainAfterSeconds + 1) * 1000);
  };
  try {
    is("before the refund is seen, the payment's purchase is there", typeof repliesOf(await realPipeline([["HGET", importedKey(statsId, UNREAD), product.id]]))?.[0], "string");
    const firstAt = Math.floor(Date.now() / 1000);
    await sweepPayPal(store, Date.now() + 10_000);
    is("the sweep that saw the refund read the print and had no answer", printReads >= 1, true);
    is("nothing was told on a print that did not read", (await toldU()).length, 0);
    is("what the payment gave is still taken back", repliesOf(await realPipeline([["HGET", importedKey(statsId, UNREAD), product.id]])), [null]);
    const score = Number((await realPipeline([["ZSCORE", watch, openedU.order]]))[0]);
    is("the order stays on the watch, looked at again an hour later", score >= firstAt + PAYPAL_REFUND_TOLD.tellAgainAfterSeconds && score <= Math.floor(Date.now() / 1000) + PAYPAL_REFUND_TOLD.tellAgainAfterSeconds, true);
    is("the hour is the code's (REFUND_TELL_AGAIN_SECONDS)", (paypalSales as unknown as Record<string, unknown>).REFUND_TELL_AGAIN_SECONDS, PAYPAL_REFUND_TOLD.tellAgainAfterSeconds);
    is("an owed order is looked at no more often than the watch's line prices", 86_400 / PAYPAL_REFUND_TOLD.tellAgainAfterSeconds <= PAYPAL_REFUND_WATCH.looksPerOrderPerDayAtMost, true);

    unread = false;
    hourLater();
    seen = [];
    await sweepPayPal(store, Date.now() + 10_000);
    const told = await toldU();
    is("the next look tells the refund to the endpoint, once", told.length, 1);
    is("named, never having been deleted", (told[0]?.data as Record<string, unknown> | undefined)?.buyer, { email: UNREAD, name: null });
    is("told, the order leaves the watch", (await realPipeline([["ZSCORE", watch, openedU.order]]))[0], null);
    const marks = seen.filter((c) => c[1] === refundedKey(statsId) && (c[0] === "ZADD" || c[0] === "EXPIRE")).length;
    is("the owed look writes the refund mark again as the cost line says", marks, PAYPAL_REFUND_TOLD.markCommandsPerOwedLook);
    is("and reads the purchase again as the cost line says", seen.filter((c) => c[0] === "HGET" && c[1] === importedKey(statsId, UNREAD)).length, PAYPAL_REFUND_TOLD.recordReadsPerOwedLook);
    const rewrites = seen.filter((c) => (c[0] === "SREM" || c[0] === "HSET") && (c[1] === importedKey(statsId, UNREAD) || c[1] === ownKey(statsId, UNREAD, product.id))).length;
    is("and writes what was taken back no more than the cost line says", rewrites <= PAYPAL_REFUND_TOLD.writesPerOwedLookAtMost, true);

    // Looked at again anyway (another way that keeps it watched): still told once.
    hourLater();
    await realPipeline([["ZADD", watch, "0", openedU.order]]);
    await sweepPayPal(store, Date.now() + 10_000);
    is("a later look never tells it twice", (await toldU()).length, 1);
  } finally {
    redis.pipeline = realPipeline;
    Date.now = realNow;
  }

  console.error = logged;
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
