/**
 * Every other API and MCP reading past the door takes what it reads before
 * reading it (lib/api-read-rules.ts): the numbers (/api/v1/stats, get_numbers
 * and the tools about a stretch of days), the memberships (and, when they are
 * not kept, the pages of Stripe they read), the emails, the recent events, a
 * page of products and a page of the list. With too few requests left each is
 * refused with 429 monthly_limit (the MCP error with the same sentence), with
 * nothing more read. Synthetic stores, keys and Stripe answers only.
 */
import { GET as statsRead } from "@/app/api/v1/stats/route";
import { GET as eventsRead } from "@/app/api/v1/events/route";
import { GET as productsRead } from "@/app/api/v1/products/route";
import { GET as leadsRead } from "@/app/api/v1/leads/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { MEMBERSHIPS_COLD_WORK, apiReadUnits, eventsWork, membershipsWork, numbersWork, productsPageWork } from "@/lib/api-read-rules";
import { listingsToRead, productIds } from "@/lib/catalog";
import { readsSales } from "@/lib/stats";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_api_read_units_more_only";

let commands: (string | number)[][] = [];
let stripe: string[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  stripe.push(url.pathname);
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

let n = 0;
async function paidStore(): Promise<{ owner: string; store: () => Promise<Store>; key: string }> {
  n += 1;
  const owner = `api-more-${n}@example.com`;
  await claimHandle(owner, `api-more-${n}`, `API More ${n}`, "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_ApiMore${n}00000`, subscriptionId: `sub_ApiMore${n}00000`, active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, `acct_1ApiMore0000${n}`, true);
  const store = async () => (await storeForEmail(owner))!;
  const made = await makeKey((await store()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  return { owner, store, key: made.key };
}
const get = (key: string, path: string) => new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${key}` } });
const used = async (s: { store: () => Promise<Store> }) => allowanceUsed(await s.store(), "api");
async function leaveOne(s: { store: () => Promise<Store> }): Promise<void> {
  const store = await s.store();
  const left = allowanceFor(store, "api") - (await allowanceUsed(store, "api"));
  if (left > 1) is("the month is taken down to one", (await takeAllowance(store, "api", left - 1)).ok, true);
}
let rpcId = 0;
const tool = async (key: string, name: string, args: Record<string, unknown> = {}) =>
  (await (
    await mcp(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) }))
  ).json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { code: number; message: string } };

async function main(): Promise<void> {
  redis.clear();
  const s = await paidStore();
  const numbersUnits = async () => {
    const store = await s.store();
    return apiReadUnits(numbersWork({ kept: true, sales: readsSales(store), stripe: true, paypalSales: 0, paypalRefunds: 0 }));
  };

  part("The numbers: ninety days of counts and every page of sales at their most, taken first");
  const units = await numbersUnits();
  is("they cost far more than one request", units > 10, true);
  let before = await used(s);
  stripe = [];
  const stats = await statsRead(get(s.key, "/api/v1/stats"));
  is("answered", stats.status, 200);
  is("one request and what the numbers cost", (await used(s)) - before, 1 + units);
  before = await used(s);
  is("get_numbers answers", (await tool(s.key, "get_numbers")).result?.isError, false);
  is("get_numbers takes the same", (await used(s)) - before, 1 + units);
  before = await used(s);
  is("get_funnel answers", (await tool(s.key, "get_funnel", { days: 30 })).result?.isError, false);
  is("a tool about a stretch of days takes the numbers and the listings it names", (await used(s)) - before >= 1 + units, true);

  part("The memberships: what is kept, then the pages of Stripe only when they are not");
  const store = await s.store();
  const warm = apiReadUnits(membershipsWork(productIds(store).length));
  const cold = apiReadUnits(MEMBERSHIPS_COLD_WORK);
  before = await used(s);
  stripe = [];
  is("get_memberships answers", (await tool(s.key, "get_memberships")).result?.isError, false);
  is("not kept: one request, what is kept and the pages of Stripe", [(await used(s)) - before, stripe.length > 0], [1 + warm + cold, true]);
  before = await used(s);
  stripe = [];
  await tool(s.key, "get_memberships");
  is("kept: one request and what is kept, Stripe not asked", [(await used(s)) - before, stripe.length], [1 + warm, 0]);

  part("The emails: measured first, then taken, then read");
  before = await used(s);
  is("get_emails answers", (await tool(s.key, "get_emails")).result?.isError, false);
  is("it takes more than its request", (await used(s)) - before > 1, true);

  part("The recent events: the newest deliveries at their most, taken first");
  before = await used(s);
  const events = await eventsRead(get(s.key, "/api/v1/events?type=sale.completed"));
  is("answered", events.status, 200);
  is("one request and what the deliveries cost", (await used(s)) - before, 1 + apiReadUnits(eventsWork()));

  part("A page of products: its listings counted first");
  for (let i = 0; i < 30; i += 1) await addProduct(s.owner, `Synthetic product ${i}`, "", "10");
  const withProducts = await s.store();
  const ids = productIds(withProducts).slice(0, 200);
  const expected = 1 + apiReadUnits(productsPageWork(ids.length, listingsToRead(withProducts, ids)));
  before = await used(s);
  const products = await productsRead(get(s.key, "/api/v1/products"));
  is("answered, every product", [products.status, (await products.json()).data.length], [200, ids.length]);
  is("one request and what its listings cost", (await used(s)) - before, expected);
  before = await used(s);
  is("list_products answers", (await tool(s.key, "list_products")).result?.isError, false);
  is("list_products takes the same", (await used(s)) - before, expected);

  part("A page of the list: what the scan read and what is sent, taken before it is sent");
  const listId = (await s.store()).listId!;
  await redis.pipeline(
    Array.from({ length: 200 }, (_, i) => [
      "HSET",
      `nl:store:leads:${listId}`,
      `person${i}@example.com`,
      JSON.stringify({ agreed: true, agreedAt: "2026-09-12T14:03:22.000Z", firstAt: "", lastAt: "", titles: Array.from({ length: 20 }, (_, t) => `A long synthetic product title number ${t}`), ids: [], source: "free", unsub: false, unsubAt: "", t: "f".repeat(40), name: "Synthetic Person", tags: [], importedAt: "" }),
    ]),
  );
  before = await used(s);
  const page = await leadsRead(get(s.key, "/api/v1/leads"));
  is("answered", [page.status, (await page.json()).data.length], [200, 200]);
  is("a full page of long rows costs more than its request", (await used(s)) - before > 1, true);

  part("With one request left: each refused with nothing past the door read");
  const touches = (prefix: RegExp) => (c: (string | number)[]) => prefix.test(String(c[1] ?? ""));
  const statsKeys = touches(/^nl:stats:/);
  const checks: [string, () => Promise<boolean>, (c: (string | number)[]) => boolean][] = [
    ["stats", async () => { const r = await statsRead(get(s.key, "/api/v1/stats")); return r.status === 429 && (await r.json()).error === "monthly_limit"; }, statsKeys],
    ["get_numbers", async () => { const r = await tool(s.key, "get_numbers"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, statsKeys],
    ["get_buyers", async () => { const r = await tool(s.key, "get_buyers"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, statsKeys],
    ["get_memberships", async () => { const r = await tool(s.key, "get_memberships"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, touches(/^nl:mnum:/)],
    ["get_emails", async () => { const r = await tool(s.key, "get_emails"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, (c) => c[0] === "GET" && /^nl:mail:/.test(String(c[1]))],
    ["events", async () => { const r = await eventsRead(get(s.key, "/api/v1/events?type=sale.completed")); return r.status === 429 && (await r.json()).error === "monthly_limit"; }, touches(/^nl:hooks:/)],
    ["products", async () => { const r = await productsRead(get(s.key, "/api/v1/products")); return r.status === 429 && (await r.json()).data === undefined; }, touches(/^nl:catalog:.*:l:/)],
    ["leads", async () => { const r = await leadsRead(get(s.key, "/api/v1/leads")); return r.status === 429 && (await r.json()).data === undefined; }, () => false],
  ];
  for (const [name, call, forbidden] of checks) {
    // A fresh month for each: what was taken is forgotten, then all but one taken again.
    const [, keys] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:allow:api:*", "COUNT", 10_000]]))[0] as [string, string[]];
    if (keys.length) await redis.pipeline([["DEL", ...keys]]);
    await leaveOne(s);
    commands = [];
    stripe = [];
    is(`${name}: refused with its sentence`, await call(), true);
    is(`${name}: neither Stripe nor its records read`, [stripe.length, commands.some(forbidden)], [0, false]);
    const left = await s.store();
    is(`${name}: only the door's request kept`, await allowanceUsed(left, "api"), allowanceFor(left, "api"));
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
