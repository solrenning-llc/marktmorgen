/**
 * C3-101 (follow-up of #2151): the recent events (GET /api/v1/events) and
 * get_emails pay for what they really read and send, measured before they
 * read it, and a webhook delivery is bounded where it is made.
 *
 * A sale of a bundle of twenty products, with three products ticked at
 * checkout that are each a bundle of twenty, every title eighty characters of
 * a three-byte script, is kept at about 30 KB a delivery: fifty of them are
 * what the events read. The route used to take a flat count priced at 4 KB a
 * delivery (5 requests); it now takes what the measured bytes and what it
 * sends cost. A message past DELIVERY_MAX_BYTES is never kept or sent: its
 * line says so. Synthetic stores, keys, Stripe answers and endpoints only;
 * the endpoint's name resolves to a private address, so nothing leaves.
 */
import { GET as eventsRead } from "@/app/api/v1/events/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { EMAILS_PROBE_WORK, MAIL_REVENUE_BYTES, addWork, apiReadUnits, emailsWork, eventsSentMost, eventsWork, settledUnits } from "@/lib/api-read-rules";
import { bundleMeta } from "@/lib/bundle-rules";
import { broadcastSizes } from "@/lib/broadcasts";
import { flowsBytes } from "@/lib/flows";
import { keptMailRevenueBytes } from "@/lib/mail-revenue";
import {
  DELIVERY_MAX_BYTES, DELIVERY_UPDATE_ROOM_BYTES, LOG_SIZE, QUEUE_KEY, TOO_LARGE_WORDS, addEndpoint, emitEvent, recentMessages, resendDelivery, setSendHooksForTests, watchStripe, webhooksView,
} from "@/lib/webhooks";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { FAMILIES } from "./store-data-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_api_events_measured_only";
const OWNER = "events-measured@example.com";
const HANDLE = "events-measured";
const ACCOUNT = "acct_1EventsMeasured01";

let events: Record<string, unknown>[] = [];
let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin === "https://api.stripe.com" && url.pathname === "/v1/events") return Response.json({ object: "list", data: events, has_more: false });
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;
// Every try is refused before a socket opens; the deliveries stay kept, which is what is read here.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (/^(a webhook delivery failed|WEBHOOK MESSAGE TOO LARGE)/.test(String(args[0])) ? undefined : logged(...args));

