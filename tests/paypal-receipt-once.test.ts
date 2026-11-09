/**
 * A PayPal receipt tried again is the same email, through the same sender, and never after its keys could have
 * expired (money review of #3387, probes A, B, C and the list's re-add).
 *
 * Synthetic: the SES and Resend stand-ins (tests/ses-mail-fixture.ts, with the guarded Resend transport's synthetic
 * account), a PayPal stand-in, the Redis stub, the real return route and the real sweep (sweepPayPal). Every request
 * a sender received for the buyer is counted as a copy that may have reached them: an accepted one, and one whose
 * answer was lost or was a 503.
 *
 *   A:  Amazon's answer is lost, then Amazon is not ready: the next tries never go to Resend;
 *   A2: Resend answers 503, then Amazon is ready again: the next tries never go to Amazon;
 *   B:  Amazon's answer is lost, then no job runs for 25 hours: the late sweep sends nothing more;
 *   C:  Resend alone answers 503 for 26 hours of five-minute runs: one request, one body;
 *   D:  an order a concurrent run took off the list while its receipt was being tried is not put back;
 *   E:  Amazon refuses it for the account, then Resend refuses it for the whole window: Amazon is asked once, Resend
 *       at most RECEIPT_TRIES_AT_MOST times, each try's Redis commands at most the registry's (PAYPAL_HAND_OVER_RETRY
 *       in tests/plan-cost-registry.ts; the account refusal, with the owner told, is the longest try measured, longer
 *       than a message refusal; Resend alone is held by tests/paypal-handover-cost.test.ts);
 *   E2: the same, with Resend asking to slow down (429) on every attempt: viaResend makes its three attempts in each
 *       try, the longest try of all, measured and held to the registry's commandsPerReceiptTry;
 *   F:  Amazon refuses it for the account, then is down for 23 hours: Resend sends it in the same try (review
 *       6739456860, probe D);
 *   G:  Amazon refuses it every time while ready: Resend sends it in the same try, Amazon is not asked again (probe D2);
 *   H:  sendEmailPinned alone: a refusal moves the key to Resend in the same call; a lost answer, a once-mark another
 *       try took meanwhile, or a move whose reply is not exact sends nothing more;
 *   I:  Resend blocked, as in production today (CURRENT_RESEND_FALLBACK_REVIEW and CURRENT_RESEND_CREDENTIAL_BINDING
 *       null): a refusal Amazon gave (busy three times, or an account hold that clears) keeps the key for Amazon, so a
 *       later try sends it through Amazon (review 6739914424, probes P1 and P2).
 */
