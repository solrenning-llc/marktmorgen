/**
 * A discount code only for people who already bought from this store
 * (554 [DS1], unit 2; lib/returning-code-rules.ts, lib/returning-code.ts).
 *
 * What must hold:
 *   - the store keeps such codes only in their exact shape: anything else is
 *     dropped, never applied;
 *   - the email is proved, never typed: only the link we emailed to the
 *     buyer's library (lib/buyer-library.ts, libraryOwner) says whose it is,
 *     so nobody learns whether someone else bought here, and nobody gets
 *     the price with someone else's email (review of #3666, HIGH and MEDIUM);
 *     without that link the answer is the same whether or not the email
 *     bought, and nothing is read from Stripe;
 *   - with the link of an email that bought here before, read in full from
 *     the creator's Stripe account, the checkout opens with the creator's
 *     coupon, for that proved email only, and no code box beside it;
 *   - an email with no earlier purchase, a purchase history that cannot be
 *     read in full, a code the store does not have or that has ended, an
 *     address that is not one, or too many tries: no checkout opens, nothing
 *     is held, and the buyer is sent back to the form with the reason;
 *   - nothing is read from Stripe for a code the store does not have, and
 *     the store's month of requests is taken before the purchases are read;
 *   - a coupon Stripe will not take any more (used up, deleted) sends the
 *     buyer back with "code", never a checkout at the full price they did
 *     not ask for, and is not counted as checkout trouble;
 *   - a buy form with no code works exactly as before.
 *
 * Stripe is played by a stand-in for `fetch`; synthetic data only.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setHasDiscounts, setProductLink, setReturningCodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { parseReturningCodes, readRefusal, readTypedCode, returningCodeFor, returningCodeOffered, returningDecision, type ReturningCode } from "@/lib/returning-code-rules";
import { RETURNING_TRIES, checkReturningCode } from "@/lib/returning-code";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_returning_code_only";

const OWNER = "returning.owner@example.com";
const PAST = "past.buyer@example.com";
const NEW = "new.buyer@example.com";
let pastProduct = "";

type Sessions = "documented" | "more" | "garbled";
let sessionsAnswer: Sessions = "documented";
let refuseCoupon = false;
const opened: URLSearchParams[] = [];
const reads: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    if (refuseCoupon && body.has("discounts[0][coupon]")) {
      return answer({ error: { type: "invalid_request_error", message: "This coupon has reached its max redemptions." } }, 400);
    }
    opened.push(body);
    return answer({ id: `cs_test_${"r".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    reads.push(url.searchParams.get("customer_details[email]") ?? "");
    const email = url.searchParams.get("customer_details[email]");
    const row = { id: "cs_test_returningearlier1", object: "checkout.session", status: "complete", payment_status: "paid", customer: null, metadata: { store: "returnshop", product: pastProduct } };
    if (sessionsAnswer === "garbled") return answer({ object: "list", data: [{ ...row, status: 1 }], has_more: false });
    return answer({ object: "list", data: email === PAST ? [row] : [], has_more: sessionsAnswer === "more" });
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (path === "/promotion_codes" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const VIP: ReturningCode = { code: "THANKYOU", coupon: "cpn_ReturnThanks01", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 };
const ENDED: ReturningCode = { code: "OLDTHANKS", coupon: "cpn_ReturnOld0001", off: { kind: "amount", cents: 500, currency: "usd" }, endsAt: 1_790_000_100, createdAt: 1_790_000_000 };

/** A buyer's library link, as requestLibraryLink keeps it (lib/buyer-library.ts): the proof that an email is theirs. */
const proofFor = async (email: string, token: string) => {
  const key = `nl:lib:link:${createHash("sha256").update(`nimbus-lib-link:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", key, email, "EX", 600]]);
  return token;
};

