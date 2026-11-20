/**
 * Member prices (620 [SZ4]): two gaps in proving what a visitor holds,
 * from the reviews of #2999 (L1 by the Claude 4 team, confirmed by Claude 6;
 * L2 and this proof by Claude 1's independent review).
 *
 * L1: an unknown HGETALL reply on the imported purchases must make the
 *     member price "unknown", never "none" or a smaller rule (rule 24;
 *     memberPriceFor's own "a larger rule may rest on a purchase not read:
 *     said as unknown, never as no"). An empty reply is still a real
 *     "nothing imported".
 * L2: a visitor signed in to Marktmorgen (an inbox proved) whose browser
 *     also carries a pass for some courses only must still be proved by the
 *     session: learnerFrom reads the scoped pass first, for courses.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { memberPriceFor } from "@/lib/member-price";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { mintPass, passCookieName } from "@/lib/learn";
import { importedKey } from "@/lib/imported-purchases";
import { SESSION_COOKIE, openSession } from "@/lib/auth";

process.env.STRIPE_SECRET_KEY = "sk_test_c1proof_only";
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const HANDLE = "harbor";

let rows: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "GET") {
    const asked = url.searchParams.get("customer_details[email]") ?? "";
    return new Response(JSON.stringify({ object: "list", data: asked === MEMBER ? rows : [], has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const joined = (product: string) => ({
  id: "cs_test_c1member00001",
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  // Stripe always sends at least one item, and the checkout writes the product on its price (Codex X6's re-check of #2999).
  subscription: { id: "sub_C1Member0001", object: "subscription", status: "active", metadata: { store: HANDLE, product }, items: { object: "list", data: [{ id: "si_C1Member0001", price: { id: "price_C1Member0001", metadata: { product } } }] }, pause_collection: null },
});
const jar = (cookies: Record<string, string>) => ({ get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) });

async function main(): Promise<void> {
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
  await setMemberPrices(OWNER, {
    on: true,
    rules: [
      { id: "club", percent: 20, by: [club.product.id], all: true, products: [] },
      { id: "buyers", percent: 30, by: [guide.product.id], all: false, products: [planner.product.id] },
    ],
  });
  const base = (await storeForEmail(OWNER))!;
  const store = { ...base, pastBuyers: true } as typeof base;
  const product = (await readProduct(store, planner.product.id))!;
  const proved = jar({ [passCookieName(store)]: await mintPass(store, MEMBER, "all") });

  part("L1: an unknown reply on the imported purchases");
  const imported = importedKey(store.statsId!, MEMBER);
  await redis.pipeline([["HSET", imported, guide.product.id, JSON.stringify({ at: 1, job: "b".repeat(24), items: [] })]]);
  const real = redis.pipeline.bind(redis);
  let reply: { value: unknown } | null = null;
  (redis as unknown as { pipeline: typeof real }).pipeline = (async (commands: (string | number)[][]) => {
    const answers = await real(commands);
    if (reply && commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === imported) return [reply.value];
    return answers;
  }) as typeof real;

  rows = [joined(club.product.id)];
  is("control: a club member (20%) who bought the guide elsewhere (30%), read normally: 30%", await memberPriceFor(store, product, proved), { state: "member", percent: 30, email: MEMBER });
  for (const [label, value] of [["a number", 7], ["a missing slot", undefined], ["a string", "OK"], ["a list with a number in it", [guide.product.id, 7]], ["a field with no value", [guide.product.id]]] as const) {
    reply = { value };
    rows = [joined(club.product.id)];
    is(`club member, the imported read answers ${label}: unknown (a larger rule may rest on it), not 20%`, await memberPriceFor(store, product, proved), { state: "unknown" });
    rows = [];
    is(`only the imported purchase, the read answers ${label}: unknown, not none`, await memberPriceFor(store, product, proved), { state: "unknown" });
  }
  reply = { value: [] };
  rows = [];
  is("an empty reply is a real nothing imported: none", await memberPriceFor(store, product, proved), { state: "none" });
  rows = [joined(club.product.id)];
  is("an empty reply, club member: 20%", await memberPriceFor(store, product, proved), { state: "member", percent: 20, email: MEMBER });
  reply = { value: 7 };
  const allRule = (await readProduct(store, guide.product.id))!;
  rows = [joined(club.product.id)];
  is("the imported read unknown, but the club's 20% is the most the guide itself can get: still 20%", await memberPriceFor(store, allRule, proved), { state: "member", percent: 20, email: MEMBER });
  reply = null;

  // Codex V's review of #2999 (MEDIUM): a row whose expanded fields come in another shape cannot be decided, so it is
  // unreadable (lib/stripe-list.ts): past it a "no" is not known, and a larger rule that may rest on it makes the
  // answer unknown, never a smaller rule or none.
  part("L3: a row the decision cannot read is unreadable, not a no");
  await redis.pipeline([["DEL", imported]]);
  const bought = (pi: unknown) => ({
    id: "cs_test_c5guide0000001",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    metadata: { store: HANDLE, product: guide.product.id },
    payment_intent: pi,
    subscription: null,
  });
  const kept = { id: "pi_C5Guide0001", status: "succeeded", latest_charge: { id: "ch_C5Guide0001", paid: true, refunded: false, amount_refunded: 0, disputed: false } };
  rows = [joined(club.product.id), bought(kept)];
  is("control: the guide's purchase read whole proves the 30%", await memberPriceFor(store, product, proved), { state: "member", percent: 30, email: MEMBER });
  for (const [label, pi] of [
    ["its payment not expanded (an id)", "pi_C5Guide0001"],
    ["its charge not expanded (an id)", { ...kept, latest_charge: "ch_C5Guide0001" }],
    ["its charge's refund in another shape", { ...kept, latest_charge: { ...kept.latest_charge, refunded: "no" } }],
    // Codex X6's re-check of #2999: an amount refunded is a whole number of cents from zero up; anything else is no amount.
    ["its charge's amount refunded negative", { ...kept, latest_charge: { ...kept.latest_charge, amount_refunded: -1 } }],
    ["its charge's amount refunded a fraction", { ...kept, latest_charge: { ...kept.latest_charge, amount_refunded: 1.5 } }],
  ] as const) {
    rows = [joined(club.product.id), bought(pi)];
    is(`club member, the guide's row with ${label}: unknown (the 30% may rest on it), not 20%`, await memberPriceFor(store, product, proved), { state: "unknown" });
  }
  rows = [{ ...joined(club.product.id), subscription: "sub_C1Member0001" }];
  is("the club's row with its subscription not expanded: unknown, not none", await memberPriceFor(store, product, proved), { state: "unknown" });
  // Codex U on #2999 (U-20261117-0045): a subscription in part. Its tier (items, metadata) and its pause decide whether
  // the club is held; one that does not carry them in Stripe's shape proves nothing, never the product bought.
  const sub = joined(club.product.id).subscription;
  const priced = { ...sub, items: { object: "list", data: [{ id: "si_C1Member0001", price: { id: "price_C1Member0001", metadata: { product: club.product.id } } }] } };
  rows = [{ ...joined(club.product.id), subscription: priced }];
  is("control: a whole subscription, its price's product and no pause, proves the 20%", await memberPriceFor(store, product, proved), { state: "member", percent: 20, email: MEMBER });
  for (const [label, partial] of [
    ["only its status", { status: "active" }],
    ["no items", { ...sub, items: undefined }],
    ["its items not a list", { ...sub, items: { object: "list", data: "si_C1Member0001" } }],
    ["its item's price not expanded", { ...priced, items: { object: "list", data: [{ id: "si_C1Member0001", price: "price_C1Member0001" }] } }],
    ["its item's price without metadata", { ...priced, items: { object: "list", data: [{ id: "si_C1Member0001", price: { id: "price_C1Member0001" } }] } }],
    ["no metadata", { ...sub, metadata: undefined }],
    ["metadata not text", { ...sub, metadata: { store: HANDLE, product: 7 } }],
    ["no pause field", { ...sub, pause_collection: undefined }],
    ["its pause in another shape", { ...sub, pause_collection: "paused" }],
    ["its pause's end in another shape", { ...sub, pause_collection: { behavior: "void", resumes_at: "soon" } }],
    // Codex X6's re-check of #2999 (LOW): with no item, or no product on the price nor on the subscription, the product it
    // is on now is not proved, and falling back to the product bought would keep a member moved off it on it.
    ["its items an empty list", { ...sub, items: { object: "list", data: [] } }],
    ["no product on its price nor on itself", { ...sub, metadata: { store: HANDLE }, items: { object: "list", data: [{ id: "si_C1Member0001", price: { id: "price_C1Member0001", metadata: {} } }] } }],
  ] as const) {
    rows = [{ ...joined(club.product.id), subscription: JSON.parse(JSON.stringify(partial)) }];
    is(`the club's subscription with ${label}: unknown, not 20%`, await memberPriceFor(store, product, proved), { state: "unknown" });
  }
  rows = [];

  part("L2: a proved session behind a pass for some courses only");
  await redis.pipeline([["DEL", imported]]);
  rows = [joined(club.product.id)];
  const session = await openSession(MEMBER);
  is("control: signed in with no pass: the member price", await memberPriceFor(store, product, jar({ [SESSION_COOKIE]: session })), { state: "member", percent: 20, email: MEMBER });
  const both = jar({ [SESSION_COOKIE]: session, [passCookieName(store)]: await mintPass(store, MEMBER, ["some-course"]) });
  is("signed in (inbox proved) and also holding a pass for one course: still the member price", await memberPriceFor(store, product, both), { state: "member", percent: 20, email: MEMBER });
  const passOnly = jar({ [passCookieName(store)]: await mintPass(store, MEMBER, ["some-course"]) });
  is("a pass for one course and no session: proves nothing, none", await memberPriceFor(store, product, passOnly), { state: "none" });
  const ownerSession = await openSession(OWNER);
  is("the creator signed in on their own store, with a pass for one course: none", await memberPriceFor(store, product, jar({ [SESSION_COOKIE]: ownerSession, [passCookieName(store)]: await mintPass(store, MEMBER, ["some-course"]) })), { state: "none" });

  done();
}

void main();