const get = (key: string, path: string) => new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${key}` } });
let rpcId = 0;
const tool = async (key: string, name: string) =>
  (await (
    await mcp(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: {} } }) }))
  ).json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { code: number; message: string } };
const mine = async () => (await storeForEmail(OWNER))!;
const used = async () => allowanceUsed(await mine(), "api");
async function leave(n: number): Promise<void> {
  const store = await mine();
  const [, keys] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:allow:api:*", "COUNT", 10_000]]))[0] as [string, string[]];
  if (keys.length) await redis.pipeline([["DEL", ...keys]]);
  const left = allowanceFor(store, "api");
  if (left > n) is(`the month is taken down to ${n}`, (await takeAllowance(store, "api", left - n)).ok, true);
}
async function deliveryIds(statsId: string): Promise<string[]> {
  const [log] = await redis.pipeline([["LRANGE", `nl:hooks:log:${statsId}`, 0, -1]]);
  return (log as string[]).map(String);
}
async function sizesOf(ids: string[]): Promise<number[]> {
  return (await redis.pipeline(ids.map((id) => ["STRLEN", `nl:hooks:d:${id}`]))).map(Number);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Events Measured", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EventsMeasured01", subscriptionId: "sub_EventsMeasured01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await makeKey((await mine()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  const key = made.key;
  is("an endpoint hears sales", (await addEndpoint(await mine(), "https://hooks.example.net/in", ["sale.completed"])).ok, true);

  part("The largest sale the code makes: a bundle of twenty, three ticked at checkout, each a bundle of twenty, every title 80 characters of a three-byte script");
  const ids: string[] = [];
  for (let i = 0; i < 84; i += 1) {
    const added = await addProduct(OWNER, `${"€".repeat(78)}${String(i).padStart(2, "0")}`, "", "10");
    if (!added.ok) throw new Error(`no synthetic product ${i}`);
    ids.push(added.product.id);
  }
  const [main, ...rest] = ids;
  const meta = {
    store: HANDLE,
    product: main,
    title: "€".repeat(80),
    ...bundleMeta("bundle", rest.slice(0, 20)),
    bump: rest[20],
    bump2: rest[21],
    bump3: rest[22],
    ...bundleMeta("bump_bundle", rest.slice(23, 43)),
    ...bundleMeta("bump2_bundle", rest.slice(43, 63)),
    ...bundleMeta("bump3_bundle", rest.slice(63, 83)),
  };
  const sale = (n: number, extra: Record<string, string> = {}) => ({
    id: `evt_BigSale${String(n).padStart(3, "0")}`,
    type: "checkout.session.completed",
    created: 1_790_000_000 + n,
    data: { object: { id: `cs_BigSale${String(n).padStart(3, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 99_00, currency: "usd", metadata: { ...meta, ...extra }, customer_details: { email: `buyer${n}@example.com`, name: "Synthetic Buyer" } } },
  });
  events = Array.from({ length: LOG_SIZE }, (_, n) => sale(n)).reverse();
  await watchStripe(Date.now() + 60_000);
  const statsId = (await mine()).statsId!;
  const logIds = await deliveryIds(statsId);
  is("the newest LOG_SIZE deliveries are in the log", logIds.length, LOG_SIZE);
  const sizes = await sizesOf(logIds);
  const largest = Math.max(...sizes);
  console.log(`  a delivery of this sale is kept at ${largest.toLocaleString("en-US")} bytes; the ${LOG_SIZE} at ${sizes.reduce((a, b) => a + b, 0).toLocaleString("en-US")}`);
  const sample = (await recentMessages(await mine(), "sale.completed", 1))[0] as { data: { bundle_items: unknown[]; order_bumps: { bundle_items: unknown[] }[] } };
  is("the message names the bundle and every product ticked, each with its own bundle", [sample.data.bundle_items.length, sample.data.order_bumps.length, sample.data.order_bumps.map((b) => b.bundle_items.length)], [20, 3, [20, 20, 20]]);
  is("far past the 4 KB a delivery was priced at", largest > 7 * 4 * 1024, true);
  is("inside the bound a delivery is made under, with the room its tries write later", largest <= DELIVERY_MAX_BYTES - DELIVERY_UPDATE_ROOM_BYTES, true);
  const family = FAMILIES["nl:hooks:d:@lib/webhooks.ts"];
  const priced = family.parts?.find((p) => "per" in p && p.per === "webhook");
  is("the store's data registry prices a delivery at the bound, at or above the largest the code makes", priced && "bytes" in priced ? [priced.bytes === DELIVERY_MAX_BYTES, priced.bytes >= largest] : null, [true, true]);

  part("GET /api/v1/events: measured, set aside, settled at what was read and sent");
  const logBytes = logIds.reduce((n, id) => n + Buffer.byteLength(id), 0);
  const kept = sizes.reduce((a, b) => a + b, 0);
  const heldTen = apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent: eventsSentMost(sizes, 10) }));
  let before = await used();
  commands = [];
  const answer = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  const body = (await answer.json()) as { data: unknown[] };
  const sent = Buffer.byteLength(JSON.stringify(body.data));
  const read = commands.filter((c) => c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1]))).length;
  const took = (await used()) - before;
  const due = 1 + settledUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent }), heldTen);
  console.log(`  limit=10: ${(logBytes + kept).toLocaleString("en-US")} bytes read, ${sent.toLocaleString("en-US")} sent, ${took} requests taken (priced at 4 KB a delivery it was 5)`);
  is("answered, ten messages", [answer.status, body.data.length], [200, 10]);
  is("every delivery in the log read once", read, LOG_SIZE);
  is("the requests taken are what the bytes read and sent cost, with the door's", took, due);
  is("more than the flat 5 the 4 KB price took for this", took > 5, true);
  is("each delivery measured before any was read", commands.findIndex((c) => c[0] === "STRLEN" && /^nl:hooks:d:/.test(String(c[1]))) < commands.findIndex((c) => c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1]))), true);

  before = await used();
  const one = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=1"));
  const oneBody = (await one.json()) as { data: unknown[] };
  const oneTook = (await used()) - before;
  is("limit=1: one message, settled at the one sent", [one.status, oneBody.data.length, oneTook], [200, 1, 1 + apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent: Buffer.byteLength(JSON.stringify(oneBody.data)) }))]);
  is("and no more than limit=10", oneTook <= took, true);

  before = await used();
  const other = await eventsRead(get(key, "/api/v1/events?type=refund.issued"));
  is("a type none of them is: the deliveries read, nothing sent", [other.status, ((await other.json()) as { data: unknown[] }).data.length, (await used()) - before], [200, 0, 1 + apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent: 2 }))]);

  part("Too few requests left for what was measured: refused, no delivery read, only the door's request kept");
  await leave(heldTen);
  commands = [];
  const refused = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  const words = (await refused.json()) as { error: string; message: string };
  is("refused with the whole count it may take", [refused.status, words.error, words.message.includes(`up to ${(heldTen + 1).toLocaleString("en-US")} of your store's API requests`)], [429, "monthly_limit", true]);
  is("no delivery read", commands.some((c) => c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1]))), false);
  is("only the door's request kept", await used(), allowanceFor(await mine(), "api") - heldTen + 1);
  await leave(heldTen + 1);
  const fits = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  is("with exactly what it may take left, answered", fits.status, 200);
  is("and what it did not need given back", await used(), allowanceFor(await mine(), "api") - (heldTen + 1 - due));
  await leave(1_000);

  part("A message past the bound is never kept or sent: its line says so, nothing queued, nothing counted");
  const webhooksBefore = await allowanceUsed(await mine(), "webhook");
  const queued = await emitEvent(await mine(), "sale.completed", "synthetic-too-large", { note: "x".repeat(DELIVERY_MAX_BYTES) });
  const [lineId] = await deliveryIds(statsId);
  const [rawLine, score, lineSize] = await redis.pipeline([["GET", `nl:hooks:d:${lineId}`], ["ZSCORE", QUEUE_KEY, `${statsId}|${lineId}`], ["STRLEN", `nl:hooks:d:${lineId}`]]);
  const line = JSON.parse(String(rawLine)) as { body: string; state: string; lastError: string; givenUp?: boolean };
  is("nothing queued", [queued, score], [0, null]);
  is("its line: no message, failed, with the reason", [line.body, line.state, line.lastError, line.givenUp], ["", "failed", TOO_LARGE_WORDS, true]);
  is("kept small", Number(lineSize) < 2 * 1024, true);
  is("the studio's log shows it, without a way to send it again", [(await webhooksView(await mine())).log[0].lastError, (await resendDelivery(await mine(), lineId)).ok], [TOO_LARGE_WORDS, false]);
  is("no webhook delivery of the month taken", (await allowanceUsed(await mine(), "webhook")) - webhooksBefore, 0);
  const fitting = await emitEvent(await mine(), "sale.completed", "synthetic-fits", { note: "x".repeat(DELIVERY_MAX_BYTES - DELIVERY_UPDATE_ROOM_BYTES - 2_000) });
  is("a message just inside the bound is queued as always", fitting, 1);

  part("The order's own title stands in only for its own product when a listing is gone");
  events = [sale(900, { product: "p_gone_main", bump: "p_gone_bump", bump2: "", bump3: "", ...bundleMeta("bundle", ["p_gone_b1"]), ...bundleMeta("bump_bundle", ["p_gone_b2"]), title: "The order's own title" })];
  await watchStripe(Date.now() + 60_000);
  const gone = (await recentMessages(await mine(), "sale.completed", 10)).find((m) => (m.data as { checkout_session: string }).checkout_session === "cs_BigSale900")!.data as {
    product: { title: string | null }; bundle_items: { title: string | null }[]; order_bump: { title: string | null; bundle_items: { title: string | null }[] };
  };
  is("its own product: the order's title; a bundle's product or one ticked: none", [gone.product.title, gone.bundle_items[0].title, gone.order_bump.title, gone.order_bump.bundle_items[0].title], ["The order's own title", null, null, null]);

  part("get_emails with a kept copy of what they sold of 172 KB: measured, set aside and settled at it");
  const store = await mine();
  const broadcastId = "b".repeat(24);
  await redis.pipeline([
    ["LPUSH", `nl:mail:bcs:${store.listId}`, broadcastId],
    ["SET", `nl:mail:bc:${broadcastId}`, JSON.stringify({ id: broadcastId, listId: store.listId, handle: HANDLE, subject: "Synthetic news", body: "Hello", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", total: 10, sent: 10, sendAt: 1_790_000_000, finishedAt: 1_790_000_100, tagged: true })],
  ]);
  const by: Record<string, { sales: number; cents: number }> = {};
  for (let i = 0; JSON.stringify({ by, partial: false }).length < 172_000; i += 1) by[`b-${String(i).padStart(24, "0")}x${"y".repeat(10)}`] = { sales: 1, cents: 99_999 };
  await redis.pipeline([["SET", `nl:stats:${store.statsId}:mailsales:v2`, JSON.stringify({ by, partial: false }), "EX", 600]]);
  const copy = (await keptMailRevenueBytes(store))!;
  const sizesNow = (await broadcastSizes(store.listId, 30))!;
  const flowBytes = (await flowsBytes(store.listId))!;
  const emails = (revenueBytes: number) => addWork(EMAILS_PROBE_WORK, emailsWork({ broadcasts: sizesNow.count, broadcastBytes: sizesNow.bytes, flowBytes, revenueBytes }));
  before = await used();
  const answered = await tool(key, "get_emails");
  const emailsTook = (await used()) - before;
  console.log(`  get_emails: a kept copy of ${copy.toLocaleString("en-US")} bytes takes ${emailsTook}; priced at ${MAIL_REVENUE_BYTES.toLocaleString("en-US")} it took ${1 + apiReadUnits(emails(MAIL_REVENUE_BYTES))}`);
  is("answered", answered.result?.isError, false);
  is("the copy is the size asked", copy >= 172_000, true);
  is("the requests taken are what the copy read costs, with the door's", emailsTook, 1 + apiReadUnits(emails(copy)));
  is("more than its old 64 KB price", emailsTook > 1 + apiReadUnits(emails(MAIL_REVENUE_BYTES)), true);
  await leave(apiReadUnits(emails(copy)));
  commands = [];
  const short = await tool(key, "get_emails");
  is("one short of it: refused, nothing read", [short.error?.code, /This read may take up to/.test(short.error?.message ?? ""), commands.some((c) => c[0] === "GET" && /^nl:(mail:|stats:.*:mailsales)/.test(String(c[1])))], [-32001, true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
