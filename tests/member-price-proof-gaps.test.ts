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
  subscription: { id: "sub_C1Member0001", object: "subscription", status: "active", metadata: { store: HANDLE, product }, items: { data: [] } },
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
