/**
 * C3-101 (follow-up of #2151): the recent events (GET /api/v1/events) and
 * get_emails pay for what they really read and send, measured before they
 * read it, and a webhook delivery is bounded where it is made.
 *
 * A sale of a bundle of twenty products, with three products checked at
 * checkout that are each a bundle of twenty, every title eighty characters of
 * a three-byte script, is kept at about 30 KB a delivery: fifty of them are
 * what the events read. The route used to take a flat count priced at 4 KB a
 * delivery (5 requests); it now takes what the measured bytes and what it
 * sends cost. A message past DELIVERY_MAX_BYTES is never kept or sent: its
 * line says so. Synthetic stores, keys, Stripe answers and endpoints only;
 * the endpoint's name resolves to a private address, so nothing leaves.
 */
import { readFileSync } from "node:fs";
import { GET as eventsRead } from "@/app/api/v1/events/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { EMAILS_PROBE_WORK, EVENTS_PROBE_MOST, MAIL_REVENUE_BYTES, addWork, apiReadUnits, emailsWork, eventsSentMost, eventsWork, settledUnits } from "@/lib/api-read-rules";
import { bundleMeta } from "@/lib/bundle-rules";
import { broadcastSizes } from "@/lib/broadcasts";
import { flowsBytes } from "@/lib/flows";
import { keptMailRevenueBytes } from "@/lib/mail-revenue";
import {
  DELIVERY_MAX_BYTES, DELIVERY_WRITE_MAX_BYTES, LOG_SIZE, MESSAGE_TEXT_MAX, QUEUE_KEY, deliveryReadBound, SKIPPED_LINES_PER_DAY, TOO_LARGE_WORDS, addEndpoint, cleanText, deliverDue, emitEvent, recentMessages, resendDelivery,
  setSendHooksForTests, watchStripe, webhooksView,
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
const ACCOUNT = "acct_EventsTest01";

let events: Record<string, unknown>[] = [];
let commands: (string | number)[][] = [];
/** While true, the lease is refused, so a message made is kept untried (attempts 0), as when the try after it never ran. */
let leaseOff = false;
/** Answers the store's delivery log or its sizes broken, as Codex G did on #2192 (C3-124). */
let fault: "partial-sizes" | "empty-sizes" | "null-log" | "text-sizes" | "not-ids" | "one-not-id" | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  const [only] = batch;
  if (fault === "null-log" && batch.length === 1 && only[0] === "LRANGE" && /^nl:hooks:log:/.test(String(only[1]))) return [null];
  // An id that is not one (Codex G on #2192): alone, or among the real ones.
  if ((fault === "not-ids" || fault === "one-not-id") && batch.length === 1 && only[0] === "LRANGE" && /^nl:hooks:log:/.test(String(only[1]))) {
    const [log] = (await pipeline(batch)) as unknown[];
    return [fault === "not-ids" ? ["not-a-delivery-id"] : [...(log as string[]), "not-a-delivery-id"]];
  }
  if (fault && fault !== "null-log" && fault !== "not-ids" && fault !== "one-not-id" && batch.length > 0 && batch.every((c) => c[0] === "STRLEN")) {
    const answers = (await pipeline(batch)) as unknown[];
    return fault === "partial-sizes" ? answers.slice(0, 1) : fault === "empty-sizes" ? [] : answers.map((n, i) => (i === 0 ? "a lot" : n));
  }
  // The webhook queue's lease (lib/webhooks.ts, LEASE_SCRIPT), as Redis runs it and tests/webhooks-delivery.test.ts models it.
  if (batch.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    if (leaseOff) return [0];
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await pipeline([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await pipeline([["ZADD", key, Number(until), member]]);
    return [1];
  }
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

  part("The largest sale the code makes: a bundle of twenty, three checked at checkout, each a bundle of twenty, every title 80 characters of a three-byte script");
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
  is("the message names the bundle and every product checked, each with its own bundle", [sample.data.bundle_items.length, sample.data.order_bumps.length, sample.data.order_bumps.map((b) => b.bundle_items.length)], [20, 3, [20, 20, 20]]);
  is("far past the 4 KB a delivery was priced at", largest > 7 * 4 * 1024, true);
  is("inside the bound a delivery is made under, with the room its tries write later", largest <= DELIVERY_WRITE_MAX_BYTES, true);
  const family = FAMILIES["nl:hooks:d:@lib/webhooks.ts"];
  const priced = family.parts?.find((p) => "per" in p && p.per === "webhook");
  is("the store's data registry prices a delivery at the bound, at or above the largest the code makes", priced && "bytes" in priced ? [priced.bytes === DELIVERY_MAX_BYTES, priced.bytes >= largest] : null, [true, true]);

  part("GET /api/v1/events: measured, set aside, settled at what was read and sent");
  const logBytes = logIds.reduce((n, id) => n + Buffer.byteLength(id), 0);
  const kept = sizes.reduce((a, b) => a + b, 0);
  // Set aside at each delivery's bound (what its tries may still write on it), never less than the measuring alone (Codex G2, #2192).
  const bounds = sizes.map(deliveryReadBound);
  const heldTen = Math.max(apiReadUnits(EVENTS_PROBE_MOST), apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + bounds.reduce((a, b) => a + b, 0), sent: eventsSentMost(bounds, 10) })));
  const reads = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:webhook-deliveries-read");
  let before = await used();
  commands = [];
  const answer = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  const body = (await answer.json()) as { data: unknown[] };
  const sent = Buffer.byteLength(JSON.stringify(body.data));
  const read = commands.filter(reads).reduce((n, c) => n + Number(c[2]), 0);
  const took = (await used()) - before;
  const due = 1 + settledUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent }), heldTen);
  console.log(`  limit=10: ${(logBytes + kept).toLocaleString("en-US")} bytes read, ${sent.toLocaleString("en-US")} sent, ${took} requests taken (priced at 4 KB a delivery it was 5)`);
  is("answered, ten messages", [answer.status, body.data.length], [200, 10]);
  is("every delivery in the log read once", read, LOG_SIZE);
  is("the requests taken are what the bytes read and sent cost, with the door's", took, due);
  is("more than the flat 5 the 4 KB price took for this", took > 5, true);
  is("each delivery measured before any was read", commands.findIndex((c) => c[0] === "STRLEN" && /^nl:hooks:d:/.test(String(c[1]))) < commands.findIndex(reads), true);

  before = await used();
  const one = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=1"));
  const oneBody = (await one.json()) as { data: unknown[] };
  const oneTook = (await used()) - before;
  is("limit=1: one message, settled at the one sent", [one.status, oneBody.data.length, oneTook], [200, 1, 1 + apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent: Buffer.byteLength(JSON.stringify(oneBody.data)) }))]);
  is("and no more than limit=10", oneTook <= took, true);

  before = await used();
  const other = await eventsRead(get(key, "/api/v1/events?type=refund.issued"));
  is("a type none of them is: the deliveries read, nothing sent", [other.status, ((await other.json()) as { data: unknown[] }).data.length, (await used()) - before], [200, 0, 1 + apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: logBytes + kept, sent: 2 }))]);

  part("Too few requests left for what was measured: refused, no delivery read, only the door's request and the measuring kept");
  await leave(heldTen);
  commands = [];
  const refused = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  const words = (await refused.json()) as { error: string; message: string };
  is("refused with the whole count it may take", [refused.status, words.error, words.message.includes(`up to ${(heldTen + 1).toLocaleString("en-US")} of your store's API requests`)], [429, "monthly_limit", true]);
  is("no delivery read", commands.some(reads), false);
  is("only the door's request and the measuring done kept", await used(), allowanceFor(await mine(), "api") - heldTen + 1 + apiReadUnits({ commands: 1 + LOG_SIZE, bytes: logBytes, roundTrips: 2 }));
  await leave(heldTen + 1);
  const fits = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
  is("with exactly what it may take left, answered", fits.status, 200);
  is("and what it did not need given back", await used(), allowanceFor(await mine(), "api") - (heldTen + 1 - due));
  await leave(1_000);

  part("A log or sizes answered broken: unavailable before any delivery is read; the measuring set aside is kept (C3-124, Codex G2)");
  for (const kind of ["partial-sizes", "empty-sizes", "text-sizes", "null-log", "not-ids", "one-not-id"] as const) {
    const was = await used();
    commands = [];
    fault = kind;
    const broken = await eventsRead(get(key, "/api/v1/events?type=sale.completed&limit=10"));
    fault = null;
    const brokenBody = (await broken.json()) as { error?: string; data?: unknown[] };
    is(`${kind}: unavailable, never a list (empty or not), no delivery read, the door's request and the measuring taken`, [broken.status, brokenBody.error, brokenBody.data, commands.some(reads), (await used()) - was], [502, "unavailable", undefined, false, 1 + apiReadUnits(EVENTS_PROBE_MOST)]);
  }

  part("Every text cleaned where the message is made: the worst a text can escape is a quotation mark, four bytes kept");
  is("control characters become a space, a text is cut at its most, a lone surrogate half becomes U+FFFD", [cleanText("a\u0001\u0000b\u007f"), cleanText("x".repeat(MESSAGE_TEXT_MAX + 9)).length, cleanText("\ud800x"), cleanText("\udc00"), cleanText("😀")], ["a b ", MESSAGE_TEXT_MAX, "\ufffdx", "\ufffd", "😀"]);
  // Every free text of the largest sale at its longest, in the character that escapes worst once cleaned, and again in
  // control characters (seven bytes kept each before cleaning): titles at MAX_TITLE_LENGTH, every text the order or Stripe
  // carries (the order's title, its option, its tags, the buyer's name and address) far past MESSAGE_TEXT_MAX.
  const worstSale = async (char: string, n: number) => {
    const made: string[] = [];
    for (let i = 0; i < 84; i += 1) {
      const added = await addProduct(OWNER, `${char.repeat(78)}${String(i).padStart(2, "0")}`, "", "10");
      if (!added.ok) throw new Error(`no synthetic product ${i}`);
      made.push(added.product.id);
    }
    const [own, ...more] = made;
    const long = char.repeat(500);
    const metadata = {
      store: HANDLE, product: own, title: long, option: long, utm_source: long, utm_medium: long, utm_campaign: long, utm_content: long, embed_site: `https://${"a".repeat(60)}.${"b".repeat(60)}.example.com`,
      ...bundleMeta("bundle", more.slice(0, 20)), bump: more[20], bump2: more[21], bump3: more[22],
      ...bundleMeta("bump_bundle", more.slice(23, 43)), ...bundleMeta("bump2_bundle", more.slice(43, 63)), ...bundleMeta("bump3_bundle", more.slice(63, 83)),
    };
    events = [{ id: `evt_Worst${n}`, type: "checkout.session.completed", created: 1_790_001_000 + n, data: { object: { id: `cs_Worst${n}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 99_00, currency: "usd", metadata, customer_details: { email: long, name: long } } } }];
    await watchStripe(Date.now() + 60_000);
    const [id] = await deliveryIds(statsId);
    const [raw, size] = await redis.pipeline([["GET", `nl:hooks:d:${id}`], ["STRLEN", `nl:hooks:d:${id}`]]);
    return { raw: String(raw), size: Number(size) };
  };
  const quotes = await worstSale('"', 1);
  console.log(`  the largest sale with every text at its longest in quotation marks is kept at ${quotes.size.toLocaleString("en-US")} bytes, under ${DELIVERY_WRITE_MAX_BYTES.toLocaleString("en-US")}`);
  is("kept with its message, at three quarters of the bound or less", [JSON.parse(quotes.raw).body.length > 0, quotes.size <= 0.75 * DELIVERY_WRITE_MAX_BYTES], [true, true]);
  const controls = await worstSale("\u0001", 2);
  is("in control characters: kept with its message, none of them escaped (was past 48 KB, every sale not sent)", [JSON.parse(controls.raw).body.length > 0, controls.raw.includes("\\\\u0001"), controls.size < quotes.size], [true, false, true]);

  part("A message past the bound is never kept or sent: its line says so, nothing queued, nothing counted");
  const webhooksBefore = await allowanceUsed(await mine(), "webhook");
  const many = (count: number) => ({ notes: Array.from({ length: count }, () => "x".repeat(MESSAGE_TEXT_MAX)) });
  const queued = await emitEvent(await mine(), "sale.completed", "synthetic-too-large", many(300));
  const [lineId] = await deliveryIds(statsId);
  const [rawLine, score, lineSize] = await redis.pipeline([["GET", `nl:hooks:d:${lineId}`], ["ZSCORE", QUEUE_KEY, `${statsId}|${lineId}`], ["STRLEN", `nl:hooks:d:${lineId}`]]);
  const line = JSON.parse(String(rawLine)) as { body: string; state: string; lastError: string; givenUp?: boolean };
  is("nothing queued", [queued, score], [0, null]);
  is("its line: no message, failed, with the reason and the true figure", [line.body, line.state, line.lastError, line.givenUp, TOO_LARGE_WORDS.includes(`${DELIVERY_WRITE_MAX_BYTES / 1024} KB`)], ["", "failed", TOO_LARGE_WORDS, true, true]);
  is("kept small", Number(lineSize) < 2 * 1024, true);
  is("the studio's log shows it, without a way to send it again", [(await webhooksView(await mine())).log[0].lastError, (await resendDelivery(await mine(), lineId)).ok], [TOO_LARGE_WORDS, false]);
  is("no webhook delivery of the month taken", (await allowanceUsed(await mine(), "webhook")) - webhooksBefore, 0);
  const fitting = await emitEvent(await mine(), "sale.completed", "synthetic-fits", many(Math.floor((DELIVERY_WRITE_MAX_BYTES - 3_000) / (MESSAGE_TEXT_MAX + 6))));
  is("a message just inside the bound is queued as always", fitting, 1);
  is("the studio's webhooks and the developers page say the bounds, from the code's figures", [
    readFileSync("components/webhook-editor.tsx", "utf8").includes("Each text in a message is at most ${MESSAGE_TEXT_MAX} characters, with control characters turned into spaces, and a message takes at most ${DELIVERY_WRITE_MAX_BYTES / 1024} KB to keep."),
    readFileSync("app/developers/page.tsx", "utf8").includes("a webhook message takes at most ${DELIVERY_WRITE_MAX_BYTES / 1024} KB to keep, each text in it at most ${MESSAGE_TEXT_MAX} characters"),
  ], [true, true]);
  for (let i = 0; i < SKIPPED_LINES_PER_DAY + 2; i += 1) await emitEvent(await mine(), "sale.completed", `synthetic-too-large-${i}`, many(300));
  const day = (await webhooksView(await mine())).log.filter((d) => d.lastError === TOO_LARGE_WORDS || / more messages? on .* were too large to send/.test(d.lastError));
  is("a day's lines are bounded: SKIPPED_LINES_PER_DAY of their own, then one line that counts the rest", [day.filter((d) => d.lastError === TOO_LARGE_WORDS).length, day.filter((d) => d.lastError.startsWith("3 more messages on ")).length], [SKIPPED_LINES_PER_DAY, 1]);

  part("A failed delivery kept before the bound, larger than it, is not sent again by hand");
  const endpointId = JSON.parse(String((await redis.pipeline([["GET", `nl:hooks:cfg:${statsId}`]]))[0])).endpoints[0].id as string;
  const oldId = `dlv_${"a".repeat(24)}`;
  await redis.pipeline([
    ["SET", `nl:hooks:d:${oldId}`, JSON.stringify({ id: oldId, statsId, endpoint: endpointId, eventId: "evt_OldLarge", type: "sale.completed", body: JSON.stringify({ note: "x".repeat(DELIVERY_MAX_BYTES) }), attempts: 7, state: "failed", next: 0, lastStatus: 500, lastError: "Answered 500.", lastAt: 1, createdAt: 1 }), "EX", 3_600],
    ["LPUSH", `nl:hooks:log:${statsId}`, oldId],
  ]);
  const again = await resendDelivery(await mine(), oldId);
  is("refused with the reason, nothing sent or counted", [again.ok, again.ok ? null : again.reason, (await allowanceUsed(await mine(), "webhook")) - webhooksBefore], [false, "too_large", 1]);

  part("The order's own title stands in only for its own product when a listing is gone");
  events = [sale(900, { product: "p_gone_main", bump: "p_gone_bump", bump2: "", bump3: "", ...bundleMeta("bundle", ["p_gone_b1"]), ...bundleMeta("bump_bundle", ["p_gone_b2"]), title: "The order's own title" })];
  await watchStripe(Date.now() + 60_000);
  const gone = (await recentMessages(await mine(), "sale.completed", 10)).find((m) => (m.data as { checkout_session: string }).checkout_session === "cs_BigSale900")!.data as {
    product: { title: string | null }; bundle_items: { title: string | null }[]; order_bump: { title: string | null; bundle_items: { title: string | null }[] };
  };
  is("its own product: the order's title; a bundle's product or one checked: none", [gone.product.title, gone.bundle_items[0].title, gone.order_bump.title, gone.order_bump.bundle_items[0].title], ["The order's own title", null, null, null]);

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

  part("The month's webhook deliveries used: no message kept or sent, a line that says so, bounded by the day");
  {
    const store = await mine();
    const read = async (id: string) => JSON.parse(String((await redis.pipeline([["GET", `nl:hooks:d:${id}`]]))[0])) as { body: string; state: string; attempts: number; givenUp?: boolean; lastError: string };
    // One counted at its first try (it failed and waits to be tried again), one never tried.
    const counted = await emitEvent(store, "sale.completed", "synthetic-counted", { amount_cents: 100 });
    const [countedId] = await deliveryIds(statsId);
    leaseOff = true;
    const waiting = await emitEvent(store, "sale.completed", "synthetic-before-used", { amount_cents: 100 });
    leaseOff = false;
    const [waitingId] = await deliveryIds(statsId);
    is("messages made while deliveries are left are kept: one tried and counted, one not tried yet", [counted, waiting, (await read(countedId)).attempts, (await read(waitingId)).attempts, (await read(waitingId)).body.length > 0], [1, 1, 1, 0, true]);
    for (;;) if (!(await takeAllowance(store, "webhook")).ok) break;
    const tried = await deliverDue(Date.now() + 10_000, Date.now() + 10 * 60_000);
    const after = await read(waitingId);
    is("not tried before the month was used: not sent, and its message not kept past it", [tried.tried >= 2, after.state, after.body, after.givenUp, after.lastError.startsWith("Not sent. Your webhook deliveries for this month are used")], [true, "failed", "", true, true]);
    const kept = await read(countedId);
    is("counted at its first try: not sent again, but its message kept, to be sent again by hand", [kept.state, kept.body.length > 0, kept.givenUp, kept.lastError.startsWith("Not sent. Your webhook deliveries for this month are used")], ["failed", true, undefined, true]);
    for (let i = 0; i < SKIPPED_LINES_PER_DAY + 3; i += 1) is(`made with the month used ${i}: nothing queued`, await emitEvent(store, "sale.completed", `synthetic-used-${i}`, { amount_cents: 100 }), 0);
    const log = (await webhooksView(store)).log;
    // Every delivery tried once the month was used is not kept either (above); the lines of messages made since have no try.
    const own = log.filter((d) => d.lastError.startsWith("Not sent. Your webhook deliveries for this month are used") && d.state === "failed" && d.attempts === 0 && d.id !== waitingId);
    const rest = log.filter((d) => /^3 more messages on .* were not sent because your store's webhook deliveries for this month are used/.test(d.lastError));
    is("SKIPPED_LINES_PER_DAY lines of their own, then one line that counts the rest", [own.length, rest.length], [SKIPPED_LINES_PER_DAY, 1]);
    const bodies = (await redis.pipeline(own.map((d) => ["GET", `nl:hooks:d:${d.id}`]))).map((raw) => (JSON.parse(String(raw)) as { body: string }).body);
    is("no message kept behind any of them", bodies.every((b) => b === ""), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