async function main(): Promise<void> {
  part("The store keeps a code only in its exact shape");
  is("a code as made is kept", parseReturningCodes([VIP]), [VIP]);
  is("anything else is dropped, never applied", parseReturningCodes([
    { ...VIP, code: "thank you" },
    { ...VIP, coupon: "" },
    { ...VIP, off: { kind: "percent", percent: 0 } },
    { ...VIP, off: { kind: "percent", percent: 101 } },
    { ...VIP, off: { kind: "amount", cents: 1.5, currency: "usd" } },
    { ...VIP, off: { kind: "amount", cents: 500, currency: "USD" } },
    { ...VIP, endsAt: "soon" },
    { ...VIP, createdAt: undefined },
    "THANKYOU",
    null,
  ]), []);
  is("not a list reads as none", [parseReturningCodes(undefined), parseReturningCodes({ code: "THANKYOU" })], [[], []]);
  is("the same word twice keeps the first", parseReturningCodes([VIP, { ...VIP, coupon: "cpn_Other00001" }]).map((c) => c.coupon), [VIP.coupon]);
  is("a typed code is made the shape codes have", [readTypedCode(" thankyou "), readTypedCode("<b>"), readTypedCode(undefined)], ["THANKYOU", "", ""]);
  is("a code that ended is not found", [returningCodeFor([VIP, ENDED], "oldthanks", 1_790_000_100), returningCodeFor([VIP, ENDED], "oldthanks", 1_790_000_099)?.code], [null, "OLDTHANKS"]);
  is("the decision: unknown is never a discount", [returningDecision(VIP, null), returningDecision(VIP, new Set()), returningDecision(null, new Set(["x"])), returningDecision(VIP, new Set(["x"])).ok], [{ ok: false, reason: "unknown" }, { ok: false, reason: "bought" }, { ok: false, reason: "code" }, true]);
  is("only the five reasons are read back from an address", [readRefusal("bought"), readRefusal("open"), readRefusal(null)], ["bought", null, null]);
  is("offered only by a store that can sell, with a code still running, on a price the creator set", [
    returningCodeOffered({ returningCodes: [VIP], stripeAccountId: "acct_x" }, {}, 1),
    returningCodeOffered({ returningCodes: [VIP], stripeAccountId: null }, {}, 1),
    returningCodeOffered({ returningCodes: [VIP], stripeAccountId: "acct_x" }, { pwyw: { minCents: 100 } }, 1),
    returningCodeOffered({ returningCodes: [ENDED], stripeAccountId: "acct_x" }, {}, 1_790_000_100),
    returningCodeOffered({ returningCodes: [], stripeAccountId: "acct_x" }, {}, 1),
  ], [true, false, false, false, false]);

  redis.clear();
  await claimHandle(OWNER, "returnshop", "Return Shop", "Synthetic store.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReturn00001", true);
  await setSubscription(OWNER, { customerId: "cus_Return000001", subscriptionId: "sub_Return000001", active: true, period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const make = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(title);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  pastProduct = await make("Starter pack", "9");
  const productId = await make("Recipe pack", "27");

  part("A store keeps its codes through a save and a load");
  await setReturningCodes(OWNER, [VIP, ENDED, { ...VIP, code: "bad code" } as ReturningCode]);
  let store = (await storeForEmail(OWNER))!;
  is("both codes as made, the garbled one dropped", store.returningCodes, [VIP, ENDED]);

  part("The checkout itself: the coupon, for that email only, with no box beside it");
  const product = (await readProduct(store, productId))!;
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { returning: VIP, email: PAST, digitalConsent: TEST_CONSENT });
  const sent = opened.at(-1)!;
  is("the creator's coupon comes off", sent.get("discounts[0][coupon]"), VIP.coupon);
  is("no code box beside it", sent.get("allow_promotion_codes"), null);
  is("the checkout opens for the email that bought before", sent.get("customer_email"), PAST);
  is("the order says which code it was", sent.get("metadata[returning]"), "THANKYOU");

  const post = async (fields: Record<string, string>, ip = "198.51.100.7") => {
    const before = opened.length;
    const readsBefore = reads.length;
    const f = new FormData();
    f.set("handle", "returnshop");
    f.set("product", productId);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", "x-forwarded-for": ip } }));
    return { location: response.headers.get("location") ?? "", session: opened.length > before ? opened.at(-1)! : null, reads: reads.length - readsBefore };
  };
  const back = (reason: string) => `https://marktmorgen.com/@returnshop/p/${productId}?returning=${reason}#returning`;

  const PAST_PROOF = await proofFor(PAST, "a".repeat(64));
  const NEW_PROOF = await proofFor(NEW, "b".repeat(64));

  part("An email typed without the link we sent it: the same answer whether or not it bought, nothing read (review of #3666, HIGH)");
  {
    const past = await post({ rcode: "THANKYOU", remail: PAST }, "198.51.100.20");
    const never = await post({ rcode: "THANKYOU", remail: NEW }, "198.51.100.21");
    is("a past buyer's typed email: back to the form for the link, no checkout, nothing read", [past.location, past.session, past.reads], [back("proof"), null, 0]);
    is("an email that never bought: the very same answer", [never.location, never.session, never.reads], [back("proof"), null, 0]);
    const fake = await post({ rcode: "THANKYOU", rproof: "c".repeat(64) }, "198.51.100.22");
    is("a link we never sent, or one that ended: the same, nothing read", [fake.location, fake.session, fake.reads], [back("proof"), null, 0]);
    const garbled = await post({ rcode: "THANKYOU", rproof: "not-a-link" }, "198.51.100.23");
    is("something that is not a link at all: the same", [garbled.location, garbled.reads], [back("proof"), 0]);
  }

  part("Someone else's email beside your own link: only the link's email counts (review of #3666, MEDIUM)");
  let r = await post({ rcode: "THANKYOU", remail: PAST, rproof: NEW_PROOF }, "198.51.100.24");
  is("the link is for an email that never bought: no price, whatever email is typed beside it", [r.location, r.session], [back("bought"), null]);
  is("and only the link's own email is read, never the typed one", reads.slice(-1), [NEW]);

  part("The link of someone who bought here before");
  r = await post({ rcode: "thankyou", rproof: PAST_PROOF });
  is("on to Stripe", r.location, "https://checkout.stripe.com/c/pay/test");
  is("with the coupon and the proved email", [r.session?.get("discounts[0][coupon]"), r.session?.get("customer_email"), r.session?.get("allow_promotion_codes")], [VIP.coupon, PAST, null]);

  part("What the email bought cannot be read in full");
  for (const as of ["more", "garbled"] as const) {
    sessionsAnswer = as;
    r = await post({ rcode: "THANKYOU", rproof: PAST_PROOF }, `198.51.100.${as === "more" ? 9 : 10}`);
    is(`a list ${as === "more" ? "with more pages than are read" : "with a garbled row"}: unknown, back to the form`, [r.location, r.session], [back("unknown"), null]);
  }
  sessionsAnswer = "documented";

  part("A code the store does not have, or one that ended: nothing is read from Stripe");
  r = await post({ rcode: "NOPE", rproof: PAST_PROOF }, "198.51.100.11");
  is("refused as a code, with no purchases read", [r.location, r.session, r.reads], [back("code"), null, 0]);
  store = (await storeForEmail(OWNER))!;
  const ended = await checkReturningCode(store, "OLDTHANKS", PAST_PROOF, 1_790_000_100_000);
  is("an ended code is a code that is not one", ended, { ok: false, reason: "code" });

  part("A link whose answer cannot be read: unknown, never a discount");
  const realPipeline = redis.pipeline;
  redis.pipeline = async (commands) => (commands.some((c) => String(c[1]).startsWith("nl:lib:link:")) ? [{ garbled: true }] : realPipeline.call(redis, commands));
  try {
    r = await post({ rcode: "THANKYOU", rproof: PAST_PROOF }, "198.51.100.12");
  } finally {
    redis.pipeline = realPipeline;
  }
  is("back to the form as unknown, no checkout, nothing read", [r.location, r.session, r.reads], [back("unknown"), null, 0]);

  part("Too many tries from one connection");
  let last = "";
  for (let i = 0; i <= RETURNING_TRIES; i += 1) last = (await post({ rcode: "NOPE", rproof: PAST_PROOF }, "198.51.100.13")).location;
  is("the try after the limit is told to wait", last, back("busy"));

  part("A coupon Stripe will not take any more");
  refuseCoupon = true;
  r = await post({ rcode: "THANKYOU", rproof: PAST_PROOF }, "198.51.100.14");
  is("back to the form as a code, never a checkout at the full price", [r.location, r.session], [back("code"), null]);
  refuseCoupon = false;

  part("A buy form with no code works as before");
  r = await post({}, "198.51.100.15");
  is("on to Stripe, with the box and no coupon, nothing read", [r.location, r.session?.get("allow_promotion_codes"), r.session?.get("discounts[0][coupon]"), r.reads], ["https://checkout.stripe.com/c/pay/test", "true", null, 0]);
  r = await post({ rcode: "", remail: PAST, rproof: PAST_PROOF }, "198.51.100.16");
  is("an email or a link with no code is not a code", [r.location, r.session?.get("customer_email"), r.reads], ["https://checkout.stripe.com/c/pay/test", null, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
