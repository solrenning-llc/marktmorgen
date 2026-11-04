/**
 * What one opening of a buyer's orders page takes from its store before it
 * reads (lib/buyer-orders.ts, openOrders and OrdersMeter; C3-77, MR, 4
 * November 2026): ORDERS_OPEN_UNITS of the store's buyer requests before the
 * link's grant is read, and, past them, requests in proportion to what the
 * buyer has, each taken before its read. A refused opening reads nothing.
 * tests/plan-cost-registry.test.ts holds the units above what they stand for.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import {
  MAX_LISTED,
  ORDERS_LISTING_COMMANDS,
  ORDERS_OPEN_COMMANDS,
  ORDERS_CALL_MOVES,
  ORDERS_IMPORTED_COMMANDS,
  ORDERS_IMPORTED_ENTRY_COMMANDS,
  ORDERS_OPEN_SECONDS,
  ORDERS_OPEN_UNITS,
  ORDERS_PREORDER_COMMANDS,
  ORDERS_READ_MS,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
  DOWNLOAD_LOOKUP_UNITS,
  ORDERS_LINK_READ_MS,
  OrdersBusy,
  OrdersLate,
  OrdersMeter,
  callsFor,
  findPurchase,
  openOrders,
  ordersLinkFor,
  purchasesFor,
  requestOrdersLink,
  withinOpening,
} from "@/lib/buyer-orders";
import { importedKey, importedReference } from "@/lib/imported-purchases";
import { requestLimitFor } from "@/lib/traffic-rules";
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { GET as downloadRoute } from "@/app/api/store/download/route";
import { POST as ordersRoute } from "@/app/api/store/orders/route";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { REDIS_TIMEOUT_MS, RESEND_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { WAITING_SHOWN } from "@/lib/buyer-waiting";
import { requestsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import type { CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";

const OWNER = "olive@example.com";
const BUYER = "ana@example.com";
const HOUR = 3_600_000;
let sessions: Record<string, unknown>[] = [];
/** Payments taken in one click after a checkout (lib/upsell.ts). */
let intents: Record<string, unknown>[] = [];
/** Every call asked of Stripe (or any other service) from here on. */
let asked = 0;
/** The paths asked of Stripe from here on. */
const paths: string[] = [];
/** Emails handed to the sender from here on. */
let mails = 0;
/** Stripe, or the sender, failing every call. */
let stripeFails = false;
let senderFails = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  asked += 1;
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (url.hostname === "api.stripe.com") paths.push(path);
  if (url.hostname === "api.stripe.com" && stripeFails) return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 });
  if (url.hostname.includes("resend")) {
    mails += 1;
    if (senderFails) return new Response(JSON.stringify({ message: "daily quota exceeded" }), { status: 429 });
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  // What was taken in one click for a customer, as the list reads it.
  if (path === "/payment_intents") return answer({ object: "list", data: intents.filter((intent) => intent.customer === url.searchParams.get("customer")), has_more: false });
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "GET") return answer({ object: "list", data: sessions, has_more: false });
  // One checkout or one payment by its id, as the download reads it.
  const one = path.match(/^\/(checkout\/sessions|payment_intents)\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = [...sessions, ...intents].find((row) => row.id === one[2]);
    return found ? answer(found) : new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** Every command the store is sent from here on. */
const sent: string[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String).join(" "));
  return pipeline(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  sessions = [];
  sent.length = 0;
  asked = 0;
  intents = [];
  paths.length = 0;
  mails = 0;
  stripeFails = false;
  senderFails = false;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_only_a_stand_in";
  // A sender, so the link can be asked for (lib/buyer-orders.ts, canRecover); what it sends goes to the stand-in fetch above.
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function callStore(video = false): Promise<{ store: Store; product: string; folder: string; window: string }> {
  await claimHandle(OWNER, "olive", "Olive Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestOlive00001", true);
  await setSubscription(OWNER, { customerId: "cus_olive00001", subscriptionId: "sub_olive00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "80", null);
  if (!made.ok) throw new Error("no product");
  const weekly = { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: video ? null : "https://example.com/room", video, meet: null };
  await setProductCall(OWNER, made.product.id, weekly as unknown as CallSetup);
  const store = { ...((await storeForEmail(OWNER)) as Store), callsId: "c".repeat(32) };
  return { store, product: made.product.id, folder: await storeFolder(OWNER), window: allowanceWindow(store)!.id };
}

/** Bookings this buyer paid for, each an hour long, the first tomorrow. */
function bookings(product: string, count: number): Record<string, unknown>[] {
  const first = Date.now() + 24 * HOUR;
  return Array.from({ length: count }, (_, i) => ({
    id: `cs_test_${String(i).padStart(24, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000) - i,
    metadata: { kind: "call", store: "olive", product, start: String(first + i * 2 * HOUR), end: String(first + i * 2 * HOUR + HOUR), tz: "America/New_York" },
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_test${String(i).padStart(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }));
}

test("an opening with a link takes ORDERS_OPEN_UNITS of the store's buyer requests, then reads its grant", async () => {
  const { store, folder, window } = await callStore();
  const link = (await ordersLinkFor(store, BUYER, "https://marktmorgen.com/@olive"))!;
  const token = new URL(link).searchParams.get("token")!;
  const before = await requestsIn(folder, window);
  const opened = await openOrders(store, token);
  assert.deepEqual([opened.admitted, opened.email], [true, BUYER]);
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS);
});

test("an opening the store has no room for reads nothing, not even its grant", async () => {
  const { store } = await callStore();
  const link = (await ordersLinkFor(store, BUYER, "https://marktmorgen.com/@olive"))!;
  const token = new URL(link).searchParams.get("token")!;
  sent.length = 0;
  // A paying store whose month is not known answers nothing that costs (lib/traffic.ts).
  const opened = await openOrders({ ...store, period: null }, token);
  assert.deepEqual([opened.admitted, opened.email], [false, null]);
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:")), []);
});

test("a token not shaped like one takes nothing and reads nothing", async () => {
  const { store, folder, window } = await callStore();
  sent.length = 0;
  const opened = await openOrders(store, "not-a-token");
  assert.deepEqual([opened.admitted, opened.email, await requestsIn(folder, window)], [true, null, 0]);
  assert.deepEqual(sent.filter((command) => !command.startsWith("GET nl:traffic") && !command.includes(":requests:")), []);
});

test("an opening with forty bookings takes the most moves first, and pays their listing and video rooms from what the moves left", async () => {
  const { store, product, folder, window } = await callStore(true);
  sessions = bookings(product, MAX_LISTED);
  const link = (await ordersLinkFor(store, BUYER, "https://marktmorgen.com/@olive"))!;
  const opened = await openOrders(store, new URL(link).searchParams.get("token")!);
  sent.length = 0;
  const calls = await callsFor(store, BUYER, opened.meter);
  assert.equal(calls.length, MAX_LISTED);
  assert.ok(calls.every((call) => call.room), "each booking was given its room");
  // Each booking's move, the product's listing, and each room: four reads, and a video room made and read back.
  const rooms = sent.filter((command) => command.includes("nl:call:room:") || command.includes("nl:meet:r:")).length;
  assert.ok(rooms > 4 * MAX_LISTED && rooms <= ORDERS_ROOM_COMMANDS * MAX_LISTED, String(rooms));
  // ORDERS_CALL_MOVES taken before any booking is read; the forty moves, the listing and the rooms fit in it.
  assert.ok(MAX_LISTED + ORDERS_LISTING_COMMANDS + MAX_LISTED * ORDERS_ROOM_COMMANDS <= ORDERS_CALL_MOVES);
  const units = Math.ceil(ORDERS_CALL_MOVES / ORDERS_UNIT_COMMANDS);
  assert.equal(opened.meter.taken, units);
  assert.equal(await requestsIn(folder, window), ORDERS_OPEN_UNITS + units);
});

test("an opening at a store that sells calls takes the moves up front, and nothing more until what they left is used", async () => {
  const { store, product } = await callStore(true);
  sessions = bookings(product, 2);
  const meter = new OrdersMeter(store);
  assert.equal((await callsFor(store, BUYER, meter)).length, 2);
  const upFront = Math.ceil(ORDERS_CALL_MOVES / ORDERS_UNIT_COMMANDS);
  assert.equal(meter.taken, upFront);
  // What the two moves, the listing and the two rooms left pays the opening's next reads (feeds, keys, listings).
  const left = upFront * ORDERS_UNIT_COMMANDS - (2 + ORDERS_LISTING_COMMANDS + 2 * ORDERS_ROOM_COMMANDS);
  await meter.take(left);
  assert.equal(meter.taken, upFront);
  await meter.take(1);
  assert.equal(meter.taken, upFront + 1);
});

test("the opening's other reads wait for the bookings' count and use what the moves left, never asking the store meanwhile", async () => {
  const { store, product } = await callStore(true);
  sessions = bookings(product, 2);
  const meter = new OrdersMeter(store);
  const upFront = Math.ceil(ORDERS_CALL_MOVES / ORDERS_UNIT_COMMANDS);
  // Started together, as the page does: purchases' reads asked for while the bookings are still being read.
  const left = upFront * ORDERS_UNIT_COMMANDS - (2 + ORDERS_LISTING_COMMANDS + 2 * ORDERS_ROOM_COMMANDS);
  const [calls] = await Promise.all([callsFor(store, BUYER, meter), meter.take(left - 100), meter.take(100)]);
  assert.equal(calls.length, 2);
  assert.equal(meter.taken, upFront, "paid from what the moves left, not from new requests");
});

test("a read that uses more than the most taken before it pays the rest before anything after it", async () => {
  const { store } = await callStore();
  const meter = new OrdersMeter(store);
  const read = await meter.takeFor(ORDERS_UNIT_COMMANDS, async () => 3 * ORDERS_UNIT_COMMANDS, (n) => n);
  assert.equal(read, 3 * ORDERS_UNIT_COMMANDS);
  assert.equal(meter.taken, 3);
  await meter.take(1);
  assert.equal(meter.taken, 4);
});

test("a meter the store has no room for reads none of the bookings, not even their moves", async () => {
  const { store, product } = await callStore();
  sessions = bookings(product, MAX_LISTED);
  const refused = { ...store, period: null };
  sent.length = 0;
  await assert.rejects(callsFor(refused, BUYER, new OrdersMeter(refused)), OrdersBusy);
  const bookingReads = (command: string) => /nl:call:|nl:catalog:[^ ]*:l:|nl:meet:/.test(command);
  assert.deepEqual(sent.filter(bookingReads), []);
  // Read without a meter (the other readers of bookings), the same store reads them all.
  assert.equal((await callsFor(store, BUYER)).length, MAX_LISTED);
  assert.ok(sent.filter(bookingReads).length >= MAX_LISTED * 5, String(sent.filter(bookingReads).length));
});

test("the moves taken before a store's bookings are read cover every booking its pages can hold", () => {
  // lib/calls.ts reads at most MAX_PAGES pages of a hundred checkouts and every booking's move on them (withMoves).
  const calls = readFileSync("lib/calls.ts", "utf8");
  const pages = Number(/const MAX_PAGES = (\d+);/.exec(calls)?.[1]);
  const perPage = Number(/\/checkout\/sessions\?limit=(\d+)&status=complete/.exec(calls)?.[1]);
  assert.ok(pages > 0 && perPage > 0 && pages * perPage <= ORDERS_CALL_MOVES, `${pages} x ${perPage} > ${ORDERS_CALL_MOVES}`);
});

test("a meter's takes run one after another, and a refusal is kept: nothing more is taken or read", async () => {
  const { store, folder, window } = await callStore();
  const meter = new OrdersMeter(store);
  await Promise.all(Array.from({ length: 10 }, () => meter.take(10)));
  assert.equal(meter.taken, Math.ceil(100 / ORDERS_UNIT_COMMANDS));
  assert.equal(await requestsIn(folder, window), Math.ceil(100 / ORDERS_UNIT_COMMANDS));
  const refused = new OrdersMeter({ ...store, period: null });
  await assert.rejects(refused.take(1), OrdersBusy);
  sent.length = 0;
  await assert.rejects(refused.take(1), OrdersBusy);
  assert.throws(() => refused.alive(), OrdersBusy);
  assert.deepEqual(sent, [], "a meter already refused asks the store nothing");
});

test("an opening waits ORDERS_READ_MS at the most, inside the page's maxDuration, and then reads nothing more", async () => {
  assert.ok(ORDERS_READ_MS < ORDERS_OPEN_SECONDS * 1000 - 3_000);
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  assert.ok(page.includes(`export const maxDuration = ${ORDERS_OPEN_SECONDS};`));
  assert.ok(page.includes("const outcome = await withinOpening(reading, meter);") && page.includes('if (outcome === "late") failed = true;'));
  const { store } = await callStore();
  const meter = new OrdersMeter(store);
  assert.equal(await withinOpening(Promise.resolve("read"), meter, 50), "read");
  meter.alive();
  // A Stripe that does not answer: the opening is said as not read, and the meter stops what was still to come.
  const never = new Promise<string>(() => {});
  assert.equal(await withinOpening(never, meter, 20), "late");
  assert.throws(() => meter.alive(), OrdersLate);
  await assert.rejects(meter.take(1), OrdersLate);
  // A reading that fails is its own failure, never "late".
  await assert.rejects(withinOpening(Promise.reject(new Error("stripe")), new OrdersMeter(store), 50), /stripe/);
});

test("purchases take their listings, pre-orders and what was brought over before each is read", async () => {
  const OWNER2 = "fern@example.com";
  await claimHandle(OWNER2, "fern", "Fern Press", "");
  await ensureStatsId(OWNER2);
  await setStripeAccount(OWNER2, "acct_1TestFern000001", true);
  await setSubscription(OWNER2, { customerId: "cus_fern000001", subscriptionId: "sub_fern000001", active: true, tier: "creator", period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const title of ["Guide", "Templates", "Checklist", "Workbook", "Planner", "Archive"]) {
    const made = await addProduct(OWNER2, title, "", "19", null);
    if (!made.ok) throw new Error(`no ${title}`);
    ids[title] = made.product.id;
    await setProductLink(OWNER2, made.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  const shop = (await storeForEmail(OWNER2)) as Store;
  const store = { ...shop, pastBuyers: true };
  const paid = (id: string, metadata: Record<string, string>) => ({
    id: `cs_test_${id.padEnd(24, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000),
    metadata: { store: "fern", ...metadata },
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_test${id.padEnd(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  });
  sessions = [
    // A guide with a bundle of two inside and a box checked at checkout: four listings.
    paid("a", { product: ids.Guide, bundle: `${ids.Templates},${ids.Checklist}`, bump: ids.Workbook }),
    // A pre-order: its listing, and its entry and when it ships.
    paid("b", { product: ids.Planner, preorder: "1" }),
  ];
  await redis.pipeline([["HSET", importedKey(store.statsId!, BUYER), ids.Archive, JSON.stringify({ at: 1, job: "api:1" }), ids.Guide, JSON.stringify({ at: 1, job: "api:2" })]]);
  const meter = new OrdersMeter(store);
  const purchases = await purchasesFor(store, BUYER, meter);
  assert.ok(purchases.length >= 3, String(purchases.length));
  // Six listings (the Guide once, though bought and brought over), the pre-order's reads, and the two entries brought over.
  const commands = 6 * ORDERS_LISTING_COMMANDS + ORDERS_PREORDER_COMMANDS + ORDERS_IMPORTED_COMMANDS + 2 * ORDERS_IMPORTED_ENTRY_COMMANDS;
  assert.equal(meter.taken, Math.ceil(commands / ORDERS_UNIT_COMMANDS));
  // The store with no room reads none of them.
  const refused = { ...store, period: null };
  sent.length = 0;
  await assert.rejects(purchasesFor(refused, BUYER, new OrdersMeter(refused)), OrdersBusy);
  assert.deepEqual(sent.filter((command) => command.includes(":l:") || command.includes("nl:imp:buy:") || command.includes("nl:pre")), []);
});

test("the commands every opening makes are inside ORDERS_OPEN_COMMANDS", () => {
  // The grant; what waits, four and one an agreement shown (lib/buyer-waiting.ts); the Discord server and its roles.
  assert.ok(ORDERS_OPEN_COMMANDS >= 1 + 4 + WAITING_SHOWN + 2);
});

const ORIGIN = "https://marktmorgen.com";

/** Runs what a link request left for after its answer (lib/buyer-orders.ts, afterAnswer), as the route's after() does. */
async function afterAnswers(): Promise<void> {
  for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
}

/** A link request and what it does after its answer. */
async function askLink(input: Parameters<typeof requestOrdersLink>[0]): ReturnType<typeof requestOrdersLink> {
  const answer = await requestOrdersLink(input);
  await afterAnswers();
  return answer;
}

test("a link request takes ORDERS_OPEN_UNITS after its limits, and its fixed commands are inside an opening's", async () => {
  const { store, folder, window } = await callStore();
  const before = await requestsIn(folder, window);
  sent.length = 0;
  assert.equal(await askLink({ store, email: "nobody@example.com", ip: "203.0.113.1", origin: ORIGIN }), "sent");
  // A store that sells calls also takes the most moves up front, whatever the address, as an opening does.
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS + Math.ceil(ORDERS_CALL_MOVES / ORDERS_UNIT_COMMANDS));
  // Its two limits (a write and a count each); nothing bought, so no grant is written.
  const fixed = sent.filter((command) => command.includes("nl:rl:orders:") || command.includes("nl:orders:link:"));
  assert.equal(fixed.length, 4);
  assert.ok(fixed.length + 1 <= ORDERS_OPEN_COMMANDS);
  // It runs no longer than an opening, whose units it takes.
  assert.ok(readFileSync("app/api/store/orders/route.ts", "utf8").includes(`export const maxDuration = ${ORDERS_OPEN_SECONDS};`));
});

test("a link request for forty bookings takes, past its units, the moves an opening takes up front, which hold their listing and rooms", async () => {
  const { store, product, folder, window } = await callStore(true);
  sessions = bookings(product, MAX_LISTED);
  const before = await requestsIn(folder, window);
  await askLink({ store, email: BUYER, ip: "203.0.113.2", origin: ORIGIN });
  // The moves taken up front hold the forty moves, the listing and the rooms, as for an opening.
  assert.ok(MAX_LISTED + ORDERS_LISTING_COMMANDS + MAX_LISTED * ORDERS_ROOM_COMMANDS <= ORDERS_CALL_MOVES);
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS + Math.ceil(ORDERS_CALL_MOVES / ORDERS_UNIT_COMMANDS));
});

test("a link request the store has no room for asks Stripe nothing, and the per-address limit still holds", async () => {
  const { store, product, folder, window } = await callStore();
  sessions = bookings(product, 2);
  const refused = { ...store, period: null };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await askLink({ store: refused, email: BUYER, ip: `203.0.113.${10 + i}`, origin: ORIGIN }), "busy");
  }
  assert.equal(asked, 0, "nothing was asked of Stripe");
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:") || command.includes("nl:call:")), []);
  // The sixth from the same address is limited before it takes anything, even from a store with room.
  const before = await requestsIn(folder, window);
  assert.equal(await askLink({ store, email: BUYER, ip: "203.0.113.99", origin: ORIGIN }), "limited");
  assert.deepEqual([asked, (await requestsIn(folder, window)) - before], [0, 0]);
  // The route answers a refusal as it answers a store with no room at all.
  const route = readFileSync("app/api/store/orders/route.ts", "utf8");
  assert.ok(route.includes('if (result === "busy") return tooMany();') && route.includes("if (!(await takePublicRequest(store, \"buyer\"))) return tooMany();"));
});

/** A store selling links, with one paid checkout of BUYER per product, and its link to the list. */
async function linkStore(titles = ["Field notes"]): Promise<{ store: Store; ids: string[]; refs: string[]; token: string; folder: string; window: string }> {
  const OWNER3 = "moss@example.com";
  await claimHandle(OWNER3, "moss", "Moss Notes", "");
  await ensureStatsId(OWNER3);
  await setStripeAccount(OWNER3, "acct_1TestMoss000001", true);
  await setSubscription(OWNER3, { customerId: "cus_moss000001", subscriptionId: "sub_moss000001", active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (const title of titles) {
    const made = await addProduct(OWNER3, title, "", "19", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER3, made.product.id, "https://example.com/notes");
    ids.push(made.product.id);
  }
  const store = (await storeForEmail(OWNER3)) as Store;
  const refs = ids.map((_, i) => `cs_test_${String(i).padStart(24, "m")}`);
  sessions = ids.map((product, i) => ({
    id: refs[i],
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000) - i,
    customer: "cus_buyer00001",
    metadata: { store: "moss", product },
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_testmoss${String(i).padStart(6, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }));
  const token = new URL((await ordersLinkFor(store, BUYER, `${ORIGIN}/@moss`))!).searchParams.get("token")!;
  return { store, ids, refs, token, folder: await storeFolder(OWNER3), window: allowanceWindow(store)!.id };
}

test("a download reads only its own checkout: DOWNLOAD_LOOKUP_UNITS before the grant and its listing, never the list", async () => {
  // Twenty purchases on the list: one download still reads one checkout and one listing.
  const { store, refs, token, folder, window } = await linkStore(Array.from({ length: 20 }, (_, i) => `Notes ${i + 1}`));
  const before = await requestsIn(folder, window);
  const found = await findPurchase(store, token, refs[7]);
  assert.deepEqual([found?.purchase.reference, found?.email], [refs[7], BUYER]);
  assert.deepEqual(paths, [`/checkout/sessions/${refs[7]}`]);
  assert.equal((await requestsIn(folder, window)) - before, DOWNLOAD_LOOKUP_UNITS + Math.ceil(ORDERS_LISTING_COMMANDS / ORDERS_UNIT_COMMANDS));
  // A file each of the twenty costs twenty of those, far under what one opening of the list costs each.
  assert.ok(DOWNLOAD_LOOKUP_UNITS + 1 < ORDERS_OPEN_UNITS / 3);
});

test("a download refuses a checkout paid with another address, unpaid or not found, before reading its listing", async () => {
  const { store, refs, token } = await linkStore();
  sessions[0] = { ...sessions[0], customer_details: { email: "someone@example.com" } };
  sent.length = 0;
  assert.equal(await findPurchase(store, token, refs[0]), null);
  assert.deepEqual(sent.filter((command) => command.includes(":l:")), [], "no listing read");
  sessions[0] = { ...sessions[0], customer_details: { email: BUYER }, status: "open" };
  assert.equal(await findPurchase(store, token, refs[0]), null);
  assert.equal(await findPurchase(store, token, `cs_test_${"z".repeat(24)}`), null);
  // The address as typed at checkout, in other capitals, is the same address.
  sessions[0] = { ...sessions[0], status: "complete", customer_details: { email: "Ana@Example.com" } };
  assert.equal((await findPurchase(store, token, refs[0]))?.purchase.reference, refs[0]);
});

test("a download of what was taken in one click reads that payment and the checkout it followed, and only for its customer", async () => {
  const { store, ids, refs, token } = await linkStore();
  const upsell = (customer: string) => ({
    id: "pi_testupsell000001",
    object: "payment_intent",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
    customer,
    metadata: { kind: "upsell", store: "moss", product: ids[0], parent: refs[0] },
    latest_charge: { refunded: false, amount_refunded: 0 },
  });
  intents = [upsell("cus_buyer00001")];
  const found = await findPurchase(store, token, "pi_testupsell000001");
  assert.deepEqual([found?.purchase.kind, paths], ["upsell", ["/payment_intents/pi_testupsell000001", `/checkout/sessions/${refs[0]}`]]);
  intents = [upsell("cus_someone0001")];
  assert.equal(await findPurchase(store, token, "pi_testupsell000001"), null);
});

test("a download in one click is refused where the list would not read it: the checkout it followed refunded, a gift, a place, a call, a package, a pre-order, another store's, unpaid, or its product gone", async () => {
  const { store, ids, refs, token } = await linkStore();
  intents = [{
    id: "pi_testupsell000001",
    object: "payment_intent",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
    customer: "cus_buyer00001",
    metadata: { kind: "upsell", store: "moss", product: ids[0], parent: refs[0] },
    latest_charge: { refunded: false, amount_refunded: 0 },
  }];
  const parent = sessions[0] as Record<string, unknown> & { metadata: Record<string, string> };
  assert.equal((await findPurchase(store, token, "pi_testupsell000001"))?.purchase.kind, "upsell");
  const variants: [string, Record<string, unknown>][] = [
    ["refunded", { payment_intent: { id: "pi_testmoss000000", status: "succeeded", latest_charge: { refunded: true, amount_refunded: 1900 } } }],
    ["a gift", { metadata: { ...parent.metadata, gift: "1" } }],
    ["a place", { metadata: { ...parent.metadata, group: "1" } }],
    ["a call", { metadata: { ...parent.metadata, kind: "call" } }],
    ["a package", { metadata: { ...parent.metadata, kind: "package" } }],
    ["a pre-order", { metadata: { ...parent.metadata, preorder: "1" } }],
    ["another store's", { metadata: { ...parent.metadata, store: "elsewhere" } }],
    ["unpaid", { payment_status: "unpaid" }],
    ["its product gone", { metadata: { ...parent.metadata, product: "gone000001" } }],
  ];
  for (const [what, change] of variants) {
    sessions[0] = { ...parent, ...change };
    assert.equal(await findPurchase(store, token, "pi_testupsell000001"), null, what);
  }
});

test("a download in one click is handed over exactly when the list shows it", async () => {
  const { ids, refs, token } = await linkStore(["Guide", "Gift card"]);
  // A product that hands nothing over: a checkout of it alone is not on the list, so neither is what followed it.
  const bare = await addProduct("moss@example.com", "Talk", "", "19", null);
  if (!bare.ok) throw new Error("no product");
  const shop = (await storeForEmail("moss@example.com")) as Store;
  intents = [{
    id: "pi_testupsell000001",
    object: "payment_intent",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
    customer: "cus_buyer00001",
    metadata: { kind: "upsell", store: "moss", product: ids[1], parent: refs[0] },
    latest_charge: { refunded: false, amount_refunded: 0 },
  }];
  sessions = [sessions[0]];
  const parent = sessions[0] as Record<string, unknown> & { metadata: Record<string, string> };
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["a checkout the list hands over", {}, true],
    ["a checkout given back", { payment_intent: { id: "pi_testmoss000000", status: "succeeded", latest_charge: { refunded: true, amount_refunded: 1900 } } }, false],
    ["a checkout of something that hands nothing over", { metadata: { ...parent.metadata, product: bare.product.id } }, false],
    ["a checkout with something checked that hands over", { metadata: { ...parent.metadata, product: bare.product.id, bump: ids[0] } }, true],
    ["a checkout without a customer", { customer: null }, false],
  ];
  for (const [what, change, shown] of cases) {
    sessions[0] = { ...parent, ...change };
    const listed = (await purchasesFor(shop, BUYER)).some((p) => p.reference === "pi_testupsell000001");
    const given = Boolean(await findPurchase(shop, token, "pi_testupsell000001"));
    assert.deepEqual([listed, given], [shown, shown], what);
  }
});

test("a product of a bundle costs its lookup and two listings, whatever the bundle holds, and is read once", async () => {
  const { store, ids, refs, token, folder, window } = await linkStore(Array.from({ length: 21 }, (_, i) => (i === 0 ? "Kit" : `Part ${i}`)));
  sessions[0] = { ...sessions[0], metadata: { store: "moss", product: ids[0], bundle: ids.slice(1).join(",") } };
  const before = await requestsIn(folder, window);
  const found = await findPurchase(store, token, refs[0], { pid: ids[5] });
  assert.deepEqual(found?.purchase.items?.lines.map((line) => line.productId), [ids[5]]);
  assert.equal((await requestsIn(folder, window)) - before, DOWNLOAD_LOOKUP_UNITS + Math.ceil((2 * ORDERS_LISTING_COMMANDS) / ORDERS_UNIT_COMMANDS));
  // The route hands it over from what was read: nothing more is taken or read for it, and nothing else is read at all.
  const at = await requestsIn(folder, window);
  assert.equal((await found!.listing(ids[5]))?.id, ids[5]);
  assert.equal((await found!.listing(ids[0]))?.id, ids[0]);
  assert.equal(await found!.listing(ids[6]), null);
  assert.equal((await requestsIn(folder, window)) - at, 0);
  // One not on the order's own list is refused before any listing is read.
  sent.length = 0;
  assert.equal(await findPurchase(store, token, refs[0], { pid: ids[0] }), null);
  assert.equal(await findPurchase(store, token, refs[0], { pid: "elsewhere1" }), null);
  assert.deepEqual(sent.filter((command) => command.includes(":l:")), []);
});

test("a product checked at checkout is read with the one bought and no other; a key the order does not hold is refused", async () => {
  const { store, ids, refs, token, folder, window } = await linkStore(["Course", "Workbook", "Extra"]);
  sessions[0] = { ...sessions[0], metadata: { store: "moss", product: ids[0], bump: ids[1], bump2: ids[2] } };
  const before = await requestsIn(folder, window);
  const found = await findPurchase(store, token, refs[0], { item: "bump" });
  assert.deepEqual(found?.purchase.added.map((added) => added.id), [ids[1]]);
  assert.equal((await requestsIn(folder, window)) - before, DOWNLOAD_LOOKUP_UNITS + 1);
  assert.equal(await findPurchase(store, token, refs[0], { item: "bump3" }), null);
});

test("a download of what was brought over reads its ids and that one entry, each id taken first", async () => {
  const { store, ids, token, folder, window } = await linkStore(["Guide", "Archive", "Planner"]);
  const shop = { ...store, pastBuyers: true };
  sessions = [];
  await redis.pipeline([["HSET", importedKey(shop.statsId!, BUYER), ids[0], JSON.stringify({ at: 1, job: "api:1" }), ids[1], JSON.stringify({ at: 2, job: "api:2" }), ids[2], JSON.stringify({ at: 3, job: "api:3" })]]);
  const reference = importedReference(shop.statsId!, BUYER, ids[1]);
  const before = await requestsIn(folder, window);
  sent.length = 0;
  const found = await findPurchase(shop, token, reference);
  assert.deepEqual([found?.purchase.productId, found?.purchase.kind, paths], [ids[1], "imported", []]);
  assert.ok(!sent.some((command) => command.startsWith("HGETALL")), "never the whole record");
  assert.equal((await requestsIn(folder, window)) - before, DOWNLOAD_LOOKUP_UNITS + Math.ceil((3 + ORDERS_LISTING_COMMANDS) / ORDERS_UNIT_COMMANDS));
});

test("a download the store has no room for reads nothing; a token or a reference not shaped like one takes nothing", async () => {
  const { store, refs, token, folder, window } = await linkStore();
  asked = 0;
  sent.length = 0;
  // Its grant is read under the download's own request; past it, nothing: no Stripe, no listing.
  await assert.rejects(findPurchase({ ...store, period: null }, token, refs[0]), OrdersBusy);
  assert.equal(asked, 0);
  assert.deepEqual(sent.filter((command) => command.includes(":l:")), []);
  const at = await requestsIn(folder, window);
  assert.equal(await findPurchase(store, "not-a-token", refs[0]), null);
  assert.equal(await findPurchase(store, token, "../etc"), null);
  assert.deepEqual([asked, (await requestsIn(folder, window)) - at], [0, 0]);
});

test("a download with a token shaped like one that opens nothing reads its grant and takes nothing more", async () => {
  const { store, refs, folder, window } = await linkStore();
  const at = await requestsIn(folder, window);
  sent.length = 0;
  assert.equal(await findPurchase(store, "f".repeat(64), refs[0]), null);
  assert.deepEqual([asked, (await requestsIn(folder, window)) - at], [0, 0]);
  assert.equal(sent.filter((command) => command.includes("nl:orders:link:")).length, 1, "the grant, once");
  // Through the route it is the download's one request and nothing more.
  const before = await requestsIn(folder, window);
  const answer = await downloadRoute(new NextRequest(`${ORIGIN}/api/store/download?handle=moss&token=${"e".repeat(64)}&ref=${refs[0]}`));
  assert.deepEqual([answer.status, (await requestsIn(folder, window)) - before, asked], [410, 1, 0]);
});

/** Fills the store's window up to `left` requests from its end. */
async function leave(store: Store, folder: string, window: string, left: number): Promise<void> {
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, String(requestLimitFor(store) - left)]]);
}

test("the download route answers a store with room for the download but not its lookup as too often, and asks Stripe nothing", async () => {
  const { store, refs, token, folder, window } = await linkStore();
  await leave(store, folder, window, 1);
  asked = 0;
  const answer = await downloadRoute(new NextRequest(`${ORIGIN}/api/store/download?handle=moss&token=${token}&ref=${refs[0]}`));
  assert.equal(answer.status, 429);
  assert.equal(await answer.text(), ordersWords(store.language).downloadProblems.tooOften);
  assert.equal(asked, 0);
});

test("the orders route answers a store with room for the form but not the lookup as too many, and reads nothing", async () => {
  const { store, folder, window } = await linkStore();
  await leave(store, folder, window, 1);
  asked = 0;
  sent.length = 0;
  const body = new URLSearchParams({ handle: "moss", email: BUYER });
  const answer = await ordersRoute(new NextRequest(`${ORIGIN}/api/store/orders`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }));
  assert.deepEqual([answer.status, await answer.text(), asked], [429, "Please try again later.", 0]);
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:")), []);
});