import { createHash } from "node:crypto";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { type Listing, readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import * as delivery from "@/lib/paypal-delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { PAYPAL_HAND_OVER_RETRY } from "./plan-cost-registry";
import { installSesMailFixture } from "./ses-mail-fixture";
import { sendEmailPinned } from "@/lib/email";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const DAY_MS = 86_400_000;
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
let buyerFor = "buyer@example.com";
const orderId = (n: number) => `6P290127TN36471${String(n).padStart(2, "0")}`;
/** What Resend answers: accepted, a 503 (its answer not known to be a refusal), a 422 (a refusal) or a 429 (slow down). */
let resendMode: "up" | "503" | "422" | "429" = "up";
/** Called on each Resend request before it is answered (probe D). */
let onResendPost: (() => void) | null = null;
/** Every Resend request: its idempotency key and body text. */
const resendPosts: { key: string; to: string; text: string }[] = [];
/** How many of the next Amazon requests are answered 429, too many a second ("busy", a definite no) (probe P1). */
let sesBusy = 0;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `4D679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
async function paypal(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = completed(capture, "49.00", buyerFor);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}

const mail = installSesMailFixture({
  fallback: paypal,
  onSes: () => {
    if (sesBusy <= 0) return undefined;
    sesBusy -= 1;
    return json({ message: "synthetic Maximum sending rate exceeded" }, 429);
  },
  onResend: (messages, _input, init) => {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    for (const m of messages) resendPosts.push({ key, to: m.to[0] ?? "", text: m.text });
    onResendPost?.();
    if (resendMode === "503") return json({ name: "service_unavailable", message: "synthetic outage" }, 503);
    if (resendMode === "422") return json({ name: "validation_error", message: "synthetic refusal" }, 422);
    if (resendMode === "429") return json({ name: "rate_limit_exceeded", message: "synthetic slow down" }, 429);
    return json({ id: `resend_fixture_${resendPosts.length}` });
  },
});

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
/** Moves the clock to a minute after the next UTC midnight, so a probe's day of tries stays inside one synthetic Resend account day. */
const startOfNextDay = () => {
  const now = Date.now();
  ahead += Math.ceil(now / DAY_MS) * DAY_MS + 60_000 - now;
};
const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;
const hashed = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 40);
const pinOf = (key: string) => `nl:mail:pin:${hashed(key)}`;
const onceOf = (key: string) => `nl:ses:once:${hashed(key)}`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  startOfNextDay();

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(Date.now(), { behind: 10, ahead: 40 }) });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const product: Listing = (await readListing(store, added.product.id))!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const listed = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];
  const sweep = async (hours = 1): Promise<void> => {
    ahead += hours * 3_600_000;
    await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
  };
  const sweeps = async (count: number, hours = 1) => {
    for (let i = 0; i < count; i += 1) await sweep(hours);
  };
  const pay = async (n: number, buyer: string): Promise<string> => {
    buyerFor = buyer;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(opened.reason);
    await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${n}` } }));
    return opened.order;
  };
  /** Every request either sender received for this buyer: each one may have reached them. */
  const copies = (buyer: string) => mail.attempts.filter((m) => m.to.includes(buyer));
  const sesTo = (buyer: string) => mail.sesAttempts.filter((m) => m.to.includes(buyer)).length;
  const resendTo = (buyer: string) => mail.resendAttempts.filter((m) => m.to.includes(buyer)).length;

  part("A: Amazon's answer is lost, then Amazon is not ready: the receipt never goes through Resend");
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome(["lost"]);
  const buyerA = "lost-ses@example.com";
  const a = await pay(1, buyerA);
  is("one request to Amazon, its answer lost", [sesTo(buyerA), resendTo(buyerA)], [1, 0]);
  is("the order is still owed its receipt", (await listed()).includes(a), true);
  await mail.setReady(false);
  await sweeps(4);
  is("Amazon not ready: no request to Resend for this receipt", resendTo(buyerA), 0);
  await mail.setReady(true);
  await sweeps(4);
  is("Amazon ready again: no second request to Amazon either", sesTo(buyerA), 1);
  is("at most one copy may have reached the buyer", copies(buyerA).length, 1);
  await sweeps(20);
  is("past its window the order leaves the list", (await listed()).includes(a), false);
  is("still one copy at most", copies(buyerA).length, 1);

  part("A2: Resend answers 503, then Amazon is ready: the receipt never goes through Amazon");
  startOfNextDay();
  mail.setSesOutcome("ok");
  await mail.setReady(false);
  resendMode = "503";
  const buyerA2 = "lost-resend@example.com";
  const a2 = await pay(2, buyerA2);
  is("one request to Resend, answered 503", [sesTo(buyerA2), resendTo(buyerA2)], [0, 1]);
  is("the order is still owed its receipt", (await listed()).includes(a2), true);
  resendMode = "up";
  await mail.setReady(true);
  await sweeps(4);
  is("Amazon ready: no request to Amazon for this receipt", sesTo(buyerA2), 0);
  is("at most one copy may have reached the buyer", copies(buyerA2).length, 1);
  await sweeps(20);
  is("past its window the order leaves the list", (await listed()).includes(a2), false);
  is("still one copy at most", copies(buyerA2).length, 1);

  part("B: Amazon's answer is lost, then no job runs for 25 hours: the late sweep sends nothing more");
  startOfNextDay();
  await mail.setReady(true);
  mail.setSesOutcome(["lost"]);
  const buyerB = "late-sweep@example.com";
  const b = await pay(3, buyerB);
  is("one request to Amazon, its answer lost", copies(buyerB).length, 1);
  await sweep(25);
  is("the sweep 25 hours later sends no second copy", copies(buyerB).length, 1);
  is("and the order leaves the list", (await listed()).includes(b), false);

  part("C: Resend alone answers 503 for 26 hours: one request and one body, not one a try");
  startOfNextDay();
  mail.disableSes();
  resendMode = "503";
  const buyerC = "resend-outage@example.com";
  const c = await pay(4, buyerC);
  for (let run = 0; run < (26 * 3600) / 300; run += 1) await sweep(300 / 3600);
  const toC = resendPosts.filter((p) => p.to === buyerC);
  is("one request to Resend in 26 hours", toC.length, 1);
  is("every request carries the same body", new Set(toC.map((p) => p.text)).size, 1);
  is("under the order's idempotency key", toC.map((p) => p.key), [`nimbus-paypal:${c}`]);
  is("then off the list", (await listed()).includes(c), false);
  resendMode = "up";

  part("D: an order taken off the list while its receipt was tried is not put back");
  startOfNextDay();
  const buyerD = "taken-off@example.com";
  resendMode = "503";
  let paidD = "";
  onResendPost = () => {
    // Another run took it off the list (handed over, or its paid record gone) while this one was sending.
    if (paidD) redis.run(["ZREM", handOverKey(statsId), paidD]);
  };
  paidD = orderId(made + 1);
  const d = await pay(5, buyerD);
  onResendPost = null;
  resendMode = "up";
  is("the order paid is the one watched", d, paidD);
  is("the receipt was tried once", resendTo(buyerD), 1);
  is("not put back on the list", (await listed()).includes(d), false);

  /** Runs `then` after the first pipeline whose commands match `when`, once. */
  const after = (when: (command: (string | number)[]) => boolean, then: (replies: unknown[]) => unknown[] | void) => {
    const pipeline = redis.pipeline.bind(redis);
    let fired = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      if (fired || !commands.some(when)) return replies;
      fired = true;
      return then(replies) ?? replies;
    }) as typeof redis.pipeline;
    return () => { redis.pipeline = pipeline; };
  };

  part("E: Amazon refuses it for the account, then Resend refuses it for the whole window: bounded tries and commands");
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome(["account"]);
  resendMode = "422";
  const buyerE = "ses-refused@example.com";
  // The return route's try stops before sending (its first-try mark is not answered exactly), so the first try is a
  // sweep's: refused by Amazon for the account, moved to Resend and refused there, the longest try, measured below.
  const undoE = after((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:receipt:"), () => ["QUEUED"]);
  const e = await pay(6, buyerE);
  undoE();
  is("the return route's try sent nothing", copies(buyerE).length, 0);
  const paidKey = `nl:ppsell:paid:${e}`;
  let mostATry = 0;
  for (let run = 0; run < (26 * 3600) / 300; run += 1) {
    ahead += 300_000;
    const sent: (string | number)[][] = [];
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return pipeline(commands);
    }) as typeof redis.pipeline;
    try {
      await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
    } finally {
      redis.pipeline = pipeline;
    }
    const from = sent.findIndex((c) => c[0] === "GET" && c[1] === paidKey);
    if (from < 0) continue;
    const to = sent.findLastIndex((c) => c[1] === handOverKey(statsId) && c[c.length - 1] === e);
    mostATry = Math.max(mostATry, to - from + 1);
  }
  mail.setSesOutcome("ok");
  resendMode = "up";
  console.log(`        tries: Amazon ${sesTo(buyerE)}, Resend ${resendTo(buyerE)}, most commands a try: ${mostATry}`);
  is("Amazon was asked once: its refusal moved the receipt to Resend", sesTo(buyerE), 1);
  is("Resend tried more than once and at most RECEIPT_TRIES_AT_MOST times", resendTo(buyerE) > 1 && resendTo(buyerE) <= delivery.RECEIPT_TRIES_AT_MOST, true);
  is("one try's Redis commands at most as the registry states", mostATry > 0 && mostATry <= Number((PAYPAL_HAND_OVER_RETRY as Record<string, number>).commandsPerReceiptTry), true);
  is("then off the list", (await listed()).includes(e), false);

  part("E2: Amazon refuses it for the account, then Resend asks to slow down on every attempt: the longest try, measured");
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome(["account"]);
  resendMode = "429";
  const buyerE2 = "resend-slow@example.com";
  const undoE2 = after((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:receipt:"), () => ["QUEUED"]);
  const e2 = await pay(11, buyerE2);
  undoE2();
  is("the return route's try sent nothing", copies(buyerE2).length, 0);
  const paidKeyE2 = `nl:ppsell:paid:${e2}`;
  let longest = 0;
  for (let run = 0; run < (26 * 3600) / 300; run += 1) {
    ahead += 300_000;
    const sent: (string | number)[][] = [];
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return pipeline(commands);
    }) as typeof redis.pipeline;
    try {
      await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
    } finally {
      redis.pipeline = pipeline;
    }
    const from = sent.findIndex((c) => c[0] === "GET" && c[1] === paidKeyE2);
    if (from < 0) continue;
    const to = sent.findLastIndex((c) => c[1] === handOverKey(statsId) && c[c.length - 1] === e2);
    longest = Math.max(longest, to - from + 1);
  }
  mail.setSesOutcome("ok");
  resendMode = "up";
  console.log(`        tries: Amazon ${sesTo(buyerE2)}, Resend ${resendTo(buyerE2)}, most commands a try: ${longest}`);
  is("Amazon was asked once", sesTo(buyerE2), 1);
  is("Resend asked at most three times a try, at most RECEIPT_TRIES_AT_MOST tries", resendTo(buyerE2) > 3 && resendTo(buyerE2) <= 3 * delivery.RECEIPT_TRIES_AT_MOST, true);
  is("the longest try's Redis commands at most as the registry states", longest > mostATry && longest <= Number((PAYPAL_HAND_OVER_RETRY as Record<string, number>).commandsPerReceiptTry), true);
  is("then off the list", (await listed()).includes(e2), false);

  /** Copies a sender accepted for this buyer: the ones that reached them. */
  const delivered = (buyer: string) => mail.sent.filter((m) => m.to.includes(buyer));
  const resendDelivered = (buyer: string) => mail.resend.filter((m) => m.to.includes(buyer)).length;

  part("F: Amazon refuses it for the account, then is down for 23 hours: Resend sends it in the same try (probe D)");
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome(["account"]);
  const buyerF = "ses-account@example.com";
  const f = await pay(7, buyerF);
  await mail.setReady(false);
  is("Amazon asked once and refused it", sesTo(buyerF), 1);
  is("Resend sent it in the same try", resendDelivered(buyerF), 1);
  is("the order left the list with its receipt", (await listed()).includes(f), false);
  await sweeps(23);
  is("one copy reached the buyer in 23 hours", delivered(buyerF).length, 1);
  is("and no further request was made", copies(buyerF).length, 2);

  part("G: Amazon refuses it every time while ready: Resend sends it in the same try (probe D2)");
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome("refused");
  const buyerG = "ses-refuses@example.com";
  const g = await pay(8, buyerG);
  await sweeps(8);
  mail.setSesOutcome("ok");
  is("Amazon asked once", sesTo(buyerG), 1);
  is("Resend sent it once", [resendTo(buyerG), resendDelivered(buyerG)], [1, 1]);
  is("one copy reached the buyer", delivered(buyerG).length, 1);
  is("the order left the list", (await listed()).includes(g), false);

  part("H: sendEmailPinned alone: only a refusal Amazon gave moves the key to Resend, in the same call");
  const message = (to: string, key: string) => ({ meter: { by: "order" as const }, from: "Harbor Kitchen <orders@marktmorgen.com>", to, subject: "Your order", text: "Thanks.", idempotencyKey: key });
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);

  mail.setSesOutcome("ok");
  is("control: Amazon takes it, one request", [await sendEmailPinned(message("h-ok@example.com", "h:ok")), sesTo("h-ok@example.com"), resendTo("h-ok@example.com")], [true, 1, 0]);
  is("control: the key is kept for Amazon", redis.run(["GET", pinOf("h:ok")]), "ses");

  mail.setSesOutcome("refused");
  is("a refusal Amazon gave: Resend sends it in the same call", await sendEmailPinned(message("h-refused@example.com", "h:refused")), true);
  is("one request to each, one copy delivered", [sesTo("h-refused@example.com"), resendTo("h-refused@example.com"), delivered("h-refused@example.com").length], [1, 1, 1]);
  is("the key is now kept for Resend", redis.run(["GET", pinOf("h:refused")]), "resend");
  mail.setSesOutcome("ok");
  is("a later call goes only to Resend, under the same key", [await sendEmailPinned(message("h-refused@example.com", "h:refused")), sesTo("h-refused@example.com")], [true, 1]);

  mail.setSesOutcome(["lost"]);
  is("a lost answer: no request to Resend", [await sendEmailPinned(message("h-lost@example.com", "h:lost")), sesTo("h-lost@example.com"), resendTo("h-lost@example.com")], [false, 1, 0]);
  is("the key stays kept for Amazon", redis.run(["GET", pinOf("h:lost")]), "ses");
  is("a later call sends nothing more", [await sendEmailPinned(message("h-lost@example.com", "h:lost")), copies("h-lost@example.com").length], [false, 1]);

  mail.setSesOutcome("refused");
  // Another try of the key takes Amazon's once-mark right after this one let it go.
  let undo = after((c) => c[0] === "DEL" && c[1] === onceOf("h:raced"), () => { redis.run(["SET", onceOf("h:raced"), "1", "EX", 86_400]); });
  const raced = await sendEmailPinned(message("h-raced@example.com", "h:raced"));
  undo();
  is("a refusal while another try holds the once-mark: nothing sent to Resend", [raced, sesTo("h-raced@example.com"), resendTo("h-raced@example.com")], [false, 1, 0]);
  is("the key stays kept for Amazon", redis.run(["GET", pinOf("h:raced")]), "ses");

  undo = after((c) => c[0] === "SET" && c[1] === pinOf("h:odd") && c.includes("XX"), () => ["QUEUED"]);
  const odd = await sendEmailPinned(message("h-odd@example.com", "h:odd"));
  undo();
  is("a refusal whose move to Resend is not answered exactly: nothing sent to Resend", [odd, sesTo("h-odd@example.com"), resendTo("h-odd@example.com")], [false, 1, 0]);

  mail.setSesOutcome(["account"]);
  is("an account refusal: Resend sends it in the same call", [await sendEmailPinned(message("h-account@example.com", "h:account")), resendDelivered("h-account@example.com")], [true, 1]);
  mail.setSesOutcome("ok");

  part("I: Resend blocked, as today (no review, no credential binding): Amazon's refusal keeps the key for Amazon (probes P1, P2)");
  // The real guard with today's state: no reviewed Resend account and no credential binding, so it answers "blocked"
  // before any reservation or request.
  const blocked = { review: null, binding: null };
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome("ok");

  sesBusy = 3;
  is("P1: Amazon busy three times and Resend blocked: nothing sent", [await sendEmailPinned(message("i-busy@example.com", "i:busy"), blocked), sesTo("i-busy@example.com"), resendTo("i-busy@example.com")], [false, 3, 0]);
  is("P1: the key stays kept for Amazon, and its once-mark is let go of", [redis.run(["GET", pinOf("i:busy")]), redis.run(["GET", onceOf("i:busy")])], ["ses", null]);
  is("P1: a later try sends it through Amazon: one copy delivered", [await sendEmailPinned(message("i-busy@example.com", "i:busy"), blocked), delivered("i-busy@example.com").length, resendTo("i-busy@example.com")], [true, 1, 0]);

  mail.setSesOutcome(["account"]);
  is("P2: an account refusal and Resend blocked: nothing sent", [await sendEmailPinned(message("i-hold@example.com", "i:hold"), blocked), sesTo("i-hold@example.com"), resendTo("i-hold@example.com")], [false, 1, 0]);
  is("P2: the key stays kept for Amazon", redis.run(["GET", pinOf("i:hold")]), "ses");
  is("P2: while Amazon's hold lasts, a try sends nothing", [await sendEmailPinned(message("i-hold@example.com", "i:hold"), blocked), copies("i-hold@example.com").length], [false, 1]);
  ahead += 11 * 60_000;
  await mail.setReady(true);
  is("P2: once the hold clears, a later try sends it through Amazon: one copy delivered", [await sendEmailPinned(message("i-hold@example.com", "i:hold"), blocked), delivered("i-hold@example.com").length, resendTo("i-hold@example.com")], [true, 1, 0]);

  mail.setSesOutcome("refused");
  is("a message refusal and Resend blocked: nothing sent, the key stays kept for Amazon", [await sendEmailPinned(message("i-refused@example.com", "i:refused"), blocked), redis.run(["GET", pinOf("i:refused")]), resendTo("i-refused@example.com")], [false, "ses", 0]);
  mail.setSesOutcome("ok");

  // The same through the real return route and sweep: a sending key no reviewed account binds, so the guard answers
  // "blocked" before any reservation, as with today's null review.
  const reviewedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_unreviewed_paypal_probe_only";
  try {
    startOfNextDay();
    mail.configure();
    await mail.setReady(true);
    sesBusy = 3;
    const buyerI1 = "busy-then-ok@example.com";
    const i1 = await pay(9, buyerI1);
    is("P1 end to end: the return route's try sends nothing", [sesTo(buyerI1), resendTo(buyerI1), delivered(buyerI1).length], [3, 0, 0]);
    is("P1 end to end: the order is still owed its receipt", (await listed()).includes(i1), true);
    await sweep();
    is("P1 end to end: the next sweep sends it through Amazon: one copy", [delivered(buyerI1).length, resendTo(buyerI1)], [1, 0]);
    is("P1 end to end: the order left the list", (await listed()).includes(i1), false);

    startOfNextDay();
    mail.configure();
    await mail.setReady(true);
    mail.setSesOutcome(["account"]);
    const buyerI2 = "hold-then-ok@example.com";
    const i2 = await pay(10, buyerI2);
    is("P2 end to end: the return route's try sends nothing", [sesTo(buyerI2), resendTo(buyerI2), delivered(buyerI2).length], [1, 0, 0]);
    await mail.setReady(true);
    await sweeps(2);
    is("P2 end to end: a sweep after the hold sends it through Amazon: one copy", [delivered(buyerI2).length, resendTo(buyerI2), copies(buyerI2).length], [1, 0, 2]);
    is("P2 end to end: the order left the list", (await listed()).includes(i2), false);
  } finally {
    if (reviewedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = reviewedKey;
  }

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
