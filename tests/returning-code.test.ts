/**
 * A discount code only for people who already bought from this store
 * (554 [DS1], unit 2; lib/returning-code-rules.ts, lib/returning-code.ts),
 * as rebuilt after the independent review of #3666 (11 November 2026).
 *
 * What must hold:
 *   - the store keeps such codes only in their exact shape;
 *   - a typed code and email never open a checkout: they answer "sent", the
 *     same whether or not the address bought here, so the page never tells
 *     who is a customer; only an address that PAID for an order here (paid,
 *     more than nothing, a one-time charge not refunded nor disputed) is
 *     emailed a link; a free trial, a $0 order, a refunded order, or a list
 *     that cannot be read, sends nothing;
 *   - only that link opens the checkout with the coupon, for that address,
 *     once, on that product; a used, unknown or other product's link, or a
 *     code stopped since, is refused;
 *   - a code that cannot go on the checkout (another discount applies, a
 *     gift) is refused with "other", never dropped silently; a coupon
 *     Stripe will not take any more is "code"; a Stripe refusal that does
 *     not name the coupon is not taken for one;
 *   - nothing is read from Stripe for a code the store does not have or an
 *     address that is not one; tries are limited; a form with no code
 *     works as before.
 *
 * Stripe and the email provider are played by a stand-in for `fetch`; synthetic data only.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setProductLink, setReturningCodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { ReturningCodeRefused, createCheckout } from "@/lib/store-checkout";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { parseReturningCodes, readLinkToken, readRefusal, readTypedCode, returningCodeFor, returningCodeOffered, type ReturningCode } from "@/lib/returning-code-rules";
import { RETURNING_TRIES, paidHere, sendReturningLink } from "@/lib/returning-code";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_returning_code_only";
process.env.RESEND_API_KEY = "re_test_returning_code_only";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const OWNER = "returning.owner@example.com";
const PAST = "past.buyer@example.com";
const NEW = "new.buyer@example.com";
const TRIAL = "trial.only@example.com";
const REFUNDED = "refunded.buyer@example.com";
const FREE = "free.order@example.com";
let pastProduct = "";

type Sessions = "documented" | "more" | "garbled";
let sessionsAnswer: Sessions = "documented";
let refusal: "none" | "coupon" | "consent" = "none";
const opened: URLSearchParams[] = [];
const mails: string[] = [];
let reads = 0;

const charge = (extra: Record<string, unknown> = {}) => ({ id: "ch_ReturnPast001", object: "charge", refunded: false, amount_refunded: 0, disputed: false, ...extra });
const session = (extra: Record<string, unknown> = {}) => ({
  id: "cs_test_returningearlier1", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 900, customer: null,
  metadata: { store: "returnshop", product: pastProduct },
  payment_intent: { id: "pi_ReturnPast0001", object: "payment_intent", status: "succeeded", latest_charge: charge() },
  ...extra,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(String(init?.body ?? ""));
    return answer({ id: `00000000-0000-4000-8000-${String(mails.length).padStart(12, "0")}` });
  }
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    if (refusal === "coupon" && body.has("discounts[0][coupon]")) return answer({ error: { type: "invalid_request_error", message: `Coupon ${body.get("discounts[0][coupon]")} has reached its max redemptions.` } }, 400);
    if (refusal === "consent") return answer({ error: { type: "invalid_request_error", message: "You cannot collect consent to promotional emails on this account." } }, 400);
    opened.push(body);
    return answer({ id: `cs_test_${"r".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    reads += 1;
    const email = url.searchParams.get("customer_details[email]");
    if (sessionsAnswer === "garbled" && email === PAST) return answer({ object: "list", data: [{ ...session(), status: 1 }], has_more: false });
    const rows =
      email === PAST ? [session()]
      : email === TRIAL ? [session({ mode: "subscription", payment_status: "no_payment_required", amount_total: 0, payment_intent: null })]
      : email === REFUNDED ? [session({ payment_intent: { id: "pi_ReturnRefund01", object: "payment_intent", status: "succeeded", latest_charge: charge({ refunded: true, amount_refunded: 900 }) } })]
      : email === FREE ? [session({ amount_total: 0, payment_status: "no_payment_required", payment_intent: null })]
      : [];
    return answer({ object: "list", data: rows, has_more: sessionsAnswer === "more" && email === PAST });
  }
  if (path === "/promotion_codes" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const VIP: ReturningCode = { code: "THANKYOU", coupon: "cpn_ReturnThanks01", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 };
const ENDED: ReturningCode = { code: "OLDTHANKS", coupon: "cpn_ReturnOld0001", off: { kind: "amount", cents: 500, currency: "usd" }, endsAt: 1_790_000_100, createdAt: 1_790_000_000 };

/** Every link written: the route's after-answer work writes one only for an address that paid here. */
let linkWrites = 0;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) if (command[0] === "SET" && String(command[1]).startsWith("nl:rcode:link:")) linkWrites += 1;
  return realPipeline(commands);
}) as typeof redis.pipeline;

