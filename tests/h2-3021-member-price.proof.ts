/** Independent H2 review of #3021/b6055d98. Actual render/proof/checkout
 * code and MemoryRedis; Stripe responses and billing period are synthetic.
 * These assertions compare two real consumers; they do not charge anybody. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuyBox } from "@/components/store-product";
import { memberPriceCanShow, memberShown, MemberPriceNote } from "@/components/member-price";
import { MEMBER_PERCENT_CHOICES } from "@/lib/member-price-rules";
import { memberClaim, memberPriceFor } from "@/lib/member-price";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { mintPass, passCookieName } from "@/lib/learn";
import { createCheckout } from "@/lib/store-checkout";
import { activeBumps, activePlan } from "@/lib/product-extras";
import { picks } from "@/lib/bundle-rules";
import { speech } from "@/lib/buyer-words";
import { store as redis } from "./redis-stub";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "h2-owner@example.test", MEMBER = "h2-member@example.test", HANDLE = "h2memberproof";
let checks = 0, http = 0, clubId = "", mode: "active" | "unread" | "canceled" = "active";
const check = (name: string, got: unknown, want: unknown) => {
  if (++checks > 1000) throw new Error("assertion ceiling");
  is(name, got, want);
};
const checkouts: URLSearchParams[] = [];
const couponPercent = new Map<string, number>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (++http > 200) throw new Error("synthetic HTTP ceiling");
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error("unexpected provider");
  const path = url.pathname.replace(/^\/v1/, ""), method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/checkout/sessions" && method === "GET") {
    if (mode === "unread") return answer({ object: "list", data: "unknown", has_more: false });
    return answer({ object: "list", has_more: false, data: [{
      id: "cs_test_h2member000001", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
      metadata: { store: HANDLE, product: clubId },
      subscription: { id: "sub_H2Member00001", object: "subscription", status: mode, metadata: { store: HANDLE, product: clubId }, items: { data: [] } },
    }] });
  }
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body)), id = body.get("id")!;
    couponPercent.set(id, Number(body.get("percent_off")));
    return answer({ id, object: "coupon", valid: true, percent_off: couponPercent.get(id), duration: "once" });
  }
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ object: "checkout.session", id: "cs_test_h2created000001", url: "https://checkout.stripe.com/c/pay/synthetic" });
  }
  throw new Error(`unmodeled synthetic request: ${method} ${path}`);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_h2_member_page_only";
  await claimHandle(OWNER, HANDLE, "Synthetic H2", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_H2MemberProof01", true);
  await setSubscription(OWNER, { customerId: "cus_H2Owner00001", subscriptionId: "sub_H2Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  const guide = await addProduct(OWNER, "Guide", "", "27", null);
  const extra = await addProduct(OWNER, "Extra", "", "5", null);
  if (!club.ok || !guide.ok || !extra.ok) throw new Error("fixture products were not created");
  clubId = club.product.id;
  await setProductLink(OWNER, guide.product.id, "https://example.test/guide");
  await setProductLink(OWNER, extra.product.id, "https://example.test/extra");
  await setMemberPrices(OWNER, { on: true, rules: [{ id: "h2", percent: 20, by: [clubId], all: true, products: [] }] });
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, guide.product.id))!, addon = (await readListing(store, extra.product.id))!;
  const jar = { get: (name: string) => name === passCookieName(store) ? { value: token } : undefined };
  const token = await mintPass(store, MEMBER, "all");
  const place = { selling: true, soon: false, remaining: null, ready: true, related: [] as Listing[] };

  part("Behavioral eligibility, including active fixtures rather than source-string checks");
  check("plain one-off is eligible", memberPriceCanShow(store, product, place), true);
  const planned: Listing = { ...product, plan: { payments: 3, interval: "month", amountCents: 900 } };
  check("the payment-plan fixture is active", activePlan(planned) !== null, true);
  check("an active payment plan is excluded", memberPriceCanShow(store, planned, place), false);
  const bumped: Listing = { ...product, bumps: [{ productId: addon.id, priceCents: 100, pitch: "Extra" }] };
  check("the bump fixture is active", activeBumps([addon], bumped).length, 1);
  check("an active bump is excluded", memberPriceCanShow(store, bumped, { ...place, related: [addon] }), false);
  const picked: Listing = { ...product, bundle: [clubId, addon.id, product.id], pick: 2 };
  check("the pick fixture is active", picks(picked), 2);
  check("a pick-your-own bundle is excluded", memberPriceCanShow(store, picked, place), false);
  for (const [label, position] of [["not selling", { ...place, selling: false }], ["coming soon", { ...place, soon: true }], ["sold out", { ...place, remaining: 0 }], ["not ready", { ...place, ready: false }]] as const) {
    check(label, memberPriceCanShow(store, product, position), false);
  }

  part("All 18 member levels across no sale, larger sale, and fair-price competition");
  const now = Math.floor(Date.now() / 1000), money = speech(store).money;
  for (const percent of MEMBER_PERCENT_CHOICES) for (const [sale, fair] of [[0, 0], [40, 0], [10, 30]]) {
    const s: Store = { ...store,
      visitorCountry: "BR",
      memberPrices: { on: true, rules: [{ id: "h2", percent, by: [clubId], all: true, products: [] }] },
      sale: { name: "Synthetic sale", coupon: `h2_sale_${sale}`, percent: sale, starts: now - 60, ends: now + 3600, all: true, products: [] },
      fair: { on: fair > 0, auto: false, maxOff: 50, levels: { BR: fair }, all: true, products: [] },
    };
    if (sale) couponPercent.set(s.sale.coupon, sale);
    const proof = await memberPriceFor(s, product, jar);
    const shown = memberShown(s, product, proof);
    const html = renderToStaticMarkup(createElement(BuyBox, { store: s, product, related: [], remaining: null, writes: false, selling: true, member: shown }));
    const best = Math.max(percent, sale, fair), cents = product.priceCents - Math.round(product.priceCents * best / 100);
    check(`${percent}/${sale}/${fair}: actual button names the best amount`, html.includes(`Buy for ${money(cents)}`), true);
    checkouts.length = 0;
    await createCheckout(s, product, "https://example.test", "", { digitalConsent: TEST_CONSENT, country: "BR", ...(shown ? { member: { percent: shown, email: MEMBER } } : {}) });
    const sent = checkouts[0];
    check(`${percent}/${sale}/${fair}: actual checkout selects that discount`, couponPercent.get(sent?.get("discounts[0][coupon]") ?? ""), best);
    check(`${percent}/${sale}/${fair}: the proved address stays server-side`, [html.includes(MEMBER), sent?.get("customer_email")], [false, shown ? MEMBER : null]);
  }

  part("Half-cent discount rounding is checked independently of the shared price helper");
  const pennyMade = await addProduct(OWNER, "Rounding edge", "", "27.01", null);
  if (!pennyMade.ok) throw new Error("rounding fixture was not created");
  await setProductLink(OWNER, pennyMade.product.id, "https://example.test/rounding");
  const pennyStore = (await storeForEmail(OWNER))!;
  const penny = (await readProduct(pennyStore, pennyMade.product.id))!;
  const half: Store = { ...pennyStore, memberPrices: { on: true, rules: [{ id: "h2", percent: 50, by: [clubId], all: true, products: [] }] } };
  const halfProof = await memberPriceFor(half, penny, jar), halfShown = memberShown(half, penny, halfProof);
  const halfHtml = renderToStaticMarkup(createElement(BuyBox, { store: half, product: penny, related: [], remaining: null, writes: false, selling: true, member: halfShown }));
  check("a 2701-cent price with 50% off displays 1350 cents", halfHtml.includes(`Buy for ${money(1350)}`), true);
  checkouts.length = 0;
  await createCheckout(half, penny, "https://example.test", "", { digitalConsent: TEST_CONSENT, member: { percent: halfShown, email: MEMBER } });
  check("checkout retains the full 2701-cent basis and the matching coupon", [checkouts[0]?.get("line_items[0][price_data][unit_amount]"), couponPercent.get(checkouts[0]?.get("discounts[0][coupon]") ?? "")], ["2701", 50]);

  part("Unknown and missing admission never grant a displayed member price");
  const beforeAnonymous = http;
  check("no cookie causes no provider read", [await memberPriceFor(store, product, { get: () => undefined }), http - beforeAnonymous], [{ state: "none" }, 0]);
  const beforeDenied = http;
  check("no billing window refuses before provider IO", [await memberPriceFor({ ...store, period: null }, product, jar), http - beforeDenied], [{ state: "unknown" }, 0]);
  mode = "unread";
  const unknown = await memberPriceFor(store, product, jar);
  check("an unread provider page stays unknown", unknown, { state: "unknown" });
  check("unknown displays no member claim", memberShown(store, product, unknown), 0);
  mode = "canceled";
  check("a canceled membership cannot receive a displayed discount", memberShown(store, product, await memberPriceFor(store, product, jar)), 0);
  mode = "active";
  check("a forged percentage is refused", await memberClaim(store, product, 25, jar), { ok: false });
  const note = renderToStaticMarkup(createElement(MemberPriceNote, { store, product, percent: 20, paypal: true }));
  check("PayPal exception is explicit", note.includes("If you pay with PayPal, the member price does not apply."), true);
  console.log(JSON.stringify({ checks, http, scope: "actual backend and SSR; no live Stripe or browser" }));
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
