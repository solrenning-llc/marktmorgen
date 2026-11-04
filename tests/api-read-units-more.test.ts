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
import {
  MEMBERSHIPS_COLD_WORK, NUMBERS_KEEP_WORK, addWork, apiReadUnits, eventsWork, keptNumbersWork, listPageMost, membershipsWork, numbersWork, productsPageWork,
} from "@/lib/api-read-rules";
import { listingsToRead, productIds } from "@/lib/catalog";
import { keptMembershipBytes } from "@/lib/membership-numbers";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { members } from "@/lib/api-read";
import { keptNumbersKey, openKeptNumbers } from "@/lib/api-numbers";
import { readFullNumbersPaid, productsTool } from "@/lib/mcp-tools";
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
    return apiReadUnits(addWork(numbersWork({ kept: true, sales: readsSales(store), stripe: true, paypalSales: 0, paypalRefunds: 0 }), NUMBERS_KEEP_WORK));
  };
  const textOf = (r: Awaited<ReturnType<typeof tool>>) => JSON.parse(r.result?.content[0].text ?? "{}") as Record<string, unknown>;

  part("The numbers: read anew, ninety days of counts and every page of sales at their most, taken first, and a copy kept an hour");
  const units = await numbersUnits();
  is("they cost far more than one request", units > 10, true);
  let before = await used(s);
  stripe = [];
  const stats = await statsRead(get(s.key, "/api/v1/stats"));
  is("answered", stats.status, 200);
  const first = (await stats.json()) as { data: unknown; asOf: string };
  is("one request and what the numbers and their keeping cost", (await used(s)) - before, 1 + units);
  is("it says when they were read, ISO 8601", new Date(first.asOf).toISOString(), first.asOf);
  before = await used(s);
  stripe = [];
  const again = await statsRead(get(s.key, "/api/v1/stats"));
  const second = (await again.json()) as { data: unknown; asOf: string };
  const warmTook = (await used(s)) - before;
  is("read again within the hour: from the copy, Stripe not asked, the same numbers as of the same time", [again.status, stripe.length, second.asOf, JSON.stringify(second.data) === JSON.stringify(first.data)], [200, 0, first.asOf, true]);
  is("and it takes only what reading the copy and the answer cost", warmTook <= 3 && warmTook < (1 + units) / 5, true);
  const keptLength = Buffer.byteLength(String((await redis.pipeline([["GET", keptNumbersKey((await s.store()).statsId!, "plain")]]))[0]));
  is("settled at what it read and sent", warmTook, 1 + apiReadUnits(keptNumbersWork(keptLength, Buffer.byteLength(JSON.stringify(second)))));
  console.log(`  /api/v1/stats: read anew ${1 + units} requests, from the copy ${warmTook}`);
  before = await used(s);
  stripe = [];
  const numbers = await tool(s.key, "get_numbers");
  is("get_numbers answers from the same copy, with asOf", [numbers.result?.isError, stripe.length, textOf(numbers).asOf], [false, 0, first.asOf]);
  is("and takes as little", (await used(s)) - before <= 3, true);
  before = await used(s);
  const funnel = await tool(s.key, "get_funnel", { days: 30 });
  is("get_funnel answers, with asOf", [funnel.result?.isError, typeof textOf(funnel).asOf], [false, "string"]);
  is("a tool about a stretch of days, read anew, takes the numbers, their keeping and the listings it names", (await used(s)) - before >= 1 + units, true);
  before = await used(s);
  stripe = [];
  is("again: from its own copy", [(await tool(s.key, "get_buyers", { days: 7 })).result?.isError, stripe.length], [false, 0]);
  is("taking little", (await used(s)) - before <= 3, true);

  part("A kept copy cannot be forged, nor read for another store, nor past its hour");
  {
    const mine = await s.store();
    const raw = String((await redis.pipeline([["GET", keptNumbersKey(mine.statsId!, "plain")]]))[0]);
    const other = await paidStore();
    const theirs = await other.store();
    is("its own copy opens", openKeptNumbers(mine, "plain", raw) !== null, true);
    is("another store's copy does not open for this one", openKeptNumbers(theirs, "plain", raw), null);
    is("nor as the other variant", openKeptNumbers(mine, "full", raw), null);
    is("a changed number does not open", openKeptNumbers(mine, "plain", raw.replace(/"visitors":\d+/, '"visitors":999999')), null);
    is("an hour later it does not open", openKeptNumbers(mine, "plain", raw, Date.now() + 3_600_001), null);
    is("under another Stripe account it does not open", openKeptNumbers({ ...mine, stripeAccountId: "acct_1Someone00000" }, "plain", raw), null);
    // A copy put in the other store's place by anything but this code is read anew, and paid for as such.
    await redis.pipeline([["SET", keptNumbersKey(theirs.statsId!, "plain"), raw, "EX", 3600]]);
    const otherBefore = await used(other);
    stripe = [];
    const forged = await statsRead(get(other.key, "/api/v1/stats"));
    const otherUnits = apiReadUnits(addWork(numbersWork({ kept: true, sales: readsSales(theirs), stripe: true, paypalSales: 0, paypalRefunds: 0 }), NUMBERS_KEEP_WORK));
    is("the other store reads its own numbers anew", [forged.status, stripe.length > 0, ((await forged.json()) as { asOf: string }).asOf !== first.asOf], [200, true, true]);
    is("and pays what was read: the copy set aside and given back but its read, then the numbers", (await used(other)) - otherBefore >= 1 + otherUnits, true);
  }

  part("The memberships: whether they are kept looked up first, then all they take in one go");
  const store = await s.store();
  const cold = apiReadUnits(addWork(membershipsWork(0), MEMBERSHIPS_COLD_WORK));
  before = await used(s);
  stripe = [];
  is("get_memberships answers", (await tool(s.key, "get_memberships")).result?.isError, false);
  is("not kept: one request and, in one go, the cards, the answer and the pages of Stripe", [(await used(s)) - before, stripe.length > 0], [1 + cold, true]);
  const warm = apiReadUnits(membershipsWork((await keptMembershipBytes(store))!));
  before = await used(s);
  stripe = [];
  await tool(s.key, "get_memberships");
  is("kept: one request and what the copy holds, Stripe not asked", [(await used(s)) - before, stripe.length], [1 + warm, 0]);

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
  const pageBody = await page.json();
  is("answered", [page.status, pageBody.data.length], [200, 200]);
  const pageTook = (await used(s)) - before;
  is("a full page of long rows costs more than its request", pageTook > 1, true);
  is("settled at what it read and sent, below what was set aside at its most", pageTook < 1 + apiReadUnits(listPageMost("leads", 200)), true);

  part("Set aside, then settled: what was not needed comes back; more than was set aside is taken, or refused with the whole count");
  {
    const mine = await s.store();
    let mark = await allowanceUsed(mine, "api");
    const settle = await holdMoreApi(mine, 10);
    is("set aside", typeof settle, "function");
    if (typeof settle === "function") is("settled at two", await settle(2), null);
    is("only two stay counted", (await allowanceUsed(mine, "api")) - mark, 2);
    mark = await allowanceUsed(mine, "api");
    const settleMore = await holdMoreApi(mine, 2);
    if (typeof settleMore === "function") is("settled past it: the rest taken", await settleMore(5), null);
    is("five counted", (await allowanceUsed(mine, "api")) - mark, 5);
    const left = allowanceFor(mine, "api") - (await allowanceUsed(mine, "api"));
    if (left > 3) await takeAllowance(mine, "api", left - 3);
    const short = await holdMoreApi(mine, 2);
    const over = typeof short === "function" ? await short(6) : short;
    const words = over ? ((await over.json()) as { error: string; message: string }) : null;
    is("past what is left: refused with the whole count, nothing shown, what was taken counted", [over?.status, words?.error, words?.message], [
      429,
      "monthly_limit",
      "This read needs 7 of your store's API requests in all, more than your store has left, so what it read so far is not shown; the 3 it already took stay counted.",
    ]);
    const refusedFirst = await takeMoreApi(mine, 50);
    is("a first step refused says nothing was read", ((await refusedFirst!.json()) as { message: string }).message, "This read takes 51 of your store's API requests, more than your store has left, so nothing was read.");
  }

  part("Refused before the scan: a page of the members set aside first reads nothing when it is not left");
  {
    commands = [];
    const refusal = new Response("{}", { status: 429 });
    const answer = await members({ ...(await s.store()), community: { id: "synthetic-community" } } as Store, null, async () => refusal);
    is("the refusal, and no scan", [answer, commands.some((c) => c[0] === "HSCAN" || c[0] === "HLEN")], [refusal, false]);
  }

  part("A tool about a stretch of days whose listings are not covered keeps its numbers, without the products' names");
  {
    const mine = await s.store();
    const refusal = new Response("{}", { status: 429 });
    const read = await readFullNumbersPaid(mine, async () => refusal);
    is("the numbers, not the refusal, and no listing read", [read?.listed, Array.isArray(read?.data.days), read?.data.products.length], [false, true, 0]);
    const productsAnswer = await productsTool(mine, read!.data, "d30", { hold: async () => refusal, charge: async () => refusal });
    is("get_product_numbers without what buyers bought next, said", [productsAnswer.bought_next, typeof productsAnswer.bought_next_note], [null, "string"]);
    // What buyers bought next, set aside and settled; the products it names that the numbers do not, read only once their listings are taken.
    const [a, b] = productIds(mine);
    await redis.pipeline([["SET", `nl:next:${mine.statsId}`, JSON.stringify({ at: Date.now(), starts: { [a]: 4 }, next: { [a]: [{ id: b, buyers: 3, days: 2 }] } })]]);
    let mark = await allowanceUsed(mine, "api");
    commands = [];
    const unnamed = await productsTool(mine, read!.data, "d30", { hold: (most) => holdMoreApi(mine, most), charge: async () => refusal });
    const seq = unnamed.bought_next?.sequences[0];
    is("named by their ids when their listings are not covered, and said", [seq?.first, seq?.then, typeof unnamed.bought_next?.names_note], [a, b, "string"]);
    is("no listing read for them", commands.some((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))), false);
    is("what was set aside settled at what was read and sent", (await allowanceUsed(mine, "api")) - mark >= 1, true);
    mark = await allowanceUsed(mine, "api");
    const namedAnswer = await productsTool(mine, read!.data, "d30", { hold: (most) => holdMoreApi(mine, most), charge: (more, taken) => takeMoreApi(mine, more, taken) });
    is("with them covered, named", [namedAnswer.bought_next?.sequences[0].first !== a, namedAnswer.bought_next?.names_note], [true, undefined]);
  }

  part("With one request left: each refused with nothing past the door read");
  // A size looked up first (STRLEN) is not a reading of what it measures.
  const touches = (prefix: RegExp) => (c: (string | number)[]) => c[0] !== "STRLEN" && prefix.test(String(c[1] ?? ""));
  const statsKeys = touches(/^nl:stats:/);
  const checks: [string, () => Promise<boolean>, (c: (string | number)[]) => boolean][] = [
    ["stats", async () => { const r = await statsRead(get(s.key, "/api/v1/stats")); return r.status === 429 && (await r.json()).error === "monthly_limit"; }, statsKeys],
    ["get_numbers", async () => { const r = await tool(s.key, "get_numbers"); return r.error?.code === -32001 && /This read (takes|may take up to)/.test(r.error.message); }, statsKeys],
    ["get_buyers", async () => { const r = await tool(s.key, "get_buyers"); return r.error?.code === -32001 && /This read (takes|may take up to)/.test(r.error.message); }, statsKeys],
    ["get_memberships", async () => { const r = await tool(s.key, "get_memberships"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, touches(/^nl:mnum:/)],
    ["get_emails", async () => { const r = await tool(s.key, "get_emails"); return r.error?.code === -32001 && /This read takes/.test(r.error.message); }, (c) => c[0] === "GET" && /^nl:mail:/.test(String(c[1]))],
    ["events", async () => { const r = await eventsRead(get(s.key, "/api/v1/events?type=sale.completed")); return r.status === 429 && (await r.json()).error === "monthly_limit"; }, touches(/^nl:hooks:/)],
    ["products", async () => { const r = await productsRead(get(s.key, "/api/v1/products")); return r.status === 429 && (await r.json()).data === undefined; }, touches(/^nl:catalog:.*:l:/)],
    ["leads", async () => { const r = await leadsRead(get(s.key, "/api/v1/leads")); return r.status === 429 && (await r.json()).data === undefined; }, (c) => c[0] === "HSCAN"],
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
