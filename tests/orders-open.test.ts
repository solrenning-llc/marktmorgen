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
  ORDERS_OPEN_UNITS,
  ORDERS_CALL_MOVES,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
  OrdersBusy,
  OrdersMeter,
  callsFor,
  openOrders,
  ordersLinkFor,
} from "@/lib/buyer-orders";
import { WAITING_SHOWN } from "@/lib/buyer-waiting";
import { requestsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import type { CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";

const OWNER = "olive@example.com";
const BUYER = "ana@example.com";
const HOUR = 3_600_000;
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_only_a_stand_in";
});

async function callStore(): Promise<{ store: Store; product: string; folder: string; window: string }> {
  await claimHandle(OWNER, "olive", "Olive Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestOlive00001", true);
  await setSubscription(OWNER, { customerId: "cus_olive00001", subscriptionId: "sub_olive00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "80", null);
  if (!made.ok) throw new Error("no product");
  const weekly = { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: "https://example.com/room", video: false, meet: null };
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

test("an opening with forty bookings takes, before reading them, the requests their moves, listing and rooms cost", async () => {
  const { store, product, folder, window } = await callStore();
  sessions = bookings(product, MAX_LISTED);
  const link = (await ordersLinkFor(store, BUYER, "https://marktmorgen.com/@olive"))!;
  const opened = await openOrders(store, new URL(link).searchParams.get("token")!);
  const calls = await callsFor(store, BUYER, opened.meter);
  assert.equal(calls.length, MAX_LISTED);
  // The move of every booking the store's pages hold (all are read), the product's listing, and each of this buyer's rooms (four reads).
  const commands = ORDERS_CALL_MOVES + ORDERS_LISTING_COMMANDS + MAX_LISTED * ORDERS_ROOM_COMMANDS;
  const units = Math.ceil(commands / ORDERS_UNIT_COMMANDS);
  assert.equal(opened.meter.taken, units);
  assert.equal(await requestsIn(folder, window), ORDERS_OPEN_UNITS + units);
});

test("a meter the store has no room for stops before the read it was asked for", async () => {
  const { store, product } = await callStore();
  sessions = bookings(product, MAX_LISTED);
  const refused = { ...store, period: null };
  sent.length = 0;
  await assert.rejects(callsFor(refused, BUYER, new OrdersMeter(refused)), OrdersBusy);
  // Nothing of the bookings was read: not their moves, their listing or their rooms.
  const bookingReads = (command: string) => /nl:call:|nl:catalog:[^ ]*:l:|nl:meet:/.test(command);
  assert.deepEqual(sent.filter(bookingReads), []);
  // Read without a meter (the other readers of bookings), the same store reads them all: their moves, listing and rooms.
  assert.equal((await callsFor(store, BUYER)).length, MAX_LISTED);
  assert.ok(sent.filter(bookingReads).length >= MAX_LISTED * (1 + ORDERS_ROOM_COMMANDS), String(sent.filter(bookingReads).length));
});

test("the commands every opening makes are inside ORDERS_OPEN_COMMANDS", () => {
  // The grant; what waits, four and one an agreement shown (lib/buyer-waiting.ts); the Discord server and its roles.
  assert.ok(ORDERS_OPEN_COMMANDS >= 1 + 4 + WAITING_SHOWN + 2);
});

test("the moves taken before a store's bookings are read cover every booking its pages can hold", () => {
  // lib/calls.ts reads at most MAX_PAGES pages of a hundred checkouts and every booking's move on them (withMoves).
  const calls = readFileSync("lib/calls.ts", "utf8");
  const pages = Number(/const MAX_PAGES = (\d+);/.exec(calls)?.[1]);
  const perPage = Number(/\/checkout\/sessions\?limit=(\d+)&status=complete/.exec(calls)?.[1]);
  assert.ok(pages > 0 && perPage > 0 && ORDERS_CALL_MOVES >= pages * perPage, `${pages} x ${perPage} > ${ORDERS_CALL_MOVES}`);
});