/** The email the link would go in, captured instead of sent (the provider is not reachable from tests). */
const captured: { to: string; text: string }[] = [];
const capture = (async (message: { to: unknown; text: string }) => {
  captured.push({ to: String(message.to), text: message.text });
  return true;
}) as unknown as Parameters<typeof sendReturningLink>[6];
async function linkFor(email: string, id: string): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, id))!;
  await sendReturningLink(store, id, product.title, store.returningCodes[0], email, "https://marktmorgen.com", capture);
  return /rtoken=([a-f0-9]{64})/.exec(captured.at(-1)?.text ?? "")?.[1] ?? "";
}

async function runAfter(): Promise<void> {
  while (afterTasks.length) {
    const task = afterTasks.shift();
    if (typeof task === "function") await task();
  }
}

async function main(): Promise<void> {
  part("The store keeps a code only in its exact shape");
  is("a code as made is kept", parseReturningCodes([VIP]), [VIP]);
  is("anything else is dropped, never applied", parseReturningCodes([{ ...VIP, code: "thank you" }, { ...VIP, coupon: "" }, { ...VIP, off: { kind: "percent", percent: 0 } }, { ...VIP, off: { kind: "amount", cents: 500, currency: "USD" } }, { ...VIP, endsAt: "soon" }, { ...VIP, createdAt: undefined }, "THANKYOU", null]), []);
  is("the same word twice keeps the first", parseReturningCodes([VIP, { ...VIP, coupon: "cpn_Other00001" }]).map((c) => c.coupon), [VIP.coupon]);
  is("a typed code is made the shape codes have", [readTypedCode(" thankyou "), readTypedCode("<b>")], ["THANKYOU", ""]);
  is("a code that ended is not found", [returningCodeFor([VIP, ENDED], "oldthanks", 1_790_000_100), returningCodeFor([VIP, ENDED], "oldthanks", 1_790_000_099)?.code], [null, "OLDTHANKS"]);
  is("only the known statuses are read back from an address; 'bought' is not one", [readRefusal("sent"), readRefusal("link"), readRefusal("bought"), readRefusal(null)], ["sent", "link", null, null]);
  is("a link token is 64 hex characters or nothing", [readLinkToken("a".repeat(64)), readLinkToken("A".repeat(64)), readLinkToken("a".repeat(63))], ["a".repeat(64), "", ""]);
  is("offered only by a store that can sell, with a code still running, on a price the creator set", [returningCodeOffered({ returningCodes: [VIP], stripeAccountId: "acct_x" }, {}, 1), returningCodeOffered({ returningCodes: [VIP], stripeAccountId: "acct_x" }, { pwyw: {} }, 1), returningCodeOffered({ returningCodes: [ENDED], stripeAccountId: "acct_x" }, {}, 1_790_000_100)], [true, false, false]);

  redis.clear();
  await claimHandle(OWNER, "returnshop", "Return Shop", "Synthetic store.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReturn01", true);
  await setSubscription(OWNER, { customerId: "cus_Return000001", subscriptionId: "sub_Return000001", active: true, tier: "creator", period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const make = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(title);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  pastProduct = await make("Starter pack", "9");
  const productId = await make("Recipe pack", "27");
  const otherId = await make("Bread course", "49");
  await setReturningCodes(OWNER, [VIP, ENDED]);
  let store = (await storeForEmail(OWNER))!;
  is("the store keeps its codes through a save and a load", store.returningCodes, [VIP, ENDED]);

  part("Paid here, read strictly");
  is("a paid order: yes", await paidHere(store, PAST), true);
  is("a free trial, a $0 order, a refunded order, or nothing: no", [await paidHere(store, TRIAL), await paidHere(store, FREE), await paidHere(store, REFUNDED), await paidHere(store, NEW)], [false, false, false, false]);
  sessionsAnswer = "more";
  is("a paid order is enough even on a page with more", await paidHere(store, PAST), true);
  sessionsAnswer = "garbled";
  is("nothing readable found in a garbled list: unknown", await paidHere(store, PAST), null);
  sessionsAnswer = "documented";

  part("The checkout itself, for a code the link confirmed");
  const product = (await readProduct(store, productId))!;
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { returning: VIP, email: PAST, digitalConsent: TEST_CONSENT });
  const sent = opened.at(-1)!;
  is("the coupon, for that email, with no box beside it", [sent.get("discounts[0][coupon]"), sent.get("customer_email"), sent.get("allow_promotion_codes"), sent.get("metadata[returning]")], [VIP.coupon, PAST, null, "THANKYOU"]);
  const refusedWith = async (extras: Parameters<typeof createCheckout>[4]) => createCheckout(store, product, "https://marktmorgen.com", undefined, extras).then(() => "opened", (error) => (error instanceof ReturningCodeRefused ? error.reason : String(error)));
  is("another discount already applies (a come-back offer): refused as 'other', never dropped", await refusedWith({ returning: VIP, email: PAST, coupon: "cpn_Winback0001", digitalConsent: TEST_CONSENT }), "other");
  refusal = "coupon";
  is("a coupon Stripe will not take any more: 'code'", await refusedWith({ returning: VIP, email: PAST, digitalConsent: TEST_CONSENT }), "code");
  refusal = "consent";
  is("a Stripe refusal that does not name the coupon is not taken for one", (await refusedWith({ returning: VIP, email: PAST, digitalConsent: TEST_CONSENT })) === "code", false);
  refusal = "none";

  const post = async (fields: Record<string, string>, ip: string) => {
    const before = opened.length;
    const readsBefore = reads;
    const f = new FormData();
    f.set("handle", "returnshop");
    f.set("product", fields.product ?? productId);
    for (const [k, v] of Object.entries(fields)) if (k !== "product") f.set(k, v);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", "x-forwarded-for": ip } }));
    const raw = response.headers.get("location") ?? "";
    // The typed code rides back in the address for the field (checked below); compared without it.
    if (fields.rcode) is(`the typed code goes back with the answer (${fields.rcode})`, raw.includes(`&rc=${fields.rcode.trim().toUpperCase()}#`) || !raw.includes("?returning="), true);
    const location = raw.replace(/&rc=[A-Z0-9-]+#/, "#");
    const writesBefore = linkWrites;
    await runAfter();
    return { location, session: opened.length > before ? opened.at(-1)! : null, reads: reads - readsBefore, link: linkWrites > writesBefore };
  };
  const back = (status: string, id = productId) => `https://marktmorgen.com/@returnshop/p/${id}?returning=${status}#returning`;

  part("Typed by someone who paid here before: 'sent', no checkout, and a link to that address only");
  let r = await post({ rcode: "thankyou", remail: " Past.Buyer@Example.com " }, "198.51.100.7");
  is("back to the field: sent", r.location, back("sent"));
  is("no checkout opens from typing", r.session, null);
  is("a link is written for that address", r.link, true);
  const token = await linkFor(PAST, productId);
  is("its email: to that address, with a link for this product that works once, in plain words", [captured.at(-1)?.to, captured.at(-1)?.text.includes(`https://marktmorgen.com/@returnshop/p/${productId}?rtoken=`), captured.at(-1)?.text.includes("The link works once, for 30 minutes.")], [PAST, true, true]);
  const before = captured.length;
  for (const who of [NEW, TRIAL, REFUNDED, FREE]) await linkFor(who, productId);
  is("an address that did not pay here is never emailed", captured.length, before);

  part("Asking for the link is not buying: the box to start access at once is not needed for it");
  const bare = new FormData();
  bare.set("handle", "returnshop");
  bare.set("product", productId);
  bare.set("rcode", "THANKYOU");
  bare.set("remail", PAST);
  const asked = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: bare, headers: { host: "marktmorgen.com", "x-forwarded-for": "198.51.100.50" } }));
  await runAfter();
  is("'sent', not sent back for the consent box", asked.headers.get("location"), back("sent").replace("#", "&rc=THANKYOU#"));

  part("Typed with an address that did not pay here: the same answer, and nothing sent");
  for (const [who, ip] of [[NEW, "198.51.100.8"], [TRIAL, "198.51.100.9"], [REFUNDED, "198.51.100.10"], [FREE, "198.51.100.11"]] as const) {
    r = await post({ rcode: "THANKYOU", remail: who }, ip);
    is(`${who}: 'sent', no checkout, no link`, [r.location, r.session, r.link], [back("sent"), null, false]);
  }
  sessionsAnswer = "garbled";
  r = await post({ rcode: "THANKYOU", remail: PAST }, "198.51.100.12");
  is("a list that cannot be read: the same answer, no link", [r.location, r.session, r.link], [back("sent"), null, false]);
  sessionsAnswer = "documented";

  part("The link opens the checkout with the code, for that address, once");
  r = await post({ rtoken: token }, "198.51.100.13");
  is("on to Stripe", r.location, "https://checkout.stripe.com/c/pay/test");
  is("with the coupon and that address", [r.session?.get("discounts[0][coupon]"), r.session?.get("customer_email")], [VIP.coupon, PAST]);
  r = await post({ rtoken: token }, "198.51.100.14");
  is("a second use: 'link', no checkout", [r.location, r.session], [back("link"), null]);
  r = await post({ rtoken: "f".repeat(64) }, "198.51.100.15");
  is("a link nobody was sent: 'link'", [r.location, r.session], [back("link"), null]);

  part("A link is for its product, and for a code still running");
  const second = await linkFor(PAST, productId);
  r = await post({ rtoken: second, product: otherId }, "198.51.100.17");
  is("on another product: 'link'", [r.location, r.session], [back("link", otherId), null]);
  const third = await linkFor(PAST, productId);
  await setReturningCodes(OWNER, [ENDED]);
  r = await post({ rtoken: third }, "198.51.100.19");
  is("the code stopped since: 'code'", [r.location, r.session], [back("code"), null]);
  await setReturningCodes(OWNER, [VIP, ENDED]);
  store = (await storeForEmail(OWNER))!;

  part("A code the store does not have, or an address that is not one: nothing read");
  r = await post({ rcode: "NOPE", remail: PAST }, "198.51.100.20");
  is("'code', with no purchases read", [r.location, r.session, r.reads, r.link], [back("code"), null, 0, false]);
  r = await post({ rcode: "THANKYOU", remail: "not-an-address" }, "198.51.100.21");
  is("'email', with no purchases read", [r.location, r.session, r.reads], [back("email"), null, 0]);

  part("Not on a gift");
  r = await post({ rcode: "THANKYOU", remail: PAST, gift_to: "friend@example.com" }, "198.51.100.22");
  is("'other', before the gift is written down", [r.location, r.session], [back("other"), null]);

  part("Too many tries");
  let last = "";
  for (let i = 0; i <= RETURNING_TRIES; i += 1) last = (await post({ rcode: "NOPE", remail: PAST }, "198.51.100.23")).location;
  is("from one connection: the try after the limit is told to wait", last, back("busy"));
  let perAddress = "";
  for (let i = 0; i < 4; i += 1) perAddress = (await post({ rcode: "THANKYOU", remail: NEW }, `198.51.100.${30 + i}`)).location;
  is("for one address, whatever the connection: a few links an hour", perAddress, back("busy"));
  is("the email is never in an address", /past\.buyer|new\.buyer|%40/i.test(last + perAddress), false);

  part("A buy form with no code works as before");
  r = await post({}, "198.51.100.40");
  is("on to Stripe, with the box and no coupon, nothing read", [r.location, r.session?.get("allow_promotion_codes"), r.session?.get("discounts[0][coupon]"), r.reads], ["https://checkout.stripe.com/c/pay/test", "true", null, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
