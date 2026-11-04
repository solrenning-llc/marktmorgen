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
  ORDERS_IMPORTED_COMMANDS,
  ORDERS_IMPORTED_ENTRY_COMMANDS,
  ORDERS_OPEN_SECONDS,
  ORDERS_OPEN_UNITS,
  ORDERS_PREORDER_COMMANDS,
  ORDERS_READ_MS,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
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
import { importedKey } from "@/lib/imported-purchases";
import { WAITING_SHOWN } from "@/lib/buyer-waiting";
import { requestsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import type { CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";

const OWNER = "olive@example.com";
const BUYER = "ana@example.com";
const HOUR = 3_600_000;
let sessions: Record<string, unknown>[] = [];
/** Every call asked of Stripe (or any other service) from here on. */
let asked = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  asked += 1;
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "GET") return answer({ object: "list", data: sessions, has_more: false });
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

test("an opening with forty bookings takes the requests their moves, listing and video rooms cost, each before its read", async () => {
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
  const units = Math.ceil((MAX_LISTED + ORDERS_LISTING_COMMANDS + MAX_LISTED * ORDERS_ROOM_COMMANDS) / ORDERS_UNIT_COMMANDS);
  assert.equal(opened.meter.taken, units);
  assert.equal(await requestsIn(folder, window), ORDERS_OPEN_UNITS + units);
});

test("a store with few bookings pays for few: the moves taken are the bookings read, not five pages of them", async () => {
  const { store, product } = await callStore(true);
  sessions = bookings(product, 2);
  const meter = new OrdersMeter(store);
  assert.equal((await callsFor(store, BUYER, meter)).length, 2);
  assert.equal(meter.taken, Math.ceil((2 + ORDERS_LISTING_COMMANDS + 2 * ORDERS_ROOM_COMMANDS) / ORDERS_UNIT_COMMANDS));
  assert.ok(meter.taken * ORDERS_UNIT_COMMANDS < 500 / 10);
});

test("a meter the store has no room for stops before the listings and rooms of the bookings", async () => {
  const { store, product } = await callStore();
  sessions = bookings(product, MAX_LISTED);
  const refused = { ...store, period: null };
  sent.length = 0;
  await assert.rejects(callsFor(refused, BUYER, new OrdersMeter(refused)), OrdersBusy);
  // The moves are read in lib/calls.ts with the store's pages, before their number is known; nothing after them is.
  const after = (command: string) => /nl:call:room:|nl:catalog:[^ ]*:l:|nl:meet:/.test(command);
  assert.deepEqual(sent.filter(after), []);
  // Read without a meter (the other readers of bookings), the same store reads them all.
  assert.equal((await callsFor(store, BUYER)).length, MAX_LISTED);
  assert.ok(sent.filter(after).length >= MAX_LISTED * 4, String(sent.filter(after).length));
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
    // A guide with a bundle of two inside and a box ticked at checkout: four listings.
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

test("a link request takes ORDERS_OPEN_UNITS after its limits, and its fixed commands are inside an opening's", async () => {
  const { store, folder, window } = await callStore();
  const before = await requestsIn(folder, window);
  sent.length = 0;
  assert.equal(await requestOrdersLink({ store, email: "nobody@example.com", ip: "203.0.113.1", origin: ORIGIN }), "sent");
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS);
  // Its two limits (a write and a count each); nothing bought, so no grant is written.
  const fixed = sent.filter((command) => command.includes("nl:rl:orders:") || command.includes("nl:orders:link:"));
  assert.equal(fixed.length, 4);
  assert.ok(fixed.length + 1 <= ORDERS_OPEN_COMMANDS);
  // It runs no longer than an opening, whose units it takes.
  assert.ok(readFileSync("app/api/store/orders/route.ts", "utf8").includes(`export const maxDuration = ${ORDERS_OPEN_SECONDS};`));
});

test("a link request for forty bookings takes, past its units, what their moves, listing and rooms cost, as an opening does", async () => {
  const { store, product, folder, window } = await callStore(true);
  sessions = bookings(product, MAX_LISTED);
  const before = await requestsIn(folder, window);
  await requestOrdersLink({ store, email: BUYER, ip: "203.0.113.2", origin: ORIGIN });
  const units = Math.ceil((MAX_LISTED + ORDERS_LISTING_COMMANDS + MAX_LISTED * ORDERS_ROOM_COMMANDS) / ORDERS_UNIT_COMMANDS);
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS + units);
});

test("a link request the store has no room for asks Stripe nothing, and the per-address limit still holds", async () => {
  const { store, product, folder, window } = await callStore();
  sessions = bookings(product, 2);
  const refused = { ...store, period: null };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await requestOrdersLink({ store: refused, email: BUYER, ip: `203.0.113.${10 + i}`, origin: ORIGIN }), "busy");
  }
  assert.equal(asked, 0, "nothing was asked of Stripe");
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:") || command.includes("nl:call:")), []);
  // The sixth from the same address is limited before it takes anything, even from a store with room.
  const before = await requestsIn(folder, window);
  assert.equal(await requestOrdersLink({ store, email: BUYER, ip: "203.0.113.99", origin: ORIGIN }), "limited");
  assert.deepEqual([asked, (await requestsIn(folder, window)) - before], [0, 0]);
  // The route answers a refusal as it answers a store with no room at all.
  const route = readFileSync("app/api/store/orders/route.ts", "utf8");
  assert.ok(route.includes('if (result === "busy") return tooMany();') && route.includes("if (!(await takePublicRequest(store, \"buyer\"))) return tooMany();"));
});