test("a link request whose meter is refused after its units says sent, as for an address that bought nothing, and sends nothing", async () => {
  const { store, product, folder, window } = await callStore(true);
  sessions = bookings(product, MAX_LISTED);
  // Room for the units every request takes, none for what this address's bookings take past them.
  await leave(store, folder, window, ORDERS_OPEN_UNITS);
  sent.length = 0;
  assert.equal(await askLink({ store, email: BUYER, ip: "203.0.113.50", origin: ORIGIN }), "sent");
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:")), [], "no link was made");
  assert.equal(mails, 0, "nothing was emailed");
  // The page's words hold for both: a link normally arrives; if it does not, try again later.
  const words = ordersWords("en");
  assert.ok(words.sentBody("Olive Studio").includes("a link is normally on its way") && words.nothingArrived.includes("try again later"));
});

test("a link request says sent whatever happens past its units: the email not sent, the purchases not read", async () => {
  const { store } = await linkStore();
  const ask = (email: string, ip: string) => askLink({ store, email, ip, origin: ORIGIN });
  // An address that bought nothing.
  assert.equal(await ask("nobody@example.com", "198.51.100.1"), "sent");
  // One that bought, with the sender refusing (its figure used, or down): no link arrives, and the answer is the same.
  senderFails = true;
  assert.equal(await ask(BUYER, "198.51.100.2"), "sent");
  assert.ok(mails > 0, "the email was tried");
  senderFails = false;
  // One whose purchases cannot be read from Stripe: the same.
  stripeFails = true;
  assert.equal(await ask(BUYER, "198.51.100.3"), "sent");
  stripeFails = false;
  // And through the route, the page it leads to is the same page.
  stripeFails = true;
  const body = new URLSearchParams({ handle: "moss", email: BUYER });
  const answer = await ordersRoute(new NextRequest(`${ORIGIN}/api/store/orders`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.4" }, body: body.toString() }));
  assert.deepEqual([answer.status, answer.headers.get("location")], [303, `${ORIGIN}/@moss/orders?status=sent`]);
  const route = readFileSync("app/api/store/orders/route.ts", "utf8");
  assert.ok(!route.includes("status=error"));
});

test("a link request answers sent before it reads anything for the address, writes a grant or emails, whether or not it bought; the link still goes after", async () => {
  const { store } = await linkStore();
  const grants = () => sent.filter((command) => command.startsWith("SET nl:orders:link:")).length;
  // What was sent before the answer, by kind: the limits' keys differ by address and IP, and the window's
  // expiry is set by its first request only, whoever made it.
  const shape = () => sent.filter((command) => !command.startsWith("EXPIRE nl:traffic:")).map((command) => command.replace(/[0-9a-f]{32}/g, "#"));
  const atAnswer: string[][] = [];
  const bought = sessions;
  for (const [email, ip, has] of [[BUYER, "192.0.2.1", bought], ["nobody@example.com", "192.0.2.2", []]] as const) {
    // The stand-in Stripe lists whatever is set here, for any address.
    sessions = [...has];
    [asked, mails] = [0, 0];
    sent.length = 0;
    assert.equal(await requestOrdersLink({ store, email, ip, origin: ORIGIN }), "sent", email);
    // At the answer: nothing asked of Stripe or the sender, no grant, the same commands for both; the rest waits for after it.
    assert.deepEqual([asked, mails, grants(), afterTasks.length], [0, 0, 0, 1], email);
    atAnswer.push(shape());
    await afterAnswers();
    assert.ok(asked > 0, "the purchases are read after the answer");
    assert.deepEqual([grants(), mails], has.length ? [1, 1] : [0, 0], email);
  }
  assert.deepEqual(atAnswer[0], atAnswer[1], "the same commands before the answer, whoever asked");
  sessions = bought;
  // Through the route: the page it leads to is answered before Stripe is asked, and the link is sent after it.
  [asked, mails] = [0, 0];
  const body = new URLSearchParams({ handle: "moss", email: BUYER });
  const answer = await ordersRoute(new NextRequest(`${ORIGIN}/api/store/orders`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.3" }, body: body.toString() }));
  assert.deepEqual([answer.status, answer.headers.get("location"), asked, mails], [303, `${ORIGIN}/@moss/orders?status=sent`, 0, 0]);
  await afterAnswers();
  assert.equal(mails, 1, "the link is emailed after the answer");
});

test("a link request reads for ORDERS_LINK_READ_MS at the most, so its grant and email fit in the route's time", () => {
  assert.ok(ORDERS_LINK_READ_MS + REDIS_TIMEOUT_MS + RESEND_TIMEOUT_MS < ORDERS_OPEN_SECONDS * 1000, String(ORDERS_LINK_READ_MS));
  assert.ok(readFileSync("lib/buyer-orders.ts", "utf8").includes("callsFor(store, raw, meter)]), meter, ORDERS_LINK_READ_MS);"));
});

test("the orders page sends nobody to reply to an email unless every email about a purchase answers to the creator", () => {
  // Every email a buyer gets about what they have here, and whether each answers to the creator (replyTo: store.email).
  const senders = ["lib/purchase-email.ts", "lib/gifts.ts", "lib/paypal-sales.ts", "lib/preorders.ts", "lib/group-buy.ts", "lib/api-write.ts", "lib/imports.ts", "lib/buyer-orders.ts"];
  const unanswered = senders.filter((file) => {
    const text = readFileSync(file, "utf8");
    const sends = (text.match(/\bsendEmail\(\{|messages\.push\(\{/g) ?? []).length;
    const answered = (text.match(/replyTo: store\.email/g) ?? []).length;
    return sends > answered;
  });
  // Today a gift's email to whom it is for, a place's, and this link's own do not.
  assert.ok(unanswered.length > 0, "every one answers now: the page may say so again");
  for (const language of LANGUAGE_CODES) {
    const words = ordersWords(language);
    // After a link request, and when the store cannot look purchases up at all (notices.unavailable, cannotLookUp).
    const said = [words.sentBody("Olive Studio"), words.nothingArrived, words.notices.unavailable.body, words.cannotLookUp("Olive Studio")].join(" ");
    assert.doesNotMatch(said, /confirm|bestätigung|bevestiging|conferma|reply|respon|antwo|rispond/i, language);
  }
});
