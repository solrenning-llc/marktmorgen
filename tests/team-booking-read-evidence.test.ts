import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, addProduct, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { slotsForProduct, type CallListing } from "@/lib/calls";
import { activeTeam, readTeams, writeTeam } from "@/lib/team-booking";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const pipeline = redis.pipeline.bind(redis);
const priorFetch = globalThis.fetch, priorKey = process.env.STRIPE_SECRET_KEY;
const owner = "team-read@example.test";
let store: Store, product: CallListing;
let reply: (() => unknown) | null;
let reads: number, writes: number, getters: number;
beforeEach(async () => {
  redis.clear(); reply = null; reads = 0; writes = 0; getters = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_stand_in";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(url.pathname, "/v1/checkout/sessions");
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  }) as typeof fetch;
  await claimHandle(owner, "teamread", "Synthetic team reader", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "A call", "", "120", null);
  assert.ok(made.ok);
  const call = { kind: "weekly", minutes: 60, tz: "UTC", weekly: Array.from({ length: 7 }, () => [[540, 1020]]), noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.test/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
  assert.ok((await setProductCall(owner, made.product.id, call)).ok);
  store = (await storeForEmail(owner))!;
  product = (await readListing(store, made.product.id))! as CallListing;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    writes += commands.filter(c => !["GET", "MGET", "HGET", "HGETALL", "ZRANGEBYSCORE"].includes(String(c[0]))).length;
    if (commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === `nl:callteam:${store.callsId}`) {
      reads++;
      if (reply) return reply() as never;
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
});
afterEach(() => {
  redis.pipeline = pipeline; globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorKey;
});

const failures: Record<string, () => unknown> = {
  missing: () => [], extra: () => [[], []], nullHash: () => [null], scalarHash: () => [""],
  sparseHash: () => [Array(2)], oddHash: () => [[product.id]],
  wrongKey: () => [[123, "{}"]], wrongValue: () => [[product.id, {}]],
  emptyKey: () => [["", "{}"]], duplicateKey: () => [[product.id, "{}", product.id, "{}"]],
  brokenJson: () => [[product.id, "{broken"]],
  accessorEnvelope: () => Object.defineProperty(Array(1), "0", { get() { getters++; return []; } }),
  accessorHash: () => [Object.defineProperty([product.id, "{}"], "1", { get() { getters++; return "{}"; } })],
};
for (const [label, fault] of Object.entries(failures)) {
  test(`unknown team evidence cannot become an ordinary booking: ${label}`, async () => {
    reply = fault;
    await assert.rejects(readTeams(store), /team booking configuration could not be read/);
    assert.equal(reads, 1, "one existing bounded hash read, no retry");
    assert.equal(writes, 0, "the reader has no writes");
    assert.equal(await slotsForProduct(store, product), null);
    assert.equal(getters, 0, "accessors are not executed");
  });
}

for (const raw of [null, {}, [], { mode: "round_robin", hosts: [] }]) {
  test(`an explicitly configured unreadable team closes the call: ${JSON.stringify(raw)}`, async () => {
    reply = () => [[product.id, JSON.stringify(raw)]];
    assert.equal(await activeTeam(store, product), "closed");
    assert.deepEqual(await slotsForProduct(store, product), { days: [], left: {}, paid: [], sessions: [], team: true });
  });
}

test("an exact empty hash remains an ordinary call with bookable times", async () => {
  assert.equal((await readTeams(store)).size, 0);
  assert.equal(await activeTeam(store, product), null);
  const offer = await slotsForProduct(store, product);
  assert.ok(offer?.days.some(day => day.starts.length > 0));
});

test("a valid configured team still follows the unchanged plan policy", async () => {
  await writeTeam(store, product.id, { mode: "round_robin", hosts: [{ email: owner, tz: "UTC", weekly: product.call.weekly, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 }], createdAt: "2026-11-05T00:00:00.000Z" });
  assert.equal((await readTeams(store)).has(product.id), true);
  assert.equal(await activeTeam(store, product), "closed", "this fixture has the existing Store plan, with no team event types");
});

test("a store with no call diary needs no team read", async () => {
  assert.equal((await readTeams({ callsId: null })).size, 0);
  assert.equal(reads, 0);
});
