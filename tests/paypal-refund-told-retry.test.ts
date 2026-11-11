/**
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
  is("an endpoint listening for refunds is kept", (await addEndpoint(store, "https://hooks.example.net/in", ["refund.issued"])).ok, true);
  const product = (await readListing(store, added.product.id))!;
  const retrySeconds = (sales as Record<string, unknown>).REFUND_TELL_RETRY_SECONDS;
  const triesAtMost = (sales as Record<string, unknown>).REFUND_TELL_TRIES_AT_MOST;

  /** Pays an order as `email`, hands it over, and refunds it in full on PayPal, due at the watch's next look. */
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
  // Read through the store as it is now: the purchases' read needs the store's mark of buyers, set by the first one.
  const holds = async (email: string) => (await importedFor((await storeForEmail(OWNER))!, email)).length;
  const sweep = () => sweepPayPal(store, Date.now() + 10_000);

  part("The bound is named and finite");
  is("REFUND_TELL_RETRY_SECONDS is a whole number of hours, at most a day", typeof retrySeconds === "number" && Number.isSafeInteger(retrySeconds) && retrySeconds > 0 && retrySeconds % 3600 === 0 && retrySeconds <= 86_400, true);
  is("REFUND_TELL_TRIES_AT_MOST is the tries an hour apart that fit in it, the first one included", triesAtMost, typeof retrySeconds === "number" ? retrySeconds / 3600 + 1 : "missing");

  part("Healthy: told once, nothing more written, the purchase taken back");
  const healthy = await paidThenRefunded("pp-healthy@example.com");
  sent.length = 0;
  await sweep();
  is("told once", await told(healthy.capture), 1);
  is("no mark of a failed try is written", sent.some((c) => String(c[1]).startsWith("nl:ppsell:tell:")), false);
  is("the purchase is taken back and the order leaves the watch", [await holds(healthy.email), await watchedAt(healthy.order)], [0, null]);
  await redis.pipeline([["ZADD", watch, "0", healthy.order]]);
  await sweep();
  is("looked at again: never told twice", await told(healthy.capture), 1);

  part("A telling that fails is tried again an hour later, and told once it works");
  const flaky = await paidThenRefunded("pp-flaky@example.com");
  failing = true;
  await sweep();
  const firstLook = Math.floor(Date.now() / 1000);
  is("not told yet", await told(flaky.capture), 0);
  is("the order stays watched, looked at again in an hour", await watchedAt(flaky.order), firstLook + 3600);
  is("nothing is said not sent yet", (await notSent()).length, 0);
  is("the purchase waits with it: taken back once the refund is told", await holds(flaky.email), 1);
  hour();
  await sweep();
  is("an hour later, still failing: still watched, still not said", [await told(flaky.capture), (await watchedAt(flaky.order)) !== null, (await notSent()).length], [0, true, 0]);
  failing = false;
  hour();
  await sweep();
  is("then it works: told once", await told(flaky.capture), 1);
  is("the purchase is taken back and the order leaves the watch", [await holds(flaky.email), await watchedAt(flaky.order)], [0, null]);
  is("and nothing is said not sent", (await notSent()).length, 0);

  part("A telling that keeps failing: tried at most REFUND_TELL_TRIES_AT_MOST times, then said not sent, once");
  const lost = await paidThenRefunded("pp-lost@example.com");
  failing = true;
  let tries = 0;
  const own: number[] = [];
  const looks: number[] = [];
  let lineCommands = -1;
  const keyOf = (c: (string | number)[]) => String(c[1] ?? "");
  for (let look = 0; look < 48 && (await watchedAt(lost.order)) !== null; look += 1) {
    const before = sent.length;
    await sweep();
    const pass = sent.slice(before);
    if (pass.some((c) => c[0] === "HGET" && keyOf(c).startsWith("nl:erased:"))) tries += 1;
    const lineAt = pass.findIndex((c) => c[0] === "SET" && keyOf(c).startsWith("nl:hooks:evt:") && pass.some((d) => d[0] === "SET" && keyOf(d).startsWith("nl:hooks:d:") && d.includes("NX")));
    own.push(pass.filter((c) => keyOf(c).startsWith("nl:ppsell:tell:") || (c[0] === "ZADD" && keyOf(c) === watch && c[3] === lost.order && Number(c[2]) > 0)).length);
    looks.push(pass.filter((c) => (c[0] === "GET" && keyOf(c) === `nl:ppsell:paid:${lost.order}`) || ((c[0] === "ZADD" || c[0] === "EXPIRE") && keyOf(c) === `nl:ppsell:refunded:${statsId}`)).length);
    // The last pass: what the "Not sent" lines took, from the event's mark taken for them to the log's LTRIM.
    const lastEvt = pass.map((c, at) => (c[0] === "SET" && keyOf(c).startsWith("nl:hooks:evt:") ? at : -1)).filter((at) => at >= 0).pop();
    const trim = pass.findIndex((c) => c[0] === "LTRIM" && keyOf(c).startsWith("nl:hooks:log:"));
    if (lineAt >= 0 && lastEvt !== undefined && trim > lastEvt) lineCommands = pass.slice(lastEvt, trim + 1).filter((c) => keyOf(c).startsWith("nl:hooks:evt:") || keyOf(c).startsWith("nl:hooks:d:") || keyOf(c).startsWith("nl:hooks:log:")).length;
    hour();
  }
  is("tried at most REFUND_TELL_TRIES_AT_MOST times, an hour apart", tries, triesAtMost);
  is("the registry's triesAtMost is that bound (PAYPAL_REFUND_TELL_RETRY)", PAYPAL_REFUND_TELL_RETRY.triesAtMost, triesAtMost);
  is("each failed try's own commands as the registry prices them, none more at the last", own, [...Array(tries - 1).fill(PAYPAL_REFUND_TELL_RETRY.ownCommandsPerFailedTry), PAYPAL_REFUND_TELL_RETRY.ownCommandsPerFailedTry - 1]);
  is("each try looks at the order with the commands the registry prices", looks.every((n) => n === PAYPAL_REFUND_TELL_RETRY.lookCommandsPerFailedTry), true);
  is("the not-sent lines take no more than the registry prices", lineCommands > 0 && lineCommands <= PAYPAL_REFUND_TELL_RETRY.notSentCommandsAtMost, true);
  is("never told", await told(lost.capture), 0);
  const lines = await notSent();
  is("one line in the store's webhook log, for the endpoint that hears refunds", lines.length, 1);
  is("it says the event was not sent and where to look", typeof lines[0]?.lastError === "string" && lines[0].lastError.includes("PayPal refund") && lines[0].lastError.includes("PayPal account"), true);
  is("the purchase is taken back and the order leaves the watch", [await holds(lost.email), await watchedAt(lost.order)], [0, null]);
  failing = false;
  await redis.pipeline([["ZADD", watch, "0", lost.order]]);
  await sweep();
  is("looked at again once it would work: said not sent stays final, nothing sent after", [await told(lost.capture), (await notSent()).length], [0, 1]);

  part("The first-failure mark read in its exact shape (CX-123 rule 24)");
  for (const [name, odd] of [["text that is not whole seconds", "soon"], ["a number", 1_790_000_000], ["an empty text", ""], ["a list", ["1"]]] as const) {
    const unsure = await paidThenRefunded(`pp-odd-${name.replace(/[^a-z]/g, "")}@example.com`);
    failing = true;
    oddMark = odd;
    await sweep();
    const at = Math.floor(Date.now() / 1000);
    is(`${name}: unknown, so the order stays watched an hour, nothing said not sent`, [await watchedAt(unsure.order), (await notSent()).length, await holds(unsure.email)], [at + 3600, 1, 1]);
    oddMark = undefined;
    failing = false;
    hour();
    await sweep();
    is(`${name}: told once it works`, await told(unsure.capture), 1);
  }

  part("Said not sent only for an event not told: one already sent writes nothing");
  const notSentLines = (hooks as Record<string, unknown>).notSentLines as ((...args: unknown[]) => Promise<number>) | undefined;
  is("notSentLines is there", typeof notSentLines, "function");
  if (notSentLines) {
    is("a refund already told: no line", await notSentLines(store, "refund.issued", `paypal:${healthy.capture}`, "Not sent, synthetic."), 0);
    is("still one line in all", (await notSent()).length, 1);
  }

  part("The tries stay inside REFUND_TELL_TRIES_AT_MOST whatever the mark answers (Codex C2's M1 on #3499)");
  /** The tellings the sweep tried over `looks` hourly looks: each try reads the deletion print, which fails. */
  const triesOver = async (looks: number, order: string) => {
    let n = 0;
    for (let look = 0; look < looks && (await watchedAt(order)) !== null; look += 1) {
      const before = sent.length;
      await sweep();
      if (sent.slice(before).some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:"))) n += 1;
      hour();
    }
    return n;
  };
  const shapes: [string, () => void][] = [
    ["a mark that reads as text, not whole seconds, on every look", () => { oddMark = "soon"; }],
    ["a mark whose write writes nothing and answers QUEUED", () => { markWrites = "lost"; }],
    ["a mark that reads as a time ten days ahead of the clock", () => { oddMark = String(Math.floor(Date.now() / 1000) + 10 * 86_400); }],
  ];
  for (const [name, set] of shapes) {
    const odd = await paidThenRefunded(`pp-bound-${name.replace(/[^a-z]/g, "").slice(0, 24)}@example.com`);
    const linesBefore = (await notSent()).length;
    failing = true;
    set();
    const unsure = await triesOver(12, odd.order);
    is(`${name}: twelve hourly looks try the telling at most REFUND_TELL_TRIES_AT_MOST times`, unsure <= (triesAtMost as number), true);
    is(`${name}: unknown, so still watched, not told, nothing said not sent, the purchase held`, [(await watchedAt(odd.order)) !== null, await told(odd.capture), (await notSent()).length, await holds(odd.email)], [true, 0, linesBefore, 1]);
    oddMark = undefined;
    markWrites = undefined;
    const after = await triesOver(48, odd.order);
    is(`${name}: once the mark reads, still failing: the tries in all stay inside REFUND_TELL_TRIES_AT_MOST`, unsure + after <= (triesAtMost as number), true);
    is(`${name}: then said not sent once, the purchase taken back, the order out of the watch`, [(await notSent()).length, await holds(odd.email), await watchedAt(odd.order)], [linesBefore + 1, 0, null]);
    failing = false;
  }
  {
    const odd = await paidThenRefunded("pp-bound-thrown@example.com");
    const linesBefore = (await notSent()).length;
    failing = true;
    markWrites = "throwOnce";
    const tries = await triesOver(48, odd.order);
    is("a first mark write with no answer: tried again, the tries in all inside REFUND_TELL_TRIES_AT_MOST", tries > 1 && tries <= (triesAtMost as number), true);
    is("a first mark write with no answer: then said not sent once, the order out of the watch", [(await notSent()).length, await watchedAt(odd.order)], [linesBefore + 1, null]);
    markWrites = undefined;
    failing = false;
  }

  console.error = logged;
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
