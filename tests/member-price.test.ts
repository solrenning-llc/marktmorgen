/**
 * Member and past-buyer prices (620 [SZ4], first unit: the rules, the proof
 * of who is a member, and the checkout).
 *
 * The creator says "whoever holds membership X (or bought Y) pays Z% less on
 * products A and B". What is checked:
 *
 *   - the setting: off on every store until switched on, read safely from
 *     anything, percentages only from the list, ids clean, sizes capped;
 *   - who is a member, from the creator's own Stripe account: an active
 *     membership counts; canceled, paused, past due or a payment plan do
 *     not; a one-off purchase counts only when paid and never refunded (in
 *     full or in part) nor disputed; another store's sale, a gift, a group
 *     place or a pre-order bought for others never counts; an answer that is
 *     not one Stripe gives proves nothing;
 *   - on the server: only an address proved the way courses are opened
 *     (the browser's pass or a signed-in session), never the creator, never
 *     another address; counted before Stripe is read, at most two calls;
 *     Stripe failing or answering garbage is "unknown", never a discount;
 *     purchases brought over from another platform count, gifts do not;
 *   - at checkout: the member price comes off by the creator's own coupon
 *     only when the page's claim equals what the server proves now; the
 *     largest of a sale, a fair price and a member price, never two; not on
 *     a payment plan, a membership, or with a come-back offer;
 *   - the report names the origin "Member price".
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_MEMBER_PRODUCTS,
  MAX_MEMBER_QUALIFYING,
  MAX_MEMBER_RULES,
  MEMBER_PERCENT_CHOICES,
  NO_MEMBER_PRICES,
  memberCouponId,
  memberOffFrom,
  memberRulesFor,
  parseMemberPrices,
  qualifyingFor,
} from "@/lib/member-price-rules";
import {
  MEMBER_PRICE_REQUEST_UNITS,
  MEMBER_PRICE_STRIPE_CALLS,
  heldFromSessions,
  memberClaim,
  memberPriceFor,
  readMemberClaim,
} from "@/lib/member-price";
import { NEXT_OFFER_CHOICES, NEXT_OFFER_PRODUCTS, NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { DISCOUNT_NAMES, discountKindOf } from "@/lib/discount-impact";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setSubscription, setStoreSale, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { mintPass, passCookieName } from "@/lib/learn";
import { importedKey } from "@/lib/imported-purchases";
import { SESSION_COOKIE, openSession } from "@/lib/auth";

process.env.STRIPE_SECRET_KEY = "sk_test_member_price_only";
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const HANDLE = "harbor";

// ------------------------------------------------------------- Stripe stand-in

const checkouts: URLSearchParams[] = [];
const coupons: URLSearchParams[] = [];
let sessionReads = 0;
/** What GET /checkout/sessions answers, by the address asked for; "fail" answers 500, "garbage" a list in another shape. */
let sessionsByEmail: Record<string, unknown[] | "fail" | "garbage"> = {};
let hasMore = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"f".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    sessionReads += 1;
    const asked = url.searchParams.get("customer_details[email]") ?? "";
    const rows = sessionsByEmail[asked] ?? [];
    if (rows === "fail") return answer({ error: { message: "down" } }, 500);
    if (rows === "garbage") return answer({ object: "list", data: "nope", has_more: false });
    return answer({ object: "list", data: rows, has_more: hasMore });
  }
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    coupons.push(body);
    return answer({ id: body.get("id"), percent_off: Number(body.get("percent_off")) });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

// ------------------------------------------------------------- Stripe rows

