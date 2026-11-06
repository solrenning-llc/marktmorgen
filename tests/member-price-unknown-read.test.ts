/**
 * Member prices (620 [SZ4]): a read that could not be done is "unknown",
 * never "no" (rule 24; review of #2999, L1).
 *
 *   - The purchases brought over from another platform are read with one
 *     HGETALL. A reply in any other shape than a flat list of text fields and
 *     values (a number, a missing slot, an odd list, a non-text member, an
 *     object) proves nothing: a larger rule may rest on it, so the answer is
 *     "unknown" and the full price is shown and charged.
 *   - Sibling (rule 30): a qualifying product the store has but whose listing
 *     could not be read is left out by readListings. A larger rule may rest on
 *     it too, so the same "unknown"; a product the store no longer has is
 *     simply not a way to qualify.
 *
 * Synthetic data only: the Stripe and Redis stand-ins of the other member
 * price test.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { memberPriceFor } from "@/lib/member-price";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { mintPass, passCookieName } from "@/lib/learn";
import { importedKey } from "@/lib/imported-purchases";

process.env.STRIPE_SECRET_KEY = "sk_test_member_price_unknown_only";
const OWNER = "owner-unknown@example.com";
const MEMBER = "member-unknown@example.com";
const HANDLE = "harborread";

let sessionsByEmail: Record<string, unknown[]> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "GET") {
    const rows = sessionsByEmail[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const joined = (product: string) => ({
  id: "cs_test_member000001",
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: "sub_Member000001", object: "subscription", status: "active", metadata: { store: HANDLE, product }, items: { data: [] } },
});
const jar = (cookies: Record<string, string>) => ({ get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) });

/** Answers one command of the pipeline differently; every other command is the stand-in's own. */
const realPipeline = redis.pipeline;
function answerWith(match: (command: (string | number)[]) => boolean, replies: (real: unknown[]) => unknown[]): void {
  redis.pipeline = async (commands) => {
    const real = await realPipeline(commands);
    return commands.some(match) ? replies(real) : real;
  };
}
const restore = () => {
  redis.pipeline = realPipeline;
};

async function main(): Promise<void> {
  await claimHandle(OWNER, HANDLE, "Harbor Read", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarborRead1", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
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
  const current = async () => ({ ...(await storeForEmail(OWNER))!, pastBuyers: true });
  const plannerNow = async () => (await readProduct(await current(), planner.product.id))!;
  const proved = jar({ [passCookieName(await current())]: await mintPass(await current(), MEMBER, "all") });
  const check = async () => memberPriceFor(await current(), await plannerNow(), proved);
  const statsId = (await current()).statsId!;
  const importedRead = (command: (string | number)[]) => command[0] === "HGETALL" && command[1] === importedKey(statsId, MEMBER);

  part("Purchases brought over: the reply read in its exact shape");
  await redis.pipeline([["HSET", importedKey(statsId, MEMBER), guide.product.id, JSON.stringify({ at: 1, job: "a".repeat(24), items: [] })]]);
  sessionsByEmail = { [MEMBER]: [joined(club.product.id)] };
  is("control: a member who also bought the guide on the old platform gets the larger percentage", await check(), { state: "member", percent: 30, email: MEMBER });
  const shapes: [string, unknown[]][] = [
    ["a number", [7]],
    ["no reply at all (a missing slot)", []],
    ["an odd list", [[guide.product.id]]],
    ["a list with a member that is not text", [[guide.product.id, 7]]],
    ["an object, not the list Redis answers", [{ [guide.product.id]: JSON.stringify({ at: 1, job: "a".repeat(24), items: [] }) }]],
    ["one reply too many", [[], []]],
  ];
  for (const [what, replies] of shapes) {
    answerWith(importedRead, () => replies);
    is(`a club member whose imported purchases answer ${what}: unknown, never a member price read from it`, await check(), { state: "unknown" });
    restore();
  }
  sessionsByEmail = {};
  answerWith(importedRead, () => [7]);
  is("a buyer who has only the imported purchase, read in another shape: unknown, never none", await check(), { state: "unknown" });
  restore();
  is("control: the same buyer, read in its shape: the member price", await check(), { state: "member", percent: 30, email: MEMBER });
  answerWith(importedRead, () => [[]]);
  is("control: an empty list is a real no (only the club rule left, not held): none", await check(), { state: "none" });
  restore();
  await redis.pipeline([["DEL", importedKey(statsId, MEMBER)]]);

  part("Sibling: a qualifying product whose listing could not be read");
  sessionsByEmail = { [MEMBER]: [joined(club.product.id)] };
  const headless = async (without: string[]) => {
    const s = await current();
    return { ...s, catalog: { ...s.catalog, inline: undefined, head: s.catalog.head.filter((l) => !without.includes(l.id)) } } as typeof s;
  };
  const listingRead = (id: string) => (command: (string | number)[]) => command[0] === "GET" && String(command[1]).endsWith(`:l:${id}`);
  const unreadable = (ids: string[]) => (command: (string | number)[]) => ids.some((id) => listingRead(id)(command));
  const corrupt = (ids: string[]) =>
    answerWith(unreadable(ids), (real) => real.map(() => "{not json"));
  corrupt([guide.product.id]);
  is(
    "a club member while the guide's listing answers garbage: a larger rule may rest on it, so unknown",
    await memberPriceFor(await headless([guide.product.id]), await plannerNow(), proved),
    { state: "unknown" },
  );
  restore();
  corrupt([guide.product.id, club.product.id]);
  is(
    "no qualifying listing readable at all: unknown, never none",
    await memberPriceFor(await headless([guide.product.id, club.product.id]), await plannerNow(), proved),
    { state: "unknown" },
  );
  restore();
  is("control: every listing readable: the club member's 20%", await check(), { state: "member", percent: 20, email: MEMBER });
  const withGone = async () => {
    const s = await current();
    return { ...s, memberPrices: { on: true, rules: [...s.memberPrices.rules, { id: "gone", percent: 50, by: ["gonegone01"], all: true, products: [] }] } } as typeof s;
  };
  is("control: a rule resting on a product the store no longer has is no way to qualify, not unknown", await memberPriceFor(await withGone(), await plannerNow(), proved), {
    state: "member",
    percent: 20,
    email: MEMBER,
  });

  done();
}

void main();
