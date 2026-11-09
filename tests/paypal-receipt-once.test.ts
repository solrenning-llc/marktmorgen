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
 *       later try sends it through Amazon (review 6739914424, probes P1 and P2);
 *   J:  Resend's first answer is a 503, then the product is renamed: every later try sends the receipt as it was first
 *       made, the same bytes under the same key, so the guarded transport sees one attempt and makes no second
 *       request (second money review of #3387); kept words that do not read send nothing, and words deleted with the
 *       person are never made again for a key a request was already made under;
 *   K:  the person deleted while their receipt is being kept: once the deletion is confirmed, the receipt is not kept
 *       again, nothing is sent to them and the order leaves the list; a person deleted before they pay again is sent
 *       the new receipt; a keep whose reply is not exact sends nothing; a store from before lists is given one first;
 *   L:  the person deleted after paying while their receipt is still owed (the first try refused): the next try writes
 *       nothing of them again (their purchase, their library, their erasure notes, nothing that names them), sends
 *       nothing and takes the order off the list; a person deleted before they pay again is handed the new order; a
 *       deletion that completes during a try, after its check, takes the order off the list in that try; a deletion
 *       mark whose reply is not exact writes nothing and keeps the order owed.
 *   M:  which deletion it was (second independent review of #3449, probes P1 to P4): a deletion by the store's team
 *       keeps the purchase, so an order still owed is handed over (P1, P2); a deletion the person asked for that
 *       completes during a try takes back what that try wrote of them (P3); an affiliate's commission on a sale paid
 *       and handed over is credited although the person was deleted afterward (P4); a refund told to the webhooks
 *       after the person's own deletion does not carry their address, nor one whose deletion note does not read; a
 *       take-back keeps a purchase made after the deletion; a person's own deletion whose note is not confirmed
 *       answers incomplete; their own yes lifts the note with the fingerprint.
 */
import { createHash } from "node:crypto";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, editProduct, setProductCourse, setProductLink, setSubscription, setPayPalSeller, setAffiliateSetting, storeForEmail, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, storeKey } from "@/lib/learn";
import { ROOM } from "./data-room";
import { forgetNoted, noteForErasure } from "@/lib/erasure-index";
import { liftCommand } from "@/lib/suppression";
import { importedKey } from "@/lib/imported-purchases";
import { storesBoughtFrom } from "@/lib/buyer-library";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { addEndpoint } from "@/lib/webhooks";
import { erasePerson } from "@/lib/person-erasure";
import { type Listing, readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import * as delivery from "@/lib/paypal-delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { PAYPAL_HAND_OVER_RETRY } from "./plan-cost-registry";
import { FAMILIES } from "./store-data-registry";
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
/** Captures PayPal answers as refunded in full (part M). */
const refundedCaptures = new Set<string>();
const orderId = (n: number) => `6P290127TN36471${String(n).padStart(2, "0")}`;
/** What Resend answers: accepted, a 503 (its answer not known to be a refusal), a 422 (a refusal) or a 429 (slow down). */
let resendMode: "up" | "503" | "422" | "429" = "up";
/** Called on each Resend request before it is answered (probe D). */
let onResendPost: (() => void) | null = null;
/** Every Resend request: its idempotency key, subject, body text and the exact bytes it posted. */
const resendPosts: { key: string; to: string; subject: string; text: string; body: string }[] = [];
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
  if (cap && method === "GET") return json({ id: cap, status: refundedCaptures.has(cap) ? "REFUNDED" : "COMPLETED" });
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
    for (const m of messages) resendPosts.push({ key, to: m.to[0] ?? "", subject: m.subject, text: m.text, body: typeof init?.body === "string" ? init.body : "" });
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
  /** How many purchases the address holds here (HLEN: the stub keeps an empty hash a read touched, Redis keeps none). */
  const purchasesOf = (buyer: string) => redis.run(["HLEN", importedKey(statsId, buyer)]);
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
  is("lib/paypal-delivery.ts names the sender's key as lib/email.ts writes it", redis.run(["GET", delivery.pinnedSenderKey("h:ok")]), "ses");

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

  part("J: Resend's first answer is a 503, then the product is renamed: every try sends the receipt as first made");
  startOfNextDay();
  mail.disableSes();
  /** The guarded transport's attempt identity (lib/resend-fallback-transport.ts): its path, its exact body and its key. */
  const attemptOf = (p: { body: string; key: string }) => createHash("sha256").update(JSON.stringify(["/emails", p.body, p.key])).digest("hex");
  const postsTo = (buyer: string) => resendPosts.filter((p) => p.to === buyer);
  const mailKeyOf = (order: string) => `nl:ppsell:mail:${order}`;
  const title = product.title;
  const rename = async (to: string) => {
    const edited = await editProduct("owner@example.com", product.id, to, "", "49");
    if (!edited.ok) throw new Error("the product was not renamed");
  };
  resendMode = "503";
  const buyerJ = "renamed-later@example.com";
  const j = await pay(12, buyerJ);
  is("the return route's try: one request to Resend, answered 503", postsTo(buyerJ).length, 1);
  await sweep(6 / 60);
  is("control: a sweep 6 minutes later, nothing edited, makes no second request", postsTo(buyerJ).length, 1);
  await rename(`${title}, Second Edition`);
  await sweep(6 / 60);
  is("the sweep after the product was renamed makes no second request", postsTo(buyerJ).length, 1);
  for (let run = 0; run < (23 * 3600) / 300; run += 1) await sweep(300 / 3600);
  const toJ = postsTo(buyerJ);
  is("in its whole window, one request to Resend", toJ.length, 1);
  is("every request: the same subject, the same text, the same bytes", [new Set(toJ.map((p) => p.subject)).size, new Set(toJ.map((p) => p.text)).size, new Set(toJ.map((p) => p.body)).size], [1, 1, 1]);
  is("under the order's idempotency key", [...new Set(toJ.map((p) => p.key))], [`nimbus-paypal:${j}`]);
  is("one attempt identity for the guarded transport, not one per body", new Set(toJ.map(attemptOf)).size, 1);
  is("the receipt names the product as it was when paid", (toJ[0]?.subject ?? "").includes("Second Edition"), false);
  is("then off the list", (await listed()).includes(j), false);
  await rename(title);

  part("J: kept words that do not read send nothing, and the words kept are the ones sent once they read again");
  startOfNextDay();
  resendMode = "422";
  const buyerJ2 = "kept-words@example.com";
  const j2 = await pay(13, buyerJ2);
  is("the return route's try: refused by Resend (422)", postsTo(buyerJ2).length, 1);
  const kept = redis.run(["GET", mailKeyOf(j2)]);
  is("the receipt as first made is kept for its order", typeof kept === "string" && String(kept).includes(buyerJ2), true);
  const ttl = Number(redis.run(["TTL", mailKeyOf(j2)]));
  is("for a day at most", ttl > 0 && ttl <= delivery.RECEIPT_MAIL_SECONDS, true);
  is("within the bytes the store-data registry prices", Buffer.byteLength(String(kept)) <= delivery.RECEIPT_MAIL_BYTES, true);
  const priced = FAMILIES["nl:ppsell:mail:@lib/paypal-delivery.ts"]?.parts?.[0];
  is("which prices the kept receipt at its most, for as long as it is kept", Boolean(priced && "per" in priced && priced.bytes >= delivery.RECEIPT_MAIL_BYTES && priced.days * 86_400 >= delivery.RECEIPT_MAIL_SECONDS), true);
  await rename(`${title}, Third Edition`);
  resendMode = "up";
  redis.run(["SET", mailKeyOf(j2), "{\"subject\":", "EX", String(ttl)]);
  await sweep(6 / 60);
  is("kept words that do not read: no request, and nothing made again", postsTo(buyerJ2).length, 1);
  is("the order is still owed its receipt", (await listed()).includes(j2), true);
  redis.run(["SET", mailKeyOf(j2), String(kept), "EX", String(ttl)]);
  await sweep(12 / 60);
  const toJ2 = postsTo(buyerJ2);
  is("read again: the next sweep sends it once more, under the same key", [toJ2.length, toJ2[1]?.key], [2, `nimbus-paypal:${j2}`]);
  is("with the very bytes of the first request", toJ2[1]?.body === toJ2[0]?.body, true);
  is("then off the list", (await listed()).includes(j2), false);
  await rename(title);

  part("J: the kept words are deleted with the person, and never made again for a key a request was made under");
  startOfNextDay();
  resendMode = "422";
  const buyerJ3 = "erased-meanwhile@example.com";
  const j3 = await pay(14, buyerJ3);
  is("the return route's try: refused by Resend (422)", postsTo(buyerJ3).length, 1);
  await forgetNoted(statsId, buyerJ3);
  is("deleting the person deletes the receipt's kept words", redis.run(["GET", mailKeyOf(j3)]), null);
  resendMode = "up";
  await sweeps(3);
  is("no request with words made again", postsTo(buyerJ3).length, 1);
  is("and none are kept again", redis.run(["GET", mailKeyOf(j3)]), null);
  resendMode = "up";

  part("K: a person deleted while their receipt is being kept: nothing kept or sent after the deletion confirmed");
  startOfNextDay();
  resendMode = "422";
  /** Whether a command writes an order's kept receipt: the SET of its key, or a script given its key. */
  const keepsReceipt = (c: (string | number)[]) =>
    (c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:mail:")) || (c[0] === "EVAL" && c.slice(3).some((arg) => String(arg).startsWith("nl:ppsell:mail:")));
  /** Holds the first pipeline that keeps a receipt just before that command, until `release` is called. */
  const holdKeep = () => {
    const pipeline = redis.pipeline.bind(redis);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const at = commands.findIndex(keepsReceipt);
      if (held || at < 0) return pipeline(commands);
      held = true;
      const before = at > 0 ? await pipeline(commands.slice(0, at)) : [];
      entered();
      await released;
      return [...before, ...(await pipeline(commands.slice(at)))];
    }) as typeof redis.pipeline;
    return { reached, release, undo: () => (redis.pipeline = pipeline) };
  };
  const buyerK = "erased-while-kept@example.com";
  const hold = holdKeep();
  let k = "";
  const paying = pay(15, buyerK).then((order) => (k = order));
  await hold.reached;
  const erased = await erasePerson(await fresh(), buyerK, { kind: "person" });
  is("the deletion completes", erased.ok, true);
  hold.release();
  await paying;
  hold.undo();
  is("the receipt's words are not kept again after the deletion confirmed", redis.run(["GET", mailKeyOf(k)]), null);
  is("nothing was sent to the deleted person", copies(buyerK).length, 0);
  is("the order leaves the list: nothing of it is tried again for them", (await listed()).includes(k), false);
  resendMode = "up";
  await sweeps(3);
  is("later sweeps send nothing to them and keep nothing", [copies(buyerK).length, redis.run(["GET", mailKeyOf(k)])], [0, null]);

  part("K: control: a person deleted before they pay again is sent the receipt of the new payment");
  startOfNextDay();
  resendMode = "up";
  const buyerK2 = "came-back@example.com";
  const before = await erasePerson(await fresh(), buyerK2, { kind: "person" });
  is("the earlier deletion completes", before.ok, true);
  ahead += 5_000;
  const k2 = await pay(16, buyerK2);
  is("the new payment's receipt is sent once", copies(buyerK2).length, 1);
  is("and the order leaves the list", (await listed()).includes(k2), false);

  part("K: the keep's reply not in its exact shape: nothing sent, the order stays owed");
  startOfNextDay();
  resendMode = "up";
  const buyerK3 = "odd-keep@example.com";
  const undoK3 = after(keepsReceipt, () => ["OK"]);
  const k3 = await pay(17, buyerK3);
  undoK3();
  is("nothing sent on a keep whose reply is not exact", copies(buyerK3).length, 0);
  is("the order is still owed its receipt", (await listed()).includes(k3), true);
  await sweep(6 / 60);
  is("the next sweep keeps and sends it once", copies(buyerK3).length, 1);

  part("K: a store from before lists is given one before a receipt is kept, so a deletion can be checked");
  startOfNextDay();
  resendMode = "up";
  const recordKey = redis.keys().find((key) => {
    let raw: unknown = null;
    try {
      raw = redis.run(["GET", key]);
    } catch {
      return false;
    }
    return typeof raw === "string" && raw.includes("\"handle\":\"harbor\"") && raw.includes("\"listId\":");
  });
  if (!recordKey) throw new Error("the store's record was not found");
  const record = JSON.parse(String(redis.run(["GET", recordKey]))) as Record<string, unknown>;
  record.listId = null;
  redis.run(["SET", recordKey, JSON.stringify(record)]);
  is("control: the store has no list", (await fresh()).listId, null);
  const buyerK4 = "no-list-yet@example.com";
  const sentK4: (string | number)[][] = [];
  const pipelineK4 = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sentK4.push(...commands);
    return pipelineK4(commands);
  }) as typeof redis.pipeline;
  let k4 = "";
  try {
    k4 = await pay(18, buyerK4);
  } finally {
    redis.pipeline = pipelineK4;
  }
  // The store's list written once, before the hand-over reads the person's deletion mark (nothing in between for a
  // store with a list: the paid record's last write, then that read): the commands that try adds, at most.
  const markRead = sentK4.findIndex((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:"));
  const paidWrite = sentK4.findLastIndex((c, i) => i < markRead && String(c[1]).startsWith("nl:ppsell:sales:"));
  const listWrite = markRead > paidWrite && paidWrite >= 0 ? markRead - paidWrite - 1 : -1;
  console.log(`        the list's write added ${listWrite} commands to that try`);
  is("the list's write, once in a store's life, adds at most the 7 commands the registry adds for it (commandsPerReceiptTry)", listWrite > 0 && listWrite <= 7, true);
  is("its receipt is sent once", copies(buyerK4).length, 1);
  is("the store has a list now", typeof (await fresh()).listId, "string");
  is("and the order leaves the list", (await listed()).includes(k4), false);

  part("L: the person deleted after paying while their receipt is owed: the next try writes nothing of them again");
  startOfNextDay();
  /** Every key and its value (the stub's DUMP: reads, never makes a key), to see what a try wrote. */
  const snapshot = () => new Map(redis.keys().map((key) => [key, JSON.stringify(redis.run(["DUMP", key]))]));
  /** The keys a try made or changed since `then` whose value names this address. */
  const naming = (then: Map<string, string>, buyer: string) =>
    [...snapshot()].filter(([key, value]) => then.get(key) !== value && value.toLowerCase().includes(buyer)).map(([key]) => key);
  const notesOf = (buyer: string) => String(noteForErasure(statsId, buyer, "x")[0]?.[1]);
  resendMode = "422";
  const buyerL = "erased-after-paying@example.com";
  const l = await pay(19, buyerL);
  is("the return route's try: refused by Resend (422)", copies(buyerL).length, 1);
  is("the order is still owed its receipt", (await listed()).includes(l), true);
  is("control: that try handed the purchase over and noted it in their library", [purchasesOf(buyerL), (await storesBoughtFrom(buyerL)).includes(store.sid)], [1, true]);
  const erasedL = await erasePerson(await fresh(), buyerL, { kind: "person" });
  is("the deletion completes", erasedL.ok, true);
  is("control: the deletion took their purchase, library and notes", [purchasesOf(buyerL), (await storesBoughtFrom(buyerL)).includes(store.sid), redis.run(["EXISTS", notesOf(buyerL)])], [0, false, 0]);
  const afterErasure = snapshot();
  resendMode = "up";
  await sweep(6 / 60);
  is("the next try does not hand the purchase over again", purchasesOf(buyerL), 0);
  is("nor note it in their library again", (await storesBoughtFrom(buyerL)).includes(store.sid), false);
  is("nor note anything for their deletion again", redis.run(["EXISTS", notesOf(buyerL)]), 0);
  is("no key it made or changed names them", naming(afterErasure, buyerL), []);
  is("nothing more was sent to them", copies(buyerL).length, 1);
  is("the order leaves the list", (await listed()).includes(l), false);
  await sweeps(3);
  is("later sweeps write and send nothing of them", [purchasesOf(buyerL), naming(afterErasure, buyerL), copies(buyerL).length], [0, [], 1]);

  part("L: control: a person deleted before they pay again is handed the new order on its next try");
  startOfNextDay();
  const buyerL2 = "deleted-then-paid@example.com";
  const beforeL2 = await erasePerson(await fresh(), buyerL2, { kind: "person" });
  is("the earlier deletion completes", beforeL2.ok, true);
  ahead += 5_000;
  resendMode = "422";
  const l2 = await pay(20, buyerL2);
  is("the return route's try: refused by Resend (422)", copies(buyerL2).length, 1);
  is("and the purchase handed over", purchasesOf(buyerL2), 1);
  resendMode = "up";
  await sweep(6 / 60);
  is("the next try sends the receipt", copies(buyerL2).length, 2);
  is("the purchase is still theirs", purchasesOf(buyerL2), 1);
  is("and the order leaves the list", (await listed()).includes(l2), false);

  part("L: the deletion completes during a try, after its check: the receipt gone and its sender kept, the order leaves in that try");
  startOfNextDay();
  resendMode = "422";
  const buyerL3 = "erased-during-try@example.com";
  const l3 = await pay(21, buyerL3);
  is("the return route's try: refused by Resend (422)", copies(buyerL3).length, 1);
  resendMode = "up";
  {
    // Holds the try's read of the kept receipt and its sender until the deletion completes.
    const pipeline = redis.pipeline.bind(redis);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (held || !commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:pin:"))) return pipeline(commands);
      held = true;
      entered();
      await released;
      return pipeline(commands);
    }) as typeof redis.pipeline;
    ahead += 6 * 60_000;
    const trying = delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
    await reached;
    const erasedL3 = await erasePerson(await fresh(), buyerL3, { kind: "person" });
    is("the deletion completes", erasedL3.ok, true);
    release();
    await trying;
    redis.pipeline = pipeline;
  }
  is("nothing more was sent to them", copies(buyerL3).length, 1);
  is("the order leaves the list in that try", (await listed()).includes(l3), false);
  is("and nothing of their receipt is kept", redis.run(["GET", mailKeyOf(l3)]), null);

  part("L: the deletion mark's reply not in its exact shape: nothing of the person written, the order stays owed");
  startOfNextDay();
  resendMode = "422";
  const buyerL4 = "odd-mark@example.com";
  const l4 = await pay(22, buyerL4);
  const erasedL4 = await erasePerson(await fresh(), buyerL4, { kind: "person" });
  is("the deletion completes", erasedL4.ok, true);
  resendMode = "up";
  const isMark = (c: (string | number)[]) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:");
  for (const odd of [5, "soon", ["1"], undefined]) {
    const undo = after(isMark, () => [odd]);
    await sweep(6 / 60);
    undo();
    is(`a mark read as ${JSON.stringify(odd) ?? "nothing"}: nothing of them handed over again`, purchasesOf(buyerL4), 0);
    is("nothing sent", copies(buyerL4).length, 1);
    is("the order is still owed", (await listed()).includes(l4), true);
  }
  await sweep(6 / 60);
  is("read exactly at the next sweep: nothing written, and the order leaves the list", [purchasesOf(buyerL4), (await listed()).includes(l4)], [0, false]);

  part("M: P1 control: a deletion by the store's team keeps a purchase already handed over");
  startOfNextDay();
  resendMode = "up";
  const buyerM1 = "team-kept@example.com";
  const m1 = await pay(23, buyerM1);
  is("handed over, its receipt sent", [purchasesOf(buyerM1), copies(buyerM1).length, (await listed()).includes(m1)], [1, 1, false]);
  const teamM1 = await erasePerson(await fresh(), buyerM1, { kind: "team", who: "owner@example.com", role: "owner" });
  is("the team's deletion completes", teamM1.ok, true);
  is("and keeps the purchase", purchasesOf(buyerM1), 1);

  /** Throws a synthetic Upstash failure on the first pipeline that writes a purchase, once. */
  const writesPurchase = (c: (string | number)[]) => c.some((arg) => String(arg).startsWith("nl:imp:buy:"));
  const failOnce = (when: (command: (string | number)[]) => boolean) => {
    const pipeline = redis.pipeline.bind(redis);
    let fired = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (fired || !commands.some(when)) return pipeline(commands);
      fired = true;
      throw new Error("synthetic Upstash failure");
    }) as typeof redis.pipeline;
    return () => { redis.pipeline = pipeline; };
  };

  part("M: P2: the team deletes the person before the first hand-over: the order is still handed over");
  startOfNextDay();
  resendMode = "up";
  const buyerM2 = "team-before-hand-over@example.com";
  const undoM2 = failOnce(writesPurchase);
  const m2 = await pay(24, buyerM2);
  undoM2();
  is("control: the return route's try wrote no purchase and sent nothing", [purchasesOf(buyerM2), copies(buyerM2).length], [0, 0]);
  is("control: the order is still owed", (await listed()).includes(m2), true);
  const teamM2 = await erasePerson(await fresh(), buyerM2, { kind: "team", who: "owner@example.com", role: "owner" });
  is("the team's deletion completes", teamM2.ok, true);
  await sweep(11 / 60);
  is("the next try hands the purchase over: they paid, and a team's deletion keeps purchases", purchasesOf(buyerM2), 1);
  is("no receipt is sent to an address the store deleted", copies(buyerM2).length, 0);
  is("and the order leaves the list", (await listed()).includes(m2), false);

  part("M: P3: the person's own deletion completes during the first try, after its check: what that try wrote is taken back");
  startOfNextDay();
  resendMode = "up";
  const buyerM3 = "erased-mid-hand-over@example.com";
  {
    // Holds the try's purchase write until the person's own deletion completes.
    const pipeline = redis.pipeline.bind(redis);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    /** What the try sent once the deletion completed (from the held purchase write on). */
    const sentM3: (string | number)[][] = [];
    let recording = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (recording) sentM3.push(...commands);
      if (held || !commands.some(writesPurchase)) return pipeline(commands);
      held = true;
      entered();
      await released;
      sentM3.push(...commands);
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const paying = pay(25, buyerM3);
    await reached;
    const erasedM3 = await erasePerson(await fresh(), buyerM3, { kind: "person" });
    is("the deletion completes", erasedM3.ok, true);
    recording = true;
    release();
    const m3 = await paying;
    redis.pipeline = pipeline;
    // The take-back's own commands: after the second read of their own-deletion note, before the list's ZREM.
    const noteRead = sentM3.findLastIndex((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:") && String(c[2]).startsWith("own:"));
    const listOut = sentM3.findIndex((c, i) => i > noteRead && c[0] === "ZREM" && c[1] === handOverKey(statsId));
    const takenBack = noteRead >= 0 && listOut > noteRead ? listOut - noteRead - 1 : -1;
    console.log(`        the take-back sent ${takenBack} commands`);
    const declaredM = PAYPAL_HAND_OVER_RETRY as Record<string, number>;
    is("the take-back, the affiliate bond's one HDEL aside, within the registry's takeBackCommands", takenBack > 0 && takenBack + 1 <= declaredM.takeBackCommands, true);
    is("and the registry's longest try holds a take-back on top of the longest try measured (54 with KEEP_RECEIPT's calls and a list's first write)", declaredM.commandsPerReceiptTry >= 54 + declaredM.takeBackCommands, true);
    is("nothing was sent to them", copies(buyerM3).length, 0);
    is("the purchase that try wrote is taken back", purchasesOf(buyerM3), 0);
    is("and so is the store in their library", (await storesBoughtFrom(buyerM3)).includes(store.sid), false);
    is("the order leaves the list", (await listed()).includes(m3), false);
    await sweeps(2);
    is("later sweeps write nothing of them", [purchasesOf(buyerM3), copies(buyerM3).length], [0, 0]);
  }

  part("M: P4: the person deleted after a try that handed the purchase over: the affiliate is still credited");
  startOfNextDay();
  resendMode = "up";
  const AFF = "0a1b2c3d4e5f";
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30 });
  redis.run(["HSET", `nl:aff:${statsId}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]);
  const buyerM4 = "erased-after-grant@example.com";
  buyerFor = buyerM4;
  const openedM4 = await openOrder(await fresh(), product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, via: { aff: AFF, rate: 30 } });
  if (!openedM4.ok) throw new Error(openedM4.reason);
  const m4 = openedM4.order;
  const undoM4 = after((c) => c[0] === "SET" && String(c[1]).startsWith("nl:orders:link:"), () => ["QUEUED"]);
  await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${m4}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": "198.51.100.26" } }));
  undoM4();
  is("control: that try handed the purchase over, then stopped before crediting the sale", [purchasesOf(buyerM4), redis.run(["HEXISTS", `nl:aff:${statsId}:sales`, `paypal:${m4}`])], [1, 0]);
  is("control: the order is still owed", (await listed()).includes(m4), true);
  const erasedM4 = await erasePerson(await fresh(), buyerM4, { kind: "person" });
  is("the person's own deletion completes", erasedM4.ok, true);
  await sweep(11 / 60);
  is("the next try credits the affiliate for the sale paid and handed over", redis.run(["HEXISTS", `nl:aff:${statsId}:sales`, `paypal:${m4}`]), 1);
  is("without handing anything over to the deleted person again", purchasesOf(buyerM4), 0);
  is("nothing was sent to them", copies(buyerM4).length, 0);
  is("and the order leaves the list", (await listed()).includes(m4), false);

  part("M: a refund told to the webhooks after the person's own deletion does not carry their address");
  startOfNextDay();
  resendMode = "up";
  const hooked = await addEndpoint(await fresh(), "https://hooks.example.com/marktmorgen", ["refund.issued"]);
  is("control: the store listens for refunds", hooked.ok, true);
  const refundBodies = async () => {
    const [log] = await redis.pipeline([["LRANGE", `nl:hooks:log:${statsId}`, 0, -1]]);
    const all = await Promise.all((log as string[]).map(async (id) => JSON.parse(String((await redis.pipeline([["GET", `nl:hooks:d:${id}`]]))[0])) as { type: string; body: string }));
    return all.filter((d) => d.type === "refund.issued").map((d) => JSON.parse(d.body).data as { paypal_capture: string; buyer: { email: string | null } });
  };
  const refundOf = async (order: string) => (await refundBodies()).find((d) => d.paypal_capture === `4D679366HH9087${order.slice(-2)}`);
  const buyerM5 = "erased-then-refunded@example.com";
  const buyerM6 = "refunded@example.com";
  const m5 = await pay(27, buyerM5);
  const m6 = await pay(28, buyerM6);
  is("control: both handed over and receipted", [copies(buyerM5).length, copies(buyerM6).length], [1, 1]);
  const erasedM5 = await erasePerson(await fresh(), buyerM5, { kind: "person" });
  is("the person's own deletion completes", erasedM5.ok, true);
  for (const order of [m5, m6]) {
    refundedCaptures.add(`4D679366HH9087${order.slice(-2)}`);
    redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "0", order]);
  }
  await sweep(6 / 60);
  is("control: a buyer not deleted is named in their refund's event", (await refundOf(m6))?.buyer.email, buyerM6);
  is("the refund of a person deleted at their own request is told without their address", (await refundOf(m5))?.buyer, { email: null, name: null });

  part("M: a deletion's take-back keeps a purchase of the same product they made after it");
  startOfNextDay();
  resendMode = "422";
  const buyerM7 = "deleted-then-bought-again@example.com";
  const m7 = await pay(29, buyerM7);
  is("control: the first order's receipt refused, the order still owed", (await listed()).includes(m7), true);
  const erasedM7 = await erasePerson(await fresh(), buyerM7, { kind: "person" });
  is("the person's own deletion completes", erasedM7.ok, true);
  ahead += 5_000;
  resendMode = "up";
  const m8 = await pay(30, buyerM7);
  is("control: the new order, paid after the deletion, is handed over", [purchasesOf(buyerM7), (await listed()).includes(m8)], [1, false]);
  await sweep(6 / 60);
  is("the first order leaves the list", (await listed()).includes(m7), false);
  is("the new order's purchase is kept", purchasesOf(buyerM7), 1);
  is("and so is the store among those they bought from", (await storesBoughtFrom(buyerM7)).includes(store.sid), true);

  part("M: the note of a person's own deletion not confirmed: the deletion answers incomplete, so it is pressed again");
  const buyerM9 = "note-unconfirmed@example.com";
  const isOwnNote = (c: (string | number)[]) => c[0] === "HSET" && String(c[1]).startsWith("nl:erased:") && String(c[2]).startsWith("own:");
  const undoM9 = after(isOwnNote, () => ["OK"]);
  const erasedM9 = await erasePerson(await fresh(), buyerM9, { kind: "person" });
  undoM9();
  is("incomplete, naming the note", erasedM9.ok ? [] : erasedM9.reason === "incomplete" ? erasedM9.failed : [erasedM9.reason], ["lib/suppression.ts"]);
  const erasedM9b = await erasePerson(await fresh(), buyerM9, { kind: "person" });
  is("pressed again, it completes", erasedM9b.ok, true);
  const listM9 = (await fresh()).listId!;
  is("a team's deletion writes no such note", (await erasePerson(await fresh(), "team-only@example.com", { kind: "team", who: "owner@example.com", role: "owner" })).ok && redis.run(["HEXISTS", `nl:erased:${listM9}`, `own:${createHash("sha256").update(`nimbus-erased:${listM9}:team-only@example.com`).digest("hex").slice(0, 32)}`]), 0);
  redis.run(liftCommand(listM9, buyerM9));
  is("the person's own yes lifts the fingerprint and the note together", [redis.run(["HEXISTS", `nl:erased:${listM9}`, `own:${createHash("sha256").update(`nimbus-erased:${listM9}:${buyerM9}`).digest("hex").slice(0, 32)}`]), redis.run(["HEXISTS", `nl:erased:${listM9}`, createHash("sha256").update(`nimbus-erased:${listM9}:${buyerM9}`).digest("hex").slice(0, 32)])], [0, 0]);

  part("M: a refund whose deletion note does not read exactly is told without the address");
  startOfNextDay();
  resendMode = "up";
  const buyerM10 = "odd-note-refund@example.com";
  const m10 = await pay(31, buyerM10);
  refundedCaptures.add(`4D679366HH9087${m10.slice(-2)}`);
  redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "0", m10]);
  const undoM10 = after((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:") && String(c[2]).startsWith("own:"), () => ["soon"]);
  await sweep(6 / 60);
  undoM10();
  is("the refund is told, its buyer's address left out", (await refundOf(m10))?.buyer, { email: null, name: null });

  part("N: the person's own deletion completes between a try's purchase write and its later writes: the course and the affiliate bond it wrote are taken back");
  startOfNextDay();
  resendMode = "up";
  let courseN = emptyCourse();
  const lessonN = editCourse(courseN, { op: "lesson-add", moduleId: courseN.modules[0].id, title: "One" });
  if (!lessonN.ok) throw new Error("no lesson");
  courseN = lessonN.course;
  await saveCourse(courseN, ROOM);
  const addedN = await addProduct("owner@example.com", "Bread Course", "", "49", null);
  if (!addedN.ok) throw new Error("no course product");
  const setN = await setProductCourse("owner@example.com", addedN.product.id, { id: courseN.id, lessons: 1 });
  if (!setN.ok) throw new Error("not a course");
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true });
  const AFF_N = "0a1b2c3d4e5f";
  const OTHER_AFF = "9f8e7d6c5b4a";
  for (const id of [AFF_N, OTHER_AFF]) {
    redis.run(["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]);
  }
  const bondKeyN = `nl:aff:${statsId}:bond`;
  const bondOf = (buyer: string) => createHash("sha256").update(`nimbus-aff-bond:${statsId}:${buyer}`).digest("hex").slice(0, 32);
  const ledgerOf = async (buyer: string) => `nl:learn:enr:${storeKey(await fresh())}:${emailKey(buyer)}`;
  const courseListing: Listing = (await readListing(await fresh(), addedN.product.id))!;
  /** Pays for the course through the return route, with the affiliate's visit; `during` runs while the pipeline sent right after the purchase write is held. */
  const payCourse = async (n: number, buyer: string, during?: () => Promise<void>): Promise<string> => {
    buyerFor = buyer;
    const opened = await openOrder(await fresh(), courseListing, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, via: { aff: AFF_N, rate: 30 } });
    if (!opened.ok) throw new Error(opened.reason);
    const pipeline = redis.pipeline.bind(redis);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let wrote = false;
    let held = false;
    if (during) {
      redis.pipeline = (async (commands: (string | number)[][]) => {
        if (held) return pipeline(commands);
        if (!wrote) {
          if (commands.some(writesPurchase)) wrote = true;
          return pipeline(commands);
        }
        held = true;
        entered();
        await released;
        return pipeline(commands);
      }) as typeof redis.pipeline;
    }
    const paying = paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${n}` } }));
    if (during) {
      await reached;
      await during();
      release();
    }
    await paying;
    redis.pipeline = pipeline;
    return opened.order;
  };

  const buyerN0 = "course-bond-control@example.com";
  const n0 = await payCourse(40, buyerN0);
  is("control: with no deletion, the try writes the purchase, the course and the bond", [purchasesOf(buyerN0), redis.run(["HEXISTS", await ledgerOf(buyerN0), addedN.product.id]), redis.run(["HGET", bondKeyN, bondOf(buyerN0)])], [1, 1, AFF_N]);
  is("control: and leaves the list", (await listed()).includes(n0), false);

  const buyerN1 = "erased-after-purchase-write@example.com";
  const n1 = await payCourse(41, buyerN1, async () => {
    const erased = await erasePerson(await fresh(), buyerN1, { kind: "person" });
    is("the deletion completes while the try is held after its purchase write", erased.ok, true);
    is("control: the deletion took the purchase that try wrote", purchasesOf(buyerN1), 0);
  });
  is("nothing was sent to them", copies(buyerN1).length, 0);
  is("the order leaves the list in that try", (await listed()).includes(n1), false);
  is("the purchase stays taken", purchasesOf(buyerN1), 0);
  is("the course that try wrote after the deletion is taken back", redis.run(["HEXISTS", await ledgerOf(buyerN1), addedN.product.id]), 0);
  is("the affiliate bond that try wrote after the deletion is taken back", redis.run(["HEXISTS", bondKeyN, bondOf(buyerN1)]), 0);
  await sweeps(2);
  is("later sweeps leave nothing of them", [purchasesOf(buyerN1), redis.run(["HEXISTS", await ledgerOf(buyerN1), addedN.product.id]), redis.run(["HEXISTS", bondKeyN, bondOf(buyerN1)]), copies(buyerN1).length], [0, 0, 0, 0]);

  part("N: a course and a bond written after the deletion by a later order are kept by the take-back");
  startOfNextDay();
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true, rule: "first" });
  const buyerN2 = "erased-then-later-order@example.com";
  const laterStart = String(Math.floor(Date.now() / 1000) + 3_600);
  const n2 = await payCourse(42, buyerN2, async () => {
    const erased = await erasePerson(await fresh(), buyerN2, { kind: "person" });
    is("the deletion completes while the try is held after its purchase write", erased.ok, true);
    // What a later order of theirs writes, by another affiliate, with its own start.
    redis.run(["HSET", await ledgerOf(buyerN2), addedN.product.id, laterStart]);
    redis.run(["HSET", bondKeyN, bondOf(buyerN2), OTHER_AFF]);
  });
  is("the order leaves the list in that try", (await listed()).includes(n2), false);
  is("the later order's course is kept, with its own start", redis.run(["HGET", await ledgerOf(buyerN2), addedN.product.id]), laterStart);
  is("the later order's bond to another affiliate is kept", redis.run(["HGET", bondKeyN, bondOf(buyerN2)]), OTHER_AFF);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30 });

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
