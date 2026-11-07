/**
 * CX-116 second review of #2999 (proof only): an unknown HGETALL reply on the
 * imported purchases must make the member price "unknown", never "none" or a
 * smaller rule (rule 24; memberPriceFor's own "a larger rule may rest on a
 * purchase not read: said as unknown, never as no").
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { memberPriceFor } from "@/lib/member-price";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { mintPass, passCookieName } from "@/lib/learn";
import { importedKey } from "@/lib/imported-purchases";

process.env.STRIPE_SECRET_KEY = "sk_test_cx116_only";
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const HANDLE = "harbor";

let rows: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "GET") return new Response(JSON.stringify({ object: "list", data: rows, has_more: false }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
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
  const imported = importedKey(store.statsId!, MEMBER);
  await redis.pipeline([["HSET", imported, guide.product.id, JSON.stringify({ at: 1, job: "a".repeat(24), items: [] })]]);

  // The HGETALL on the imported purchases answers something that is not a reply to it.
  const real = redis.pipeline.bind(redis);
  let unknown: unknown = "unset";
  (redis as unknown as { pipeline: typeof real }).pipeline = (async (commands: (string | number)[][]) => {
    const answers = await real(commands);
    if (unknown !== "unset" && commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === imported) return [unknown];
    return answers;
  }) as typeof real;

  part("Control: the imported purchase read normally");
  rows = [joined(club.product.id)];
  is("club member who bought the guide elsewhere: 30%", await memberPriceFor(store, product, proved), { state: "member", percent: 30, email: MEMBER });

  part("Unknown HGETALL reply on imported purchases");
  for (const [label, reply] of [["a number", 7], ["a missing slot", undefined]] as const) {
    unknown = reply;
    rows = [joined(club.product.id)];
    is(`club member (20%) whose 30% purchase is imported, reply is ${label}: unknown`, await memberPriceFor(store, product, proved), { state: "unknown" });
    rows = [];
    is(`only the imported purchase, reply is ${label}: unknown`, await memberPriceFor(store, product, proved), { state: "unknown" });
  }
  done();
}

void main();