const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_Test000001", object: "charge", paid: true, refunded: false, amount: 2700, amount_refunded: 0, disputed: false, ...over });
const intent = (over: Record<string, unknown> = {}, chargeOver: Record<string, unknown> = {}) => ({ id: "pi_Test00000001", object: "payment_intent", status: "succeeded", latest_charge: charge(chargeOver), ...over });
let n = 0;
const oneOff = (product: string, over: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: `cs_test_oneoff${String((n += 1)).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  metadata: { store: HANDLE, product, ...meta },
  payment_intent: intent(),
  subscription: null,
  ...over,
});
const joined = (product: string, status: string, over: Record<string, unknown> = {}, subOver: Record<string, unknown> = {}) => ({
  id: `cs_test_member${String((n += 1)).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: "sub_Member000001", object: "subscription", status, metadata: { store: HANDLE, product }, items: { data: [] }, ...subOver },
  ...over,
});

const jar = (cookies: Record<string, string>) => ({ get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) });
const candidate = (over: Record<string, unknown> = {}) => ({ id: "p1", priceCents: 2700, recurring: null, call: null, pwyw: null, options: [], ...over });

async function main(): Promise<void> {
  part("The setting");
  is("off on every store, with no rules", [NO_MEMBER_PRICES.on, NO_MEMBER_PRICES.rules], [false, []]);
  is("anything else read as off", [parseMemberPrices(null), parseMemberPrices("on"), parseMemberPrices([1])], [NO_MEMBER_PRICES, NO_MEMBER_PRICES, NO_MEMBER_PRICES]);
  is("percentages are 5 to 90 in steps of five", [MEMBER_PERCENT_CHOICES[0], MEMBER_PERCENT_CHOICES.at(-1), MEMBER_PERCENT_CHOICES.length], [5, 90, 18]);
  const parsed = parseMemberPrices({
    on: true,
    rules: [
      { id: "r1", percent: 20, by: ["club", "club", "bad id"], all: false, products: ["p1", "p1", 7] },
      { id: "r2", percent: 23, by: ["club"], all: true, products: [] },
      { id: "r3", percent: 30, by: [], all: true, products: [] },
      { id: "r1", percent: 40, by: ["other"], all: true, products: [] },
    ],
  });
  is("a rule keeps clean ids once each; a percentage off the list, no qualifying product, or a second rule with the same id is dropped", parsed, {
    on: true,
    rules: [{ id: "r1", percent: 20, by: ["club"], all: false, products: ["p1"] }],
  });
  const many = parseMemberPrices({
    on: true,
    rules: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, percent: 10, by: Array.from({ length: 12 }, (_, j) => `q${i}_${j}`), all: false, products: Array.from({ length: 80 }, (_, j) => `p${j}`) })),
  });
  is("capped: rules, products per rule and qualifying products across the store", [
    many.rules.length <= MAX_MEMBER_RULES,
    many.rules.every((r) => r.products.length <= MAX_MEMBER_PRODUCTS),
    new Set(many.rules.flatMap((r) => r.by)).size <= MAX_MEMBER_QUALIFYING,
  ], [true, true, true]);

  const setting = parseMemberPrices({
    on: true,
    rules: [
      { id: "club", percent: 20, by: ["club"], all: true, products: [] },
      { id: "buyers", percent: 30, by: ["guide"], all: false, products: ["p1"] },
    ],
  });
  is("covers what a sale covers: not a membership, a call, a price the buyer names or price options", [
    memberRulesFor(setting, candidate({ recurring: { interval: "month" } })).length,
    memberRulesFor(setting, candidate({ call: {} })).length,
    memberRulesFor(setting, candidate({ pwyw: { suggestedCents: 100 } })).length,
    memberRulesFor(setting, candidate({ options: [{}] })).length,
  ], [0, 0, 0, 0]);
  is("the products each rule names", [memberRulesFor(setting, candidate()).map((r) => r.id), memberRulesFor(setting, candidate({ id: "p2" })).map((r) => r.id)], [["club", "buyers"], ["club"]]);
  is("what would qualify for this product", qualifyingFor(setting, candidate()), ["club", "guide"]);
  is("nothing held: nothing off", memberOffFrom(setting, candidate(), new Set()), 0);
  is("holding one: its rule's percentage", memberOffFrom(setting, candidate(), new Set(["club"])), 20);
  is("holding both: the larger, never the sum", memberOffFrom(setting, candidate(), new Set(["club", "guide"])), 30);
  is("switched off: nothing", memberOffFrom({ ...setting, on: false }, candidate(), new Set(["club", "guide"])), 0);
  is("the coupon on the creator's account", memberCouponId(20), "mm_member_20");

  part("Who is a member, from Stripe's rows");
  const handles = new Set([HANDLE]);
  const kinds = new Map([
    ["club", { recurring: true }],
    ["guide", { recurring: false }],
  ]);
  const held = (rows: unknown[]) => [...heldFromSessions(rows as Record<string, unknown>[], handles, kinds)];
  is("an active membership", held([joined("club", "active")]), ["club"]);
  is("canceled, unpaid, incomplete, past due or in a free trial: not proved", [
    held([joined("club", "canceled")]),
    held([joined("club", "unpaid")]),
    held([joined("club", "incomplete")]),
    held([joined("club", "past_due")]),
    held([joined("club", "trialing")]),
  ], [[], [], [], [], []]);
  const nowS = Math.floor(Date.now() / 1000);
  is("paused by its member (Stripe still says active): not", held([joined("club", "active", {}, { pause_collection: { behavior: "void", resumes_at: nowS + 86_400 }, metadata: { store: HANDLE, product: "club", pause_from: String(nowS - 60) } })]), []);
  is("a membership Stripe sent only by id: not proved", held([joined("club", "active", { subscription: "sub_Member000001" })]), []);
  is("a membership of another store: not", held([joined("club", "active", { metadata: { store: "elsewhere", product: "club" } })]), []);
  is("a payment plan: not", held([joined("club", "active", { metadata: { store: HANDLE, product: "club", kind: "plan" } })]), []);
  is("a one-off purchase paid and kept", held([oneOff("guide")]), ["guide"]);
  is("refunded in full, in part, or disputed: not", [
    held([oneOff("guide", { payment_intent: intent({}, { refunded: true, amount_refunded: 2700 }) })]),
    held([oneOff("guide", { payment_intent: intent({}, { amount_refunded: 500 }) })]),
    held([oneOff("guide", { payment_intent: intent({}, { disputed: true }) })]),
  ], [[], [], []]);
  is("a charge Stripe did not expand, or fields in another shape: not proved", [
    held([oneOff("guide", { payment_intent: "pi_Test00000001" })]),
    held([oneOff("guide", { payment_intent: intent({ latest_charge: "ch_Test000001" }) })]),
    held([oneOff("guide", { payment_intent: intent({}, { refunded: "no" }) })]),
    held([oneOff("guide", { payment_intent: intent({}, { amount_refunded: null }) })]),
  ], [[], [], [], []]);
  is("free (no payment required), not complete, or unpaid: not", [
    held([oneOff("guide", { payment_status: "no_payment_required" })]),
    held([oneOff("guide", { status: "open" })]),
    held([oneOff("guide", { payment_status: "unpaid" })]),
  ], [[], [], []]);
  is("a gift, a group or a pre-order bought for others: not this address's", [
    held([oneOff("guide", {}, { gift: "g1" })]),
    held([oneOff("guide", {}, { group: "g1" })]),
    held([oneOff("guide", {}, { preorder: "yes" })]),
  ], [[], [], []]);
  is("another store's sale: not", held([oneOff("guide", { metadata: { store: "elsewhere", product: "guide" } })]), []);
  is("a one-off row for a membership product, or a membership row for a one-off product: not", [
    held([oneOff("club")]),
    held([joined("guide", "active")]),
  ], [[], []]);
  is("a booking's deposit, a package of calls, a tip or an offer after paying: not the product bought", [
    held([oneOff("guide", {}, { kind: "call" })]),
    held([oneOff("guide", {}, { kind: "package" })]),
    held([oneOff("guide", {}, { kind: "tip" })]),
    held([oneOff("guide", {}, { kind: "upsell" })]),
  ], [[], [], [], []]);
  is("rows in another shape prove nothing and do not stop the others", held([null, 7, { id: 3 }, oneOff("guide")]), ["guide"]);

  part("On the server");
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Kitchen Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  const guide = await addProduct(OWNER, "Knife Guide", "", "12", null);
  const planner = await addProduct(OWNER, "Meal Planner", "", "27", null);
  if (!club.ok || !guide.ok || !planner.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  await setProductLink(OWNER, planner.product.id, "https://example.com/planner");
  const current = async () => (await storeForEmail(OWNER))!;
  const plannerNow = async () => (await readProduct(await current(), planner.product.id))!;

  let store = await current();
  is("a store has member prices off until its creator switches them on", store.memberPrices, NO_MEMBER_PRICES);
  await setMemberPrices(OWNER, {
    on: true,
    rules: [
      { id: "club", percent: 20, by: [club.product.id], all: true, products: [] },
      { id: "buyers", percent: 30, by: [guide.product.id], all: false, products: [planner.product.id] },
    ],
  });
  store = await current();
  is("saved and read back", store.memberPrices.rules.map((r) => [r.id, r.percent]), [["club", 20], ["buyers", 30]]);

  const proved = jar({ [passCookieName(store)]: await mintPass(store, MEMBER, "all") });
  const check = async (cookies = proved) => {
    sessionReads = 0;
    return memberPriceFor(await current(), await plannerNow(), cookies);
  };
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  is("an active member with a proved address: the member price", await check(), { state: "member", percent: 20, email: MEMBER });
  is("at most two calls to Stripe", sessionReads <= MEMBER_PRICE_STRIPE_CALLS, true);
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active"), oneOff(guide.product.id)] };
  is("a member who also bought the guide: the larger percentage", await check(), { state: "member", percent: 30, email: MEMBER });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "canceled")] };
  is("a canceled membership: no member price", await check(), { state: "none" });
  sessionsByEmail = { [MEMBER]: [oneOff(guide.product.id, { payment_intent: intent({}, { refunded: true, amount_refunded: 1200 }) })] };
  is("a refunded purchase: no member price", await check(), { state: "none" });
  sessionsByEmail = { "someone@example.com": [joined(club.product.id, "active")] };
  is("another address's membership: not this visitor's", await check(), { state: "none" });

  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  is("no pass and not signed in: nothing asked of Stripe", [await check(jar({})), sessionReads], [{ state: "none" }, 0]);
  is("a pass that is not one: nothing asked", [await check(jar({ [passCookieName(store)]: "f".repeat(64) })), sessionReads], [{ state: "none" }, 0]);
  const scoped = jar({ [passCookieName(store)]: await mintPass(store, MEMBER, ["some-course"]) });
  is("a pass for some courses only (the browser that paid, its address typed and never checked) proves nothing: Stripe is not asked", [await check(scoped), sessionReads], [{ state: "none" }, 0]);
  sessionsByEmail = { [OWNER]: [joined(club.product.id, "active")] };
  const ownerSession = jar({ [SESSION_COOKIE]: await openSession(OWNER) });
  is("the creator signed in to their own store is never shown a member price", await check(ownerSession), { state: "none" });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  const memberSession = jar({ [SESSION_COOKIE]: await openSession(MEMBER) });
  is("a member signed in to Marktmorgen with that address: proved", await check(memberSession), { state: "member", percent: 20, email: MEMBER });

  const ownerLink = jar({ [passCookieName(store)]: await mintPass(store, OWNER, "all") });
  is("the creator by a link to their own address, not signed in: never a member of their own store", await check(ownerLink), { state: "none" });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  hasMore = true;
  is("a smaller rule proved but more rows than read: a larger one may rest on them, so unknown", await check(), { state: "unknown" });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active"), oneOff(guide.product.id)] };
  is("the largest rule proved on the rows read stands whatever is past them", await check(), { state: "member", percent: 30, email: MEMBER });
  hasMore = false;
  sessionsByEmail = { [MEMBER]: "fail" };
  is("Stripe failing: unknown, never a discount", await check(), { state: "unknown" });
  sessionsByEmail = { [MEMBER]: "garbage" };
  is("Stripe answering in another shape: unknown", await check(), { state: "unknown" });
  sessionsByEmail = {};
  sessionReads = 0;
  const clubNow = (await readProduct(store, club.product.id))!;
  is("a product no rule can cover (a membership): nothing asked", [await memberPriceFor(await current(), clubNow, proved), sessionReads], [{ state: "none" }, 0]);

  const noRoom = { ...(await current()), period: null } as unknown as Awaited<ReturnType<typeof current>>;
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  sessionReads = 0;
  is("no room in the store's month for the read: unknown, and Stripe is not asked", [await memberPriceFor(noRoom, await plannerNow(), proved), sessionReads], [{ state: "unknown" }, 0]);
  const source = readFileSync(join(process.cwd(), "lib/member-price.ts"), "utf8");
  is("counted before anything about the buyer is read", source.indexOf("takeBuyerRead(store, MEMBER_PRICE_REQUEST_UNITS)") > 0 && source.indexOf("takeBuyerRead(store, MEMBER_PRICE_REQUEST_UNITS)") < source.indexOf("learnerFrom("), true);

  // Brought over from another platform: counts; a gift written there does not.
  sessionsByEmail = {};
  await redis.pipeline([["HSET", importedKey(store.statsId!, MEMBER), guide.product.id, JSON.stringify({ at: 1, job: "a".repeat(24), items: [] })]]);
  const withPast = { ...(await current()), pastBuyers: true } as Awaited<ReturnType<typeof current>>;
  is("a purchase brought over from another platform counts", await memberPriceFor(withPast, await plannerNow(), proved), { state: "member", percent: 30, email: MEMBER });
  await redis.pipeline([["HSET", importedKey(store.statsId!, MEMBER), guide.product.id, JSON.stringify({ at: 1, job: "gift:g1", items: [] })]]);
  is("a gift someone else paid for does not", await memberPriceFor(withPast, await plannerNow(), proved), { state: "none" });
  await redis.pipeline([["HSET", importedKey(store.statsId!, MEMBER), guide.product.id, JSON.stringify({ at: 1, job: "paypal:ORDER0001", items: [] })]]);
  is("nor a PayPal sale, whose refunds and disputes are not read here", await memberPriceFor(withPast, await plannerNow(), proved), { state: "none" });

  part("The page's claim, checked again at checkout");
  is("a claim is a percentage from the list, or none", [readMemberClaim("20"), readMemberClaim("23"), readMemberClaim("-5"), readMemberClaim(null), readMemberClaim("20abc")], [20, 0, 0, 0, 0]);
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  is("the claim equals what is proved now: applied", await memberClaim(await current(), await plannerNow(), 20, proved), { ok: true, member: 20, email: MEMBER });
  is("a claim larger than what is proved: refused, nothing charged", await memberClaim(await current(), await plannerNow(), 30, proved), { ok: false });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "canceled")] };
  is("a member no more: refused", await memberClaim(await current(), await plannerNow(), 20, proved), { ok: false });
  sessionsByEmail = { [MEMBER]: "fail" };
  is("Stripe failing: refused, never charged at a price not shown", await memberClaim(await current(), await plannerNow(), 20, proved), { ok: false });

  part("At checkout");
  const open = async (more: Parameters<typeof createCheckout>[4] = {}) => {
    checkouts.length = 0;
    const s = await current();
    await createCheckout(s, (await readProduct(s, planner.product.id))!, "https://marktmorgen.com", "", { ...more, digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  let sent = await open({ member: { percent: 20, email: MEMBER } });
  is("the member price comes off with the creator's own coupon, written on the order", [sent.get("discounts[0][coupon]"), sent.get("metadata[member]"), sent.get("allow_promotion_codes")], ["mm_member_20", "20", null]);
  is("made on their account once, named for the buyer", [coupons.length, coupons[0]?.get("id"), coupons[0]?.get("percent_off"), coupons[0]?.get("duration"), coupons[0]?.get("name")], [1, "mm_member_20", "20", "once", "Member price"]);
  await open({ member: { percent: 20, email: MEMBER } });
  is("the second checkout at that level makes no other", coupons.length, 1);
  sent = await open({});
  is("no member price proved: none", [sent.get("metadata[member]"), sent.get("discounts[0][coupon]")], [null, null]);
  sent = await open({ member: { percent: 23, email: MEMBER } });
  is("a percentage off the list is never sent", sent.get("metadata[member]"), null);
  const now = Math.floor(Date.now() / 1000);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring40", percent: 40, starts: now - 60, ends: now + 3600, all: true, products: [] });
  sent = await open({ member: { percent: 20, email: MEMBER } });
  const saleCoupon = (await current()).sale.coupon;
  is("a larger store sale wins, never both", [sent.get("metadata[member]"), sent.get("metadata[sale]"), sent.get("discounts[0][coupon]")], [null, "40", saleCoupon]);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring10", percent: 10, starts: now - 60, ends: now + 3600, all: true, products: [] });
  sent = await open({ member: { percent: 20, email: MEMBER } });
  is("a larger member price wins over a smaller sale, never both", [sent.get("metadata[member]"), sent.get("metadata[sale]"), sent.get("discounts[0][coupon]")], ["20", null, "mm_member_20"]);
  sent = await open({ member: { percent: 20, email: MEMBER }, coupon: "winback_coupon" });
  is("a come-back offer replaces it", [sent.get("metadata[member]"), sent.get("discounts[0][coupon]")], [null, "winback_coupon"]);
  sent = await open({ member: { percent: 20, email: MEMBER }, gift: "gift_test_0001" });
  is("a gift hands nothing to the member: no member price", sent.get("metadata[member]"), null);
  sent = await open({ member: { percent: 20, email: MEMBER }, preorder: true });
  is("a pre-order: none", sent?.get("metadata[member]") ?? null, null);
  sent = await open({ member: { percent: 20, email: MEMBER } });
  is("the checkout opens with the proved address fixed", [sent.get("metadata[member]"), sent.get("customer_email")], ["20", MEMBER]);
  const charge_ = readFileSync(join(process.cwd(), "lib/store-checkout.ts"), "utf8");
  is("never with a box checked: a coupon comes off every line, and a checked product may be one no rule covers", charge_.includes("const memberAlone = added.length === 0 && !extras.gift && !extras.group && !extras.preorder;"), true);
  const route = readFileSync(join(process.cwd(), "app/api/store/checkout/route.ts"), "utf8");
  const alone = route.indexOf("if (memberAsked && (plan || bumps.length > 0 || giftTo.trim() || people.trim() || wantsPreorder)) return away(");
  is("the route refuses a claim on anything but the member's own purchase alone, before a gift or a group is written down", alone > 0 && alone < route.indexOf("startGift(") && alone < route.indexOf("startGroup("), true);
  is("the route passes only what memberClaim proved", route.includes("member = { percent: claim.member, email: claim.email };"), true);
  is("a member price never opens the closed single-file category", charge_.includes('!(body.has("discounts[0][coupon]") && !body.has("metadata[member]"))'), true);

  part("What it reads, held to an existing line");
  is("counted as the next product after a purchase is, from the plan's public requests", MEMBER_PRICE_REQUEST_UNITS, NEXT_OFFER_REQUEST_UNITS);
  is("its listings fit inside that read", MAX_MEMBER_QUALIFYING <= NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES, true);
  is("its Stripe calls fit inside that read's five", MEMBER_PRICE_STRIPE_CALLS <= 5, true);

  part("The report");
  is("a member-price sale is named for what it was", [discountKindOf({ metadata: { member: "20" } }), DISCOUNT_NAMES.member], ["member", "Member price"]);

  done();
}

void main();