test("a download takes ORDERS_OPEN_UNITS before its grant, then its listing; refused, it reads nothing", async () => {
  const OWNER3 = "moss@example.com";
  await claimHandle(OWNER3, "moss", "Moss Notes", "");
  await ensureStatsId(OWNER3);
  await setStripeAccount(OWNER3, "acct_1TestMoss000001", true);
  await setSubscription(OWNER3, { customerId: "cus_moss000001", subscriptionId: "sub_moss000001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER3, "Field notes", "", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER3, made.product.id, "https://example.com/notes");
  const store = (await storeForEmail(OWNER3)) as Store;
  const folder = await storeFolder(OWNER3);
  const window = allowanceWindow(store)!.id;
  const reference = `cs_test_${"m".repeat(24)}`;
  sessions = [{
    id: reference,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000),
    metadata: { store: "moss", product: made.product.id },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_testmoss000001", status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }];
  const token = new URL((await ordersLinkFor(store, BUYER, `${ORIGIN}/@moss`))!).searchParams.get("token")!;
  const before = await requestsIn(folder, window);
  const found = await findPurchase(store, token, reference);
  assert.deepEqual([found?.purchase.reference, found?.email], [reference, BUYER]);
  assert.equal((await requestsIn(folder, window)) - before, ORDERS_OPEN_UNITS + Math.ceil(ORDERS_LISTING_COMMANDS / ORDERS_UNIT_COMMANDS));
  // A store with no room: refused before the grant, and nothing is asked of Stripe.
  asked = 0;
  sent.length = 0;
  await assert.rejects(findPurchase({ ...store, period: null }, token, reference), OrdersBusy);
  assert.equal(asked, 0);
  assert.deepEqual(sent.filter((command) => command.includes("nl:orders:link:") || command.includes(":l:")), []);
  // A token not shaped like one takes nothing and reads nothing.
  const at = await requestsIn(folder, window);
  assert.equal(await findPurchase(store, "not-a-token", reference), null);
  assert.deepEqual([asked, (await requestsIn(folder, window)) - at], [0, 0]);
  // The route answers a refusal with its own "too often".
  const route = readFileSync("app/api/store/download/route.ts", "utf8");
  assert.ok(route.includes("if (error instanceof OrdersBusy) return tooOften();"));
});
